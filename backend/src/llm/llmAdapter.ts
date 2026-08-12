/**
 * llm/llmAdapter.ts
 * ---------------------------------------------------------------------------
 * The brain of the gateway. Two responsibilities:
 *
 *   1. FALLBACK WATERFALL  Claude 3.5 Haiku -> Gemini 1.5 Flash -> GPT-4o-mini.
 *      A provider is skipped for the rest of the request once it has failed, so
 *      a flapping upstream cannot burn three timeouts on every loop iteration.
 *
 *   2. RE-ENTRANT TOOL LOOP  When the active model asks for a tool, we emit a
 *      `tool_call` SSE event, park the loop on a promise, and resume when the
 *      extension POSTs the result back to /api/tool-result. The conversation
 *      is stored in the canonical format, so a provider switch *between*
 *      iterations is completely transparent — Gemini can finish a sentence
 *      Claude started thinking about.
 *
 * COMMIT SEMANTICS
 * Once a provider has emitted its first token to the browser the response is
 * "committed": we can no longer fall back, because the user would see the
 * answer restart mid-word. After commit, a failure surfaces as an `error`
 * event instead. This is the one place where honesty beats resilience.
 * ---------------------------------------------------------------------------
 */

import type {
  CanonMessage,
  CanonToolCall,
  ProviderAdapter,
  ProviderId,
  ProviderTurnResult,
  SseEvent,
  ToolDefinition,
  ToolExecutionError,
} from '../types.js';
import { ProviderError, errMessage } from './http.js';

export interface ToolOutcome {
  result?: unknown;
  error?: ToolExecutionError;
}

export interface RunOptions {
  sessionId: string;
  system: string;
  /** Seeded with history + the new user message. Mutated as the loop runs. */
  messages: CanonMessage[];
  tools: ToolDefinition[];
  /** Writes one normalised event to the open SSE response. */
  emit: (event: SseEvent) => void;
  /** Emits `tool_call` and resolves when the extension replies. */
  executeTool: (call: CanonToolCall) => Promise<ToolOutcome>;
  signal: AbortSignal;
  maxToolIterations: number;
  maxTokens: number;
  temperature: number;
}

export interface RunResult {
  finishReason: 'stop' | 'tool_loop_exhausted' | 'error' | 'aborted';
  provider?: ProviderId;
  /** Full assistant text, for the caller's transcript/logging. */
  text: string;
}

export class LLMAdapter {
  private readonly providers: ProviderAdapter[];

  /**
   * @param providers Ordered by preference. Unconfigured ones (no API key) are
   *                  dropped at construction time so the waterfall never wastes
   *                  a hop on a provider that cannot possibly answer.
   */
  constructor(providers: ProviderAdapter[]) {
    this.providers = providers.filter((p) => p.isConfigured());
  }

  public get configuredProviders(): ProviderId[] {
    return this.providers.map((p) => p.id);
  }

  public hasAnyProvider(): boolean {
    return this.providers.length > 0;
  }

