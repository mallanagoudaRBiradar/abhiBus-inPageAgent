/**
 * llm/anthropic.ts
 * ---------------------------------------------------------------------------
 * Provider #1 in the waterfall: Claude 3.5 Haiku via the raw Messages API.
 * https://api.anthropic.com/v1/messages
 *
 * No @anthropic-ai/sdk. Just fetch + the shared SSE reader.
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
import { toAnthropicTools } from './schema.js';
import {
  ProviderError,
  isRetryableStatus,
  readErrorBody,
  readSseFrames,
  safeJsonParse,
  timedFetch,
} from './http.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/* ----------------------------------------------------------- wire-format types */

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

/* ------------------------------------------------------------------- adapter */

export class AnthropicAdapter implements ProviderAdapter {
  public readonly id = 'anthropic' as const;
  public readonly model: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(opts: { apiKey: string; model?: string; timeoutMs?: number; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'claude-3-5-haiku-latest';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.endpoint = `${(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/v1/messages`;
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
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools),
      ...(req.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}),
      stream: true,
    };

    const res = await timedFetch(this.id, this.endpoint, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      parentSignal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
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

  /** Decode the Anthropic event stream into a normalised turn result. */
  private async consume(
    body: ReadableStream<Uint8Array>,
    hooks: ProviderStreamHooks,
  ): Promise<ProviderTurnResult> {
    let text = '';
    let finishReason: ProviderTurnResult['finishReason'] = 'unknown';
    let committed = false;

    /**
     * tool_use arguments arrive as a stream of `input_json_delta` fragments
     * keyed by content-block index, so we accumulate raw JSON text per index
     * and parse once the block closes.
     */
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();
    const toolCalls: CanonToolCall[] = [];

    for await (const frame of readSseFrames(body)) {
      const payload = safeJsonParse<Record<string, any>>(frame.data);
      if (!payload) continue;

      const eventType = frame.event || String(payload.type ?? '');

      switch (eventType) {
        case 'content_block_start': {
          const block = payload.content_block;
          if (block?.type === 'tool_use') {
            pendingTools.set(Number(payload.index), {
              id: String(block.id ?? `toolu_${randomUUID()}`),
              name: String(block.name ?? ''),
              json: '',
            });
          }
          break;
        }

        case 'content_block_delta': {
          const delta = payload.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            if (!committed) {
              committed = true;
              hooks.onCommit();
            }
            text += delta.text;
            hooks.onTextDelta(delta.text);
          } else if (delta?.type === 'input_json_delta') {
            const entry = pendingTools.get(Number(payload.index));
            if (entry) entry.json += String(delta.partial_json ?? '');
          }
          break;
        }

        case 'content_block_stop': {
          const entry = pendingTools.get(Number(payload.index));
          if (entry) {
            pendingTools.delete(Number(payload.index));
            toolCalls.push({
              id: entry.id,
              name: entry.name,
              // An empty-argument tool streams no deltas at all.
              arguments: safeJsonParse<Record<string, unknown>>(entry.json || '{}') ?? {},
            });
          }
          break;
        }

        case 'message_delta': {
          const stop = payload.delta?.stop_reason;
          if (stop === 'tool_use') finishReason = 'tool_use';
          else if (stop === 'end_turn' || stop === 'stop_sequence') finishReason = 'stop';
          else if (stop === 'max_tokens') finishReason = 'length';
          break;
        }

        case 'error': {
          const msg = payload.error?.message ?? 'stream error';
          // Overloaded / rate-limit style errors are worth falling back on.
          const type = String(payload.error?.type ?? '');
          throw new ProviderError(this.id, `stream error (${type}): ${msg}`, {
            retryable: !committed,
          });
        }

        case 'message_stop':
        case 'ping':
        case 'message_start':
        default:
          break;
      }
    }

    if (finishReason === 'unknown' && toolCalls.length > 0) finishReason = 'tool_use';
    if (finishReason === 'unknown' && text.length > 0) finishReason = 'stop';

    return { text, toolCalls, finishReason };
  }
}

/* --------------------------------------------------- canonical -> Anthropic */

/**
 * Anthropic requires tool results to arrive as `tool_result` blocks inside a
 * *user* message, and requires strict user/assistant alternation. Consecutive
 * canonical tool messages are therefore merged into a single user turn.
 */
export function toAnthropicMessages(messages: CanonMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (msg.content.trim()) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      // An entirely empty assistant turn is invalid; skip it.
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // role === 'tool'
    const block: AnthropicToolResultBlock = {
      type: 'tool_result',
      tool_use_id: msg.toolCallId,
      content: stringifyToolResult(msg.result),
      is_error: isErrorEnvelope(msg.result),
    };

    const last = out[out.length - 1];
    if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }

  return out;
}

export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 60_000);
  try {
    return JSON.stringify(result ?? null).slice(0, 60_000);
  } catch {
    return '"<unserialisable tool result>"';
  }
}

export function isErrorEnvelope(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in (result as Record<string, unknown>)
  );
}
