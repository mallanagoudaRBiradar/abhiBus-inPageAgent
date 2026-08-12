/**
 * agentClient.js  —  PHASE 4 (LLM path)
 * ---------------------------------------------------------------------------
 * Talks to the gateway and services the re-entrant tool loop.
 *
 *   1. POST /api/chat, keep the response body open
 *   2. decode SSE frames as they arrive
 *   3. on `tool_call`, run the matching AbhiBusAPIRegistry handler in this tab
 *      (session cookies attached) and POST the JSON to /api/tool-result
 *   4. keep draining the same stream until `done`
 *
 * Step 3 is fire-and-forget on purpose. Awaiting it inside the read loop would
 * stop us draining the socket, so heartbeats and any subsequent events would
 * queue up behind a slow AbhiBus call.
 *
 * `EventSource` is not usable here: it is GET-only and cannot send a request
 * body, so the stream is read manually off `fetch().body`.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});

  /* =====================================================================
   * SSE frame decoding (mirror of backend/src/llm/http.ts)
   * =================================================================== */

  function createSseDecoder(onFrame) {
    let buffer = '';
    const decoder = new TextDecoder('utf-8');

    return {
      push(chunk) {
        buffer += decoder.decode(chunk, { stream: true });

        let index;
        while ((index = frameBreak(buffer)) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index).replace(/^(\r?\n){2}/, '');
          const frame = parseFrame(raw);
          if (frame) onFrame(frame);
        }
      },
      flush() {
        const frame = parseFrame(buffer);
        buffer = '';
        if (frame) onFrame(frame);
      },
    };
  }

  function frameBreak(buffer) {
    const lf = buffer.indexOf('\n\n');
    const crlf = buffer.indexOf('\r\n\r\n');
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  }

  function parseFrame(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    let event = '';
    const data = [];

    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith(':')) continue; // keep-alive comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }

    if (!event && data.length === 0) return null;
    return { event, data: data.join('\n') };
  }

  /* =====================================================================
   * Client
   * =================================================================== */

  /**
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {string} opts.message
   * @param {Array<{role:string,content:string}>} [opts.history]
   * @param {object} [opts.pageContext]
   * @param {AbortSignal} [opts.signal]
   * @param {object} opts.on  Event callbacks — all optional.
   * @param {(e:object)=>void} [opts.on.meta]
   * @param {(state:string, detail?:string)=>void} [opts.on.status]
   * @param {(text:string)=>void} [opts.on.text]
   * @param {(name:string, args:object)=>void} [opts.on.toolStart]
   * @param {(name:string, ok:boolean, error?:object, result?:any)=>void} [opts.on.toolEnd]
   * @param {(err:{code:string,message:string,requiresLogin?:boolean})=>void} [opts.on.error]
   * @param {(info:object)=>void} [opts.on.done]
   */
  async function streamChat(opts) {
    const { CONFIG } = NS;
    const base = CONFIG.backendUrl.replace(/\/+$/, '');
    const on = opts.on || {};
    const inFlightTools = [];

    /** Names by tool-call id, so `tool_result_ack` can be labelled. */
    const toolNames = new Map();

    let response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          sessionId: opts.sessionId,
          message: opts.message,
          history: (opts.history || []).slice(-CONFIG.maxHistoryTurns),
          pageContext: opts.pageContext,
        }),
        signal: opts.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      on.error?.({
        code: 'GATEWAY_UNREACHABLE',
        message:
          `Cannot reach the assistant backend at ${base}. ` +
          'Check that it is running and that the URL is set in the extension options.',
      });
      on.done?.({ finishReason: 'error' });
      return;
    }

    if (!response.ok || !response.body) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body?.message) detail = body.message;
      } catch {
        /* non-JSON error body */
      }
      on.error?.({
        code: response.status === 429 ? 'RATE_LIMITED' : 'GATEWAY_ERROR',
        message: detail,
      });
      on.done?.({ finishReason: 'error' });
      return;
    }

    /* ---- dispatch --------------------------------------------------- */

    const handleEvent = (frame) => {
      let payload;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        return;
      }
      const type = frame.event || payload.type;
      NS.log('sse', type, payload);

      switch (type) {
        case 'meta':
          on.meta?.(payload);
          break;

        case 'status':
          on.status?.(payload.state, payload.detail);
          break;

        case 'text_delta':
          on.text?.(payload.text ?? '');
          break;

        case 'tool_call': {
          toolNames.set(payload.toolCallId, payload.name);
          on.toolStart?.(payload.name, payload.arguments || {});
          // Deliberately not awaited — keep draining the socket.
          inFlightTools.push(runTool(base, opts.sessionId, payload, on));
          break;
        }

        case 'tool_result_ack':
          on.toolAck?.(toolNames.get(payload.toolCallId) || '', payload.ok);
          break;

        // A tool the gateway ran itself (city ids, FAQ content). Display-only:
        // there is nothing to execute or POST back.
        case 'server_tool':
          if (payload.state === 'running') {
            on.toolStart?.(payload.name, {});
          } else {
            on.toolEnd?.(
              payload.name,
              payload.state === 'done',
              payload.state === 'failed' ? { code: payload.detail || 'failed' } : undefined,
            );
          }
          break;

        case 'error':
          on.error?.({
            code: payload.code,
            message: payload.message,
            requiresLogin: payload.requiresLogin === true,
          });
          break;

        case 'done':
          on.done?.(payload);
          break;

        default:
          break;
      }
    };

    const decoder = createSseDecoder(handleEvent);
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        decoder.push(value);
      }
      decoder.flush();
    } catch (err) {
      if (err?.name !== 'AbortError') {
        on.error?.({ code: 'STREAM_BROKEN', message: 'The response stream ended unexpectedly.' });
      }
    } finally {
      reader.releaseLock?.();
      // Let any tool POST finish so the backend is not left hanging.
      await Promise.allSettled(inFlightTools);
    }
  }

  /**
   * Execute one tool locally and report the result back to the gateway.
   * Never throws: a failure is reported as a structured error the model can read.
   */
  async function runTool(base, sessionId, call, on) {
    const outcome = await NS.AbhiBusAPIRegistry.execute(call.name, call.arguments || {});

    // The result is passed through so the panel can render rich cards
    // (e.g. the bus list) straight from the data, not from model prose.
    on.toolEnd?.(call.name, outcome.ok, outcome.error, outcome.result);

    // Surface the logged-out state immediately rather than waiting for the
    // backend to round-trip it back as an error event.
    if (!outcome.ok && outcome.error?.code === NS.UNAUTHENTICATED) {
      on.error?.({
        code: NS.UNAUTHENTICATED,
        message: 'Your AbhiBus session has expired.',
        requiresLogin: true,
      });
    }

    const body = outcome.ok
      ? { sessionId, toolCallId: call.toolCallId, result: outcome.result }
      : { sessionId, toolCallId: call.toolCallId, error: outcome.error };

    try {
      await fetch(`${base}/api/tool-result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      NS.log('failed to post tool result', err);
      // The backend's own tool timeout will unblock the loop.
    }
  }

  NS.agentClient = { streamChat };
})();
