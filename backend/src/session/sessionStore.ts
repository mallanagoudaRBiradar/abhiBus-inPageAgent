/**
 * session/sessionStore.ts
 * ---------------------------------------------------------------------------
 * Holds the promises that make the tool loop re-entrant.
 *
 * When the orchestrator emits a `tool_call` it parks on a promise registered
 * here. The (separate) POST /api/tool-result request looks the promise up by
 * (sessionId, toolCallId) and resolves it, which unblocks the still-open SSE
 * response. That is the entire trick.
 *
 * This is intentionally process-local. For multiple instances behind a load
 * balancer you would either pin SSE connections with sticky sessions or move
 * this map into Redis with a pub/sub channel — see README "Scaling".
 * ---------------------------------------------------------------------------
 */

import type { ToolOutcome } from '../llm/llmAdapter.js';

interface PendingCall {
  sessionId: string;
  resolve: (outcome: ToolOutcome) => void;
  timer: NodeJS.Timeout;
}

export class SessionStore {
  /** toolCallId -> pending deferred */
  private readonly pending = new Map<string, PendingCall>();
  /** sessionId -> set of its in-flight toolCallIds, for bulk cleanup. */
  private readonly bySession = new Map<string, Set<string>>();

  /**
   * Register a tool call and return a promise that settles when the extension
   * answers, or when `timeoutMs` elapses.
   */
  public awaitToolResult(
    sessionId: string,
    toolCallId: string,
    timeoutMs: number,
  ): Promise<ToolOutcome> {
    return new Promise<ToolOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.forget(sessionId, toolCallId);
        resolve({
          error: {
            code: 'TIMEOUT',
            message: `The browser did not return a result for this action within ${Math.round(
              timeoutMs / 1000,
            )}s.`,
          },
        });
      }, timeoutMs);

      // Do not hold the event loop open purely for a pending tool call.
      timer.unref?.();

      this.pending.set(toolCallId, { sessionId, resolve, timer });

      let ids = this.bySession.get(sessionId);
      if (!ids) {
        ids = new Set<string>();
        this.bySession.set(sessionId, ids);
      }
      ids.add(toolCallId);
    });
  }

  /**
   * Settle a pending call. Returns false when the id is unknown — which happens
   * on a duplicate POST or after a timeout, and should be answered with 409
   * rather than treated as a server error.
   */
  public settle(sessionId: string, toolCallId: string, outcome: ToolOutcome): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry || entry.sessionId !== sessionId) return false;

    clearTimeout(entry.timer);
    this.forget(sessionId, toolCallId);
    entry.resolve(outcome);
    return true;
  }

  /** Fail every outstanding call for a session, e.g. when the SSE socket drops. */
  public abandonSession(sessionId: string, reason = 'Client disconnected'): void {
    const ids = this.bySession.get(sessionId);
    if (!ids) return;

    for (const id of [...ids]) {
      const entry = this.pending.get(id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ error: { code: 'UNKNOWN', message: reason } });
    }
    this.bySession.delete(sessionId);
  }

  public get size(): number {
    return this.pending.size;
  }

  private forget(sessionId: string, toolCallId: string): void {
    this.pending.delete(toolCallId);
    const ids = this.bySession.get(sessionId);
    if (!ids) return;
    ids.delete(toolCallId);
    if (ids.size === 0) this.bySession.delete(sessionId);
  }
}

/** Single shared instance for the process. */
export const sessionStore = new SessionStore();
