/**
 * llm/openai.ts
 * ---------------------------------------------------------------------------
 * Provider #3, the last line of defence: GPT-4o-mini via Chat Completions.
 * https://api.openai.com/v1/chat/completions
 *
 * No openai npm package. The one fiddly bit is tool-call accumulation: OpenAI
 * streams `delta.tool_calls` as an array of partial objects keyed by `index`,
 * with the function name arriving in the first fragment and the arguments
 * dribbling in as a JSON string across many later fragments.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import type {
  CanonMessage,
  CanonToolCall,
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamHooks,
  ProviderTurnResult,
} from '../types.js';
import { toOpenAITools } from './schema.js';
import { stringifyToolResult } from './anthropic.js';
import {
  ProviderError,
  isRetryableStatus,
  readErrorBody,
  readSseFrames,
  safeJsonParse,
  timedFetch,
} from './http.js';

const DEFAULT_BASE = 'https://api.openai.com';

/* ----------------------------------------------------------- wire-format types */

interface OpenAIToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCallPayload[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/* ------------------------------------------------------------------- adapter */

export class OpenAIAdapter implements ProviderAdapter {
  public readonly id = 'openai' as const;
  public readonly model: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(opts: { apiKey: string; model?: string; timeoutMs?: number; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-4o-mini';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.endpoint = `${(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/v1/chat/completions`;
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  public async stream(
    req: ProviderRequest,
    hooks: ProviderStreamHooks,
  ): Promise<ProviderTurnResult> {
    const body = {
      model: this.model,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: toOpenAITools(req.tools),
      tool_choice: req.toolChoice === 'none' ? 'none' : 'auto',
    };

    const res = await timedFetch(this.id, this.endpoint, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      parentSignal: req.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await readErrorBody(res);
      throw new ProviderError(this.id, `HTTP ${res.status}: ${detail}`, {
        retryable: isRetryableStatus(res.status),
        status: res.status,
      });
    }

    return this.consume(res.body, hooks);
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    hooks: ProviderStreamHooks,
  ): Promise<ProviderTurnResult> {
    let text = '';
    let committed = false;
    let finishReason: ProviderTurnResult['finishReason'] = 'unknown';

    /** index -> partially assembled tool call */
    const partials = new Map<number, { id: string; name: string; args: string }>();

    for await (const frame of readSseFrames(body)) {
      if (frame.data === '[DONE]') break;

      const payload = safeJsonParse<Record<string, any>>(frame.data);
      if (!payload) continue;

      if (payload.error) {
        throw new ProviderError(this.id, `stream error: ${payload.error.message ?? 'unknown'}`, {
          retryable: !committed,
        });
      }

      const choice = payload.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!committed) {
          committed = true;
          hooks.onCommit();
        }
        text += delta.content;
        hooks.onTextDelta(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = Number(tc.index ?? 0);
          const entry =
            partials.get(index) ?? { id: `call_${randomUUID()}`, name: '', args: '' };

          if (typeof tc.id === 'string' && tc.id) entry.id = tc.id;
          if (typeof tc.function?.name === 'string' && tc.function.name) {
            entry.name = tc.function.name;
          }
          if (typeof tc.function?.arguments === 'string') {
            entry.args += tc.function.arguments;
          }

          partials.set(index, entry);
        }
      }

      const reason = choice.finish_reason;
      if (reason === 'tool_calls') finishReason = 'tool_use';
      else if (reason === 'stop') finishReason = 'stop';
      else if (reason === 'length') finishReason = 'length';
    }

    const toolCalls: CanonToolCall[] = [...partials.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, e]) => e.name.length > 0)
      .map(([, e]) => ({
        id: e.id,
        name: e.name,
        arguments: safeJsonParse<Record<string, unknown>>(e.args || '{}') ?? {},
      }));

    if (toolCalls.length > 0) finishReason = 'tool_use';
    if (finishReason === 'unknown' && text.length > 0) finishReason = 'stop';

    if (!text && toolCalls.length === 0) {
      throw new ProviderError(this.id, 'empty response stream', { retryable: !committed });
    }

    return { text, toolCalls, finishReason };
  }
}

/* ------------------------------------------------------ canonical -> OpenAI */

export function toOpenAIMessages(system: string, messages: CanonMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const entry: OpenAIMessage = {
        role: 'assistant',
        content: msg.content.trim() ? msg.content : null,
      };
      if (msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.name,
            // OpenAI expects arguments as a JSON *string*, not an object.
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        }));
      }
      out.push(entry);
      continue;
    }

    out.push({
      role: 'tool',
      tool_call_id: msg.toolCallId,
      content: stringifyToolResult(msg.result),
    });
  }

  return out;
}
