/**
 * llm/http.ts
 * ---------------------------------------------------------------------------
 * Low-level plumbing shared by all three provider adapters.
 *
 * No SDKs are used anywhere in this project — every provider is spoken to with
 * the global `fetch` shipped in Node 20+, and every stream is decoded by the
 * generic SSE reader below.
 * ---------------------------------------------------------------------------
 */

/** Thrown by an adapter when the orchestrator should try the next provider. */
export class ProviderError extends Error {
  public readonly retryable: boolean;
  public readonly status: number | undefined;
  public readonly provider: string;

  constructor(
    provider: string,
    message: string,
    opts: { retryable: boolean; status?: number; cause?: unknown } = { retryable: true },
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = opts.retryable;
    this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Decide whether a failed HTTP call is worth falling back over.
 *
 * Falls back on: 408, 409, 429, and every 5xx — plus all network/abort errors.
 * Does NOT fall back on 400/401/403/404, because a malformed request or a bad
 * API key will fail identically on the next provider and the wasted round trip
 * just delays the error the operator actually needs to see.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export interface TimedFetchOptions extends RequestInit {
  /** Hard ceiling for the whole request, including time-to-first-byte. */
  timeoutMs: number;
  /** Caller-owned abort signal (client disconnect). Linked to the timeout. */
  parentSignal?: AbortSignal;
}

/**
 * `fetch` with a timeout that is also cancelled by a parent signal.
 * Returns the Response; the caller is responsible for reading the body.
 */
export async function timedFetch(
  provider: string,
  url: string,
  { timeoutMs, parentSignal, ...init }: TimedFetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(new Error('client disconnected'));

  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(new Error('client disconnected'));
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = parentSignal?.aborted === true;
    throw new ProviderError(
      provider,
      aborted ? 'request cancelled by client' : `network failure: ${errMessage(err)}`,
      // A client disconnect must not cascade through the whole waterfall.
      { retryable: !aborted, cause: err },
    );
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/** Read an error body defensively — providers are inconsistent about content type. */
export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 600);
  } catch {
    return '<unreadable body>';
  }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* =========================================================================
 * Generic SSE reader
 * ========================================================================= */

export interface SseFrame {
  /** The `event:` field, or '' when the provider omits it (OpenAI, Gemini). */
  event: string;
  /** The concatenated `data:` payload for this frame. */
  data: string;
}

/**
 * Turn a `ReadableStream<Uint8Array>` of `text/event-stream` bytes into frames.
 *
 * Handles the two things naive implementations get wrong:
 *   1. A frame can be split across chunk boundaries mid-line.
 *   2. A frame can carry multiple `data:` lines that must be joined with \n.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Normalise CRLF first.
      let sep: number;
      // eslint-disable-next-line no-cond-assign
      while ((sep = indexOfFrameBreak(buffer)) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
      }
    }

    // Flush a trailing frame that arrived without a final blank line.
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function indexOfFrameBreak(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseFrame(raw: string): SseFrame | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let event = '';
  const dataLines: string[] = [];

  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec a single leading space after the colon is stripped.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join('\n') };
}

/** Parse a frame's data as JSON, returning null instead of throwing. */
export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
