/**
 * routes/chat.ts
 * ---------------------------------------------------------------------------
 * Two endpoints, one conversation:
 *
 *   POST /api/chat         opens an SSE stream and runs the agent loop
 *   POST /api/tool-result  the extension answering a `tool_call` event
 *
 * They are deliberately separate requests. A content script cannot stream a
 * request body upward, so the "reply" leg has to be its own POST; the SSE
 * connection stays open the whole time and is resumed by the session store.
 * ---------------------------------------------------------------------------
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';

import type {
  CanonMessage,
  ChatRequestBody,
  SseEvent,
  ToolResultBody,
} from '../types.js';
import { LLMAdapter } from '../llm/llmAdapter.js';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tools.js';
import { buildSystemPrompt } from '../prompt.js';
import { sessionStore } from '../session/sessionStore.js';
import { isServerTool, runServerTool } from '../serverTools.js';
import { CONFIG } from '../config.js';

export function createChatRouter(llm: LLMAdapter): Router {
  const router = Router();

  /* ===================================================================
   * POST /api/chat
   * =================================================================== */
  router.post('/chat', async (req: Request, res: Response) => {
    const body = req.body as Partial<ChatRequestBody> | undefined;

    /* ---- validation ------------------------------------------------ */
    const sessionId =
      typeof body?.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim().slice(0, 100)
        : randomUUID();

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'message is required' });
      return;
    }
    if (message.length > CONFIG.maxMessageChars) {
      res.status(413).json({
        ok: false,
        code: 'MESSAGE_TOO_LONG',
        message: `message exceeds ${CONFIG.maxMessageChars} characters`,
      });
      return;
    }

    /* ---- open the SSE stream --------------------------------------- */
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Stops nginx buffering the stream into uselessness.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const emit = (event: SseEvent): void => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Comment frames keep proxies and the browser from dropping an idle stream
    // while the model is thinking or a tool is running.
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': keep-alive\n\n');
    }, CONFIG.heartbeatMs);
    heartbeat.unref?.();

    const abort = new AbortController();
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      abort.abort();
      sessionStore.abandonSession(sessionId);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);

    /* ---- seed the canonical conversation --------------------------- */
    const messages: CanonMessage[] = [];
    const history = Array.isArray(body?.history) ? body!.history! : [];
    for (const turn of history.slice(-CONFIG.maxHistoryTurns)) {
      if (typeof turn?.content !== 'string' || !turn.content.trim()) continue;
      if (turn.role === 'user') {
        messages.push({ role: 'user', content: turn.content.slice(0, CONFIG.maxMessageChars) });
      } else if (turn.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: turn.content.slice(0, CONFIG.maxMessageChars),
          toolCalls: [],
        });
      }
    }
    messages.push({ role: 'user', content: message });

    const startedAt = Date.now();
    console.log(`[chat] ${sessionId.slice(0, 12)} "${message.slice(0, 100)}"`);
    emit({ type: 'status', state: 'connecting' });

    /* ---- run the agent --------------------------------------------- */
    try {
      const result = await llm.run({
        sessionId,
        system: buildSystemPrompt(body?.pageContext),
        messages,
        tools: TOOL_DEFINITIONS,
        emit,
        signal: abort.signal,
        maxToolIterations: CONFIG.maxToolIterations,
        maxTokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,

        // The re-entrant hop: emit, park, resume.
        executeTool: async (call) => {
          if (!TOOL_NAMES.has(call.name)) {
            return {
              error: {
                code: 'UNKNOWN_TOOL',
                message: `No such tool: ${call.name}`,
              },
            };
          }

          const argsPreview = JSON.stringify(call.arguments ?? {}).slice(0, 200);

          // Server-side tools (city ids, FAQ content) never leave the gateway:
          // answer inline and emit a display-only event for the activity chip.
          if (isServerTool(call.name)) {
            emit({ type: 'server_tool', name: call.name, state: 'running' });
            const outcome = await runServerTool(call.name, call.arguments);
            console.log(
              `[tool] ${call.name} (server) ${outcome.error ? `FAILED ${outcome.error.code}` : 'ok'} args=${argsPreview}`,
            );
            emit({
              type: 'server_tool',
              name: call.name,
              state: outcome.error ? 'failed' : 'done',
              ...(outcome.error ? { detail: outcome.error.code } : {}),
            });
            return outcome;
          }

          emit({
            type: 'tool_call',
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
            timeoutMs: CONFIG.toolTimeoutMs,
          });
          emit({ type: 'status', state: 'awaiting_tool_result' });

          const toolStartedAt = Date.now();
          const outcome = await sessionStore.awaitToolResult(
            sessionId,
            call.id,
            CONFIG.toolTimeoutMs,
          );
          console.log(
            `[tool] ${call.name} (browser) ${outcome.error ? `FAILED ${outcome.error.code}` : 'ok'} ` +
              `${Date.now() - toolStartedAt}ms args=${argsPreview}`,
          );

          emit({
            type: 'tool_result_ack',
            toolCallId: call.id,
            ok: outcome.error === undefined,
          });

          return outcome;
        },
      });

      console.log(
        `[chat] ${sessionId.slice(0, 12)} done: ${result.finishReason} via ${result.provider ?? '-'} ` +
          `in ${Date.now() - startedAt}ms`,
      );
      emit({
        type: 'done',
        finishReason: result.finishReason,
        provider: result.provider,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (err) {
      console.error('[chat] unhandled error', err);
      emit({
        type: 'error',
        code: 'INTERNAL',
        message: 'The assistant hit an unexpected error. Try again.',
      });
      emit({ type: 'done', finishReason: 'error', elapsedMs: Date.now() - startedAt });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
      closed = true;
    }
  });

  /* ===================================================================
   * POST /api/tool-result
   * =================================================================== */
  router.post('/tool-result', (req: Request, res: Response) => {
    const body = req.body as Partial<ToolResultBody> | undefined;

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const toolCallId = typeof body?.toolCallId === 'string' ? body.toolCallId : '';

    if (!sessionId || !toolCallId) {
      res.status(400).json({
        ok: false,
        code: 'BAD_REQUEST',
        message: 'sessionId and toolCallId are required',
      });
      return;
    }

    const settled = sessionStore.settle(sessionId, toolCallId, {
      result: body?.result,
      error: body?.error,
    });

    if (!settled) {
      // Already timed out, already answered, or the stream is gone.
      res.status(409).json({
        ok: false,
        code: 'NO_PENDING_CALL',
        message: 'That tool call is no longer waiting for a result.',
      });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}
