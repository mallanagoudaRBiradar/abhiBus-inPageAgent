/**
 * llm/gemini.ts
 * ---------------------------------------------------------------------------
 * Provider #2 in the waterfall: Gemini 1.5 Flash via the REST API.
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
 *
 * No @google/genai. Two quirks worth knowing:
 *   - `alt=sse` is required, otherwise the endpoint returns a single JSON array
 *     instead of an event stream.
 *   - functionCall parts carry no id, so we mint one and remember the mapping
 *     for the functionResponse turn (Gemini matches on `name`, not id).
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
import { toGeminiTools } from './schema.js';
import {
  ProviderError,
  isRetryableStatus,
  readErrorBody,
  readSseFrames,
  safeJsonParse,
  timedFetch,
} from './http.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

/* ----------------------------------------------------------- wire-format types */

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** Gemini 3+ reasoning signature. Must be echoed back with the part. */
  thoughtSignature?: string;
}

/**
 * Gemini 3+ validates that every functionCall part in the history carries a
 * thoughtSignature and 400s otherwise. For calls that were NOT produced by
 * Gemini (our waterfall can replay a turn Claude started), Google documents
 * this exact placeholder as the way to skip validation.
 * https://ai.google.dev/gemini-api/docs/thought-signatures
 */
const SIGNATURE_BYPASS = 'context_engineering_is_the_way_to_go';

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/* ------------------------------------------------------------------- adapter */

export class GeminiAdapter implements ProviderAdapter {
  public readonly id = 'gemini' as const;
  public readonly model: string;