  public async run(opts: RunOptions): Promise<RunResult> {
    if (this.providers.length === 0) {
      opts.emit({
        type: 'error',
        code: 'INTERNAL',
        message:
          'No LLM provider is configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY.',
      });
      return { finishReason: 'error', text: '' };
    }

    /** Providers that already failed during THIS request. */
    const burned = new Set<ProviderId>();
    let fullText = '';
    let lastProvider: ProviderId | undefined;

    for (let iteration = 0; iteration < opts.maxToolIterations; iteration++) {
      if (opts.signal.aborted) return { finishReason: 'aborted', text: fullText };

      opts.emit({ type: 'status', state: iteration === 0 ? 'thinking' : 'finalising' });

      let turn: { result: ProviderTurnResult; provider: ProviderId };
      try {
        turn = await this.streamWithFallback(opts, burned);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Quota and overload errors deserve their own explanation —
        // "everything failed" reads like an outage when the real fix is to
        // wait a moment and retry.
        if (/\b(429|503)\b|quota|rate.?limit|overload/i.test(message)) {
          opts.emit({
            type: 'error',
            code: 'RATE_LIMITED',
            message:
              'The AI model is busy or rate-limited right now (free-tier limits). ' +
              'Wait a moment and try again, or upgrade the API key\'s plan.',
          });
        } else {
          opts.emit({
            type: 'error',
            code: 'ALL_PROVIDERS_FAILED',
            message: `Every model provider failed. Last error: ${message}`,
          });
        }
        return { finishReason: 'error', text: fullText, provider: lastProvider };
      }

      lastProvider = turn.provider;
      fullText += turn.result.text;

      console.log(
        `[llm] turn ${iteration + 1}/${opts.maxToolIterations} ${turn.provider}: ` +
          `finish=${turn.result.finishReason} text=${turn.result.text.length}ch ` +
          `tools=[${turn.result.toolCalls.map((c) => c.name).join(', ') || 'none'}]`,
      );
      if (turn.result.finishReason === 'length') {
        console.warn(
          '[llm] response hit the maxTokens ceiling — the answer may be cut off. ' +
            'Raise MAX_TOKENS (thinking models spend part of the budget on reasoning).',
        );
      }

      // Record what the assistant said/asked for, in canonical form.
      opts.messages.push({
        role: 'assistant',
        content: turn.result.text,
        toolCalls: turn.result.toolCalls,
      });

      // No tools requested -> this was the final answer.
      if (turn.result.toolCalls.length === 0) {
        return { finishReason: 'stop', text: fullText, provider: turn.provider };
      }

      // --- Re-entrant step: hand each call to the extension, await results ---
      for (const call of turn.result.toolCalls) {
        if (opts.signal.aborted) return { finishReason: 'aborted', text: fullText };

        opts.emit({
          type: 'status',
          state: 'calling_tool',
          detail: humaniseToolName(call.name),
        });

        const outcome = await opts.executeTool(call);

        // A 401 from abhibus.com ends the turn immediately: no amount of model
        // cleverness fixes a logged-out session, and looping would just burn
        // tokens re-asking for the same tool.
        if (outcome.error?.code === 'UNAUTHENTICATED') {
          opts.emit({
            type: 'error',
            code: 'UNAUTHENTICATED',
            message: 'Your AbhiBus session has expired. Log in to continue.',
            requiresLogin: true,
          });
          return { finishReason: 'error', text: fullText, provider: turn.provider };
        }

        opts.messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          result: outcome.error
            ? { error: outcome.error.code, message: outcome.error.message }
            : outcome.result,
        });
      }
      // Loop back around: the model now sees the tool results.
    }

    /* ---- Forced final answer -------------------------------------------
     * The tool budget is spent but the model never wrote its answer (seen in
     * the wild: a model drilling into seat maps it does not need). Run ONE
     * more turn with tool calling disabled, so the only thing it can do is
     * answer from the results it already has.
     * ------------------------------------------------------------------ */
    console.warn(
      `[llm] tool budget (${opts.maxToolIterations}) exhausted — forcing a final answer turn`,
    );
    opts.emit({ type: 'status', state: 'finalising' });
    opts.messages.push({
      role: 'user',
      content:
        '(system note — the user cannot see this) You have used your tool budget. ' +
        'Answer the original question NOW using only the tool results above. ' +
        'If something is genuinely missing, say what you found and what you could not check.',
    });

    try {
      const finalTurn = await this.streamWithFallback(opts, burned, 'none');
      fullText += finalTurn.result.text;
      console.log(
        `[llm] forced final turn ${finalTurn.provider}: text=${finalTurn.result.text.length}ch`,
      );
      if (finalTurn.result.text.trim()) {
        return { finishReason: 'stop', text: fullText, provider: finalTurn.provider };
      }
    } catch (err) {
      console.warn(`[llm] forced final turn failed: ${errMessage(err)}`);
    }

    opts.emit({
      type: 'error',
      code: 'INTERNAL',
      message: `Stopped after ${opts.maxToolIterations} tool rounds without a final answer.`,
    });
    return { finishReason: 'tool_loop_exhausted', text: fullText, provider: lastProvider };
  }

  /* ------------------------------------------------------------------ */

  /**
   * One model turn, walking the waterfall until a provider succeeds.
   * Throws only when every remaining provider has failed.
   */
  private async streamWithFallback(
    opts: RunOptions,
    burned: Set<ProviderId>,
    toolChoice: 'auto' | 'none' = 'auto',
  ): Promise<{ result: ProviderTurnResult; provider: ProviderId }> {
    const candidates = this.providers.filter((p) => !burned.has(p.id));
    const pool = candidates.length > 0 ? candidates : this.providers;

    let lastError: unknown = new Error('no provider attempted');
    // In-place retries when a transient error (429 quota, 503 overloaded,
    // network blips) hits and there is no other provider to fall to. Free-tier
    // Gemini throws these routinely; a short pause usually clears them.
    let inPlaceRetries = 0;
    const MAX_IN_PLACE_RETRIES = 2;

    for (let i = 0; i < pool.length; i++) {
      const provider = pool[i]!;
      let committed = false;

      opts.emit({
        type: 'meta',
        sessionId: opts.sessionId,
        provider: provider.id,
        model: provider.model,
        attempt: i + 1,
      });

      try {
        const result = await provider.stream(
          {
            system: opts.system,
            messages: opts.messages,
            tools: opts.tools,
            toolChoice,
            maxTokens: opts.maxTokens,
            temperature: opts.temperature,
            signal: opts.signal,
          },
          {
            onTextDelta: (text) => opts.emit({ type: 'text_delta', text }),
            onCommit: () => {
              committed = true;
            },
          },
        );

        return { result, provider: provider.id };
      } catch (err) {
        lastError = err;
        burned.add(provider.id);

        const retryable = err instanceof ProviderError ? err.retryable : true;
        const isLast = i === pool.length - 1;

        console.warn(
          `[llm] ${provider.id} failed (retryable=${retryable}, committed=${committed}): ${errMessage(err)}`,
        );

        // Cannot rewind bytes already on the wire.
        if (committed) throw err;

        // Transient failure with nowhere to fall (single-provider setups):
        // pause and retry the same provider rather than failing the request.
        const status = err instanceof ProviderError ? err.status : undefined;
        if (retryable && isLast && inPlaceRetries < MAX_IN_PLACE_RETRIES) {
          inPlaceRetries++;
          burned.delete(provider.id);
          // Honour the provider's own hint ("Please retry in 12.7s") when it
          // gives one — a flat 5s wait undershoots per-minute quota windows.
          const hintedMs = parseRetryAfterMs(errMessage(err));
          const delayMs =
            hintedMs !== null
              ? Math.min(hintedMs + 500, 25_000)
              : status === 429
                ? 5000
                : 2000 * inPlaceRetries;
          console.warn(
            `[llm] ${provider.id} ${status ?? 'network'} — in-place retry ` +
              `${inPlaceRetries}/${MAX_IN_PLACE_RETRIES} after ${delayMs}ms`,
          );
          opts.emit({ type: 'status', state: 'thinking', detail: 'Model busy, retrying…' });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (opts.signal.aborted) throw err;
          i--;
          continue;
        }

        if (!retryable || isLast) throw err;

        const next = pool[i + 1]!;
        opts.emit({
          type: 'status',
          state: 'switching_provider',
          detail: `Switching to ${next.model}`,
        });
      }
    }

    throw lastError;
  }
}

/** Extract "Please retry in 12.75s" style hints from a provider error. */
function parseRetryAfterMs(message: string): number | null {
  const match = message.match(/retry in ([\d.]+)\s*s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

/** "getAbhiCashBalance" -> "Checking AbhiCash balance" style status text. */
function humaniseToolName(name: string): string {
  const map: Record<string, string> = {
    getAbhiCashBalance: 'Checking your AbhiCash balance',
    getWalletHistory: 'Reading your wallet history',
    searchBuses: 'Searching buses',
    getSeatLayout: 'Loading the seat map',
    getSeatLayoutOffers: 'Looking up offers',
    getSavedPassengers: 'Fetching saved passengers',
    getUserProfile: 'Reading your profile',
    getBookings: 'Fetching your bookings',
    getFailedTrips: 'Checking failed bookings',
    resolveCityIds: 'Resolving city codes',
    getHelpContent: 'Reading AbhiBus help articles',
  };
  return map[name] ?? `Running ${name}`;
}
