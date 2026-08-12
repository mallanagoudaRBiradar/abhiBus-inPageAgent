/**
 * dev/smokeLoop.ts
 * ---------------------------------------------------------------------------
 * Offline verification of the two things that are hard to eyeball:
 *   1. the provider waterfall actually walks past a failing provider
 *   2. the re-entrant tool loop feeds results back and produces a final answer
 *
 * Uses fake adapters, so it needs no API keys and no network.
 *
 *   npm run smoke
 * ---------------------------------------------------------------------------
 */

import { LLMAdapter } from '../llm/llmAdapter.js';
import { ProviderError } from '../llm/http.js';
import { TOOL_DEFINITIONS } from '../tools.js';
import type {
  CanonMessage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderStreamHooks,
  ProviderTurnResult,
  SseEvent,
} from '../types.js';

/** Always fails with a retryable 503 — stands in for an overloaded provider. */
class AlwaysFailingProvider implements ProviderAdapter {
  constructor(
    public readonly id: ProviderId,
    public readonly model: string,
  ) {}
  isConfigured(): boolean {
    return true;
  }
  async stream(): Promise<ProviderTurnResult> {
    throw new ProviderError(this.id, 'HTTP 503: overloaded', { retryable: true, status: 503 });
  }
}

/**
 * Asks for `getBookings` on the first turn, then answers using whatever the
 * tool returned. Streams its text one word at a time like a real provider.
 */
class ScriptedProvider implements ProviderAdapter {
  private turn = 0;
  constructor(
    public readonly id: ProviderId,
    public readonly model: string,
  ) {}
  isConfigured(): boolean {
    return true;
  }

  async stream(req: ProviderRequest, hooks: ProviderStreamHooks): Promise<ProviderTurnResult> {
    this.turn++;

    if (this.turn === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'getBookings', arguments: { bookType: 'Mobile' } }],
        finishReason: 'tool_use',
      };
    }

    const toolMsg = req.messages.find(
      (m): m is Extract<CanonMessage, { role: 'tool' }> => m.role === 'tool',
    );
    const pnr =
      (toolMsg?.result as { bookings?: Array<{ pnr?: string }> } | undefined)?.bookings?.[0]?.pnr ??
      'UNKNOWN';

    const words = `Your next trip is PNR ${pnr}, departing 21:45.`.split(' ');
    let text = '';
    for (const [i, word] of words.entries()) {
      const chunk = i === 0 ? word : ` ${word}`;
      if (i === 0) hooks.onCommit();
      hooks.onTextDelta(chunk);
      text += chunk;
    }
    return { text, toolCalls: [], finishReason: 'stop' };
  }
}

async function main(): Promise<void> {
  const events: SseEvent[] = [];
  const emit = (e: SseEvent): void => {
    events.push(e);
    const detail =
      e.type === 'text_delta'
        ? JSON.stringify(e.text)
        : e.type === 'meta'
          ? `${e.provider}/${e.model} attempt=${e.attempt}`
          : e.type === 'tool_call'
            ? `${e.name}(${JSON.stringify(e.arguments)})`
            : e.type === 'status'
              ? e.state
              : JSON.stringify(e);
    console.log(`  ${e.type.padEnd(16)} ${detail}`);
  };

  const llm = new LLMAdapter([
    new AlwaysFailingProvider('anthropic', 'claude-3-5-haiku-latest'),
    new ScriptedProvider('gemini', 'gemini-1.5-flash'),
    new ScriptedProvider('openai', 'gpt-4o-mini'),
  ]);

  console.log('\nRunning waterfall + tool loop with a dead primary provider:\n');

  const messages: CanonMessage[] = [{ role: 'user', content: 'when is my next bus?' }];

  const result = await llm.run({
    sessionId: 'smoke',
    system: 'test',
    messages,
    tools: TOOL_DEFINITIONS,
    emit,
    signal: new AbortController().signal,
    maxToolIterations: 4,
    maxTokens: 256,
    temperature: 0,
    executeTool: async (call) => {
      console.log(`  ${'[browser]'.padEnd(16)} executing ${call.name}`);
      return { result: { bookings: [{ pnr: 'AB1234567', departure: '21:45' }] } };
    },
  });

  const text = events
    .filter((e): e is Extract<SseEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');

  console.log('\nFinal answer :', text);
  console.log('Finish reason:', result.finishReason);
  console.log('Served by    :', result.provider);

  const ok =
    result.finishReason === 'stop' &&
    result.provider === 'gemini' &&
    text.includes('AB1234567');

  console.log(ok ? '\nPASS\n' : '\nFAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