  /** All usable keys. Free-tier quotas are per key (per Google project), so
   *  when one key is exhausted or the model shard it hits is overloaded, the
   *  next key usually still works. */
  private readonly apiKeys: string[];
  /** Index of the key that last succeeded — start there next time. */
  private cursor = 0;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: {
    apiKey?: string;
    apiKeys?: string[];
    model?: string;
    timeoutMs?: number;
    baseUrl?: string;
  }) {
    this.apiKeys = [...new Set([opts.apiKey ?? '', ...(opts.apiKeys ?? [])])].filter(Boolean);
    this.model = opts.model ?? 'gemini-1.5-flash';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return this.apiKeys.length > 0;
  }

  public get keyCount(): number {
    return this.apiKeys.length;
  }

  /**
   * One model turn, rotating through the key pool. A key is rotated past on
   * quota/overload/auth failures; rotation stops the moment any content has
   * been streamed to the browser (cannot restart a half-delivered answer).
   */
  public async stream(
    req: ProviderRequest,
    hooks: ProviderStreamHooks,
  ): Promise<ProviderTurnResult> {
    const total = this.apiKeys.length;
    let lastError: unknown = new ProviderError(this.id, 'no API key configured', {
      retryable: false,
    });
    // Keys created in the same Google project share ONE quota bucket, and
    // every rotation attempt is itself a counted request. Two consecutive
    // 429s mean the bucket is shared (or everything is drained) — stop
    // rotating and let the caller wait out the window instead.
    let quotaErrors = 0;

    for (let attempt = 0; attempt < total; attempt++) {
      const index = (this.cursor + attempt) % total;
      let committed = false;
      const wrappedHooks: ProviderStreamHooks = {
        onTextDelta: (text) => hooks.onTextDelta(text),
        onCommit: () => {
          committed = true;
          hooks.onCommit();
        },
      };

      try {
        const result = await this.streamWithKey(this.apiKeys[index]!, req, wrappedHooks);
        this.cursor = index;
        return result;
      } catch (err) {
        lastError = err;
        const status = err instanceof ProviderError ? err.status : undefined;
        if (status === 429) quotaErrors++;
        // 400s are request-shape problems — identical for every key.
        const keySpecific = status === undefined || status !== 400;
        const isLastKey = attempt === total - 1;
        if (committed || !keySpecific || isLastKey || quotaErrors >= 2) throw err;
        console.warn(
          `[gemini] key ${index + 1}/${total} failed (${status ?? 'network'}) — rotating to next key`,
        );
      }
    }

    throw lastError;
  }

  private async streamWithKey(
    apiKey: string,
    req: ProviderRequest,
    hooks: ProviderStreamHooks,
  ): Promise<ProviderTurnResult> {
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}` +
      ':streamGenerateContent?alt=sse';

    const body: Record<string, unknown> = {
      systemInstruction: { role: 'user', parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig: {
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
      },
    };

    // The forced final-answer turn omits tools entirely: gemini-3.5-flash
    // hangs (observed: indefinite, until our timeout) when tools are declared
    // with functionCallingConfig mode NONE. With no tools in the request the
    // model can only answer in text.
    if (req.toolChoice !== 'none') {
      body.tools = toGeminiTools(req.tools);
      // AUTO lets the model answer directly when no tool is needed.
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const res = await timedFetch(this.id, url, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      parentSignal: req.signal,
      headers: {
        'content-type': 'application/json',
        // Header auth avoids leaking the key into proxy access logs.
        'x-goog-api-key': apiKey,
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
    const toolCalls: CanonToolCall[] = [];

    for await (const frame of readSseFrames(body)) {
      if (frame.data === '[DONE]') break;

      const payload = safeJsonParse<Record<string, any>>(frame.data);
      if (!payload) continue;

      // Gemini reports API-level problems inside the stream body too.
      if (payload.error) {
        const status = Number(payload.error.code ?? 500);
        throw new ProviderError(
          this.id,
          `stream error ${status}: ${payload.error.message ?? 'unknown'}`,
          { retryable: !committed && isRetryableStatus(status), status },
        );
      }

      const candidate = payload.candidates?.[0];
      if (!candidate) continue;

      for (const part of (candidate.content?.parts ?? []) as GeminiPart[]) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (!committed) {
            committed = true;
            hooks.onCommit();
          }
          text += part.text;
          hooks.onTextDelta(part.text);
        }

        if (part.functionCall?.name) {
          toolCalls.push({
            // Gemini supplies no call id — mint a stable one for our own loop.
            id: `gem_${randomUUID()}`,
            name: part.functionCall.name,
            arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            // Preserve the reasoning signature: Gemini 3+ rejects the next
            // request if this call is replayed without it.
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          });
        }
      }

      const reason = candidate.finishReason;
      if (reason === 'STOP') finishReason = 'stop';
      else if (reason === 'MAX_TOKENS') finishReason = 'length';
      else if (typeof reason === 'string' && reason.length > 0) {
        // SAFETY / RECITATION / OTHER — treat as a hard stop, not a fallback,
        // since re-asking a different model rarely helps and costs latency.
        finishReason = 'stop';
      }
    }

    if (toolCalls.length > 0) finishReason = 'tool_use';
    if (finishReason === 'unknown' && text.length > 0) finishReason = 'stop';

    // An empty stream means something upstream went wrong silently.
    if (!text && toolCalls.length === 0) {
      throw new ProviderError(this.id, 'empty response stream', { retryable: !committed });
    }

    return { text, toolCalls, finishReason };
  }
}

/* ------------------------------------------------------ canonical -> Gemini */

/**
 * Gemini has no dedicated "tool" role: function results are sent as a user turn
 * containing `functionResponse` parts. Consecutive tool results are merged so
 * that user/model alternation is preserved.
 */
export function toGeminiContents(messages: CanonMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.content.trim()) parts.push({ text: msg.content });
      for (const call of msg.toolCalls) {
        parts.push({
          functionCall: { name: call.name, args: call.arguments },
          // Echo the model's own signature; use the documented bypass for
          // calls another provider made (or pre-signature history).
          thoughtSignature: call.thoughtSignature ?? SIGNATURE_BYPASS,
        });
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }

    // role === 'tool' — response must always be a JSON object.
    const part: GeminiPart = {
      functionResponse: {
        name: msg.name,
        response: wrapAsObject(msg.result),
      },
    };

    const last = out[out.length - 1];
    if (last && last.role === 'user' && last.parts.every((p) => p.functionResponse)) {
      last.parts.push(part);
    } else {
      out.push({ role: 'user', parts: [part] });
    }
  }

  return out;
}

function wrapAsObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value ?? null };
}
