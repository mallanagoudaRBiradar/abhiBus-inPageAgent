/**
 * server.ts
 * ---------------------------------------------------------------------------
 * Express entrypoint for the AbhiBus agent gateway.
 *
 * Everything sensitive lives here and only here: the extension never sees an
 * LLM API key, and this server never sees an AbhiBus session cookie. Each side
 * holds exactly the secrets it needs and nothing more.
 * ---------------------------------------------------------------------------
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors, { type CorsOptions } from 'cors';
import rateLimit from 'express-rate-limit';

import { CONFIG, describeConfig } from './config.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { GeminiAdapter } from './llm/gemini.js';
import { OpenAIAdapter } from './llm/openai.js';
import { LLMAdapter } from './llm/llmAdapter.js';
import { createChatRouter } from './routes/chat.js';
import { sessionStore } from './session/sessionStore.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { resolveStation, stationCount } from './stations.js';
import { getKnowledge } from './knowledge.js';

/* ========================================================================
 * Provider waterfall — order here IS the fallback order.
 * ====================================================================== */
const llm = new LLMAdapter([
  new AnthropicAdapter({
    apiKey: CONFIG.anthropicApiKey,
    model: CONFIG.anthropicModel,
    baseUrl: CONFIG.anthropicBaseUrl,
    timeoutMs: CONFIG.providerTimeoutMs,
  }),
  new GeminiAdapter({
    apiKey: CONFIG.geminiApiKey,
    apiKeys: CONFIG.geminiApiKeys,
    model: CONFIG.geminiModel,
    baseUrl: CONFIG.geminiBaseUrl,
    timeoutMs: CONFIG.providerTimeoutMs,
  }),
  new OpenAIAdapter({
    apiKey: CONFIG.openaiApiKey,
    model: CONFIG.openaiModel,
    baseUrl: CONFIG.openaiBaseUrl,
    timeoutMs: CONFIG.providerTimeoutMs,
  }),
]);

/* ========================================================================
 * App
 * ====================================================================== */
const app = express();

// Behind a single reverse proxy (Render/Fly/nginx) so req.ip is the real client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ---- CORS -------------------------------------------------------------- */
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Non-browser callers (curl, health checks) send no Origin header.
    if (!origin) return callback(null, true);
    if (CONFIG.allowAllOrigins) return callback(null, true);
    if (CONFIG.allowedOrigins.includes(origin)) return callback(null, true);
    // The content script runs on every AbhiBus subdomain (www / web / m…) and
    // its fetches carry that page's origin — allow the whole family, or the
    // assistant silently dies anywhere except www.
    if (/^https:\/\/([a-z0-9-]+\.)*abhibus\.com$/i.test(origin)) return callback(null, true);
    // Any unpacked build of this extension, whatever id Chrome assigned it.
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Session-Id'],
  maxAge: 600,
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '1mb' }));

/* ---- Rate limiting ------------------------------------------------------
 * Two buckets. Chat is expensive (an LLM call plus a held-open socket) so it
 * is limited tightly. Tool results are cheap and one chat turn can legitimately
 * produce several, so they get a much larger allowance — sharing one limiter
 * would let a normal multi-tool conversation rate-limit itself.
 * ------------------------------------------------------------------------ */
const chatLimiter = rateLimit({
  windowMs: CONFIG.rateLimitWindowMs,
  max: CONFIG.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'RATE_LIMITED',
    message: 'Too many messages. Wait a moment and try again.',
  },
});

const toolLimiter = rateLimit({
  windowMs: CONFIG.rateLimitWindowMs,
  max: CONFIG.toolRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', message: 'Too many tool results.' },
});

app.use('/api/chat', chatLimiter);
app.use('/api/tool-result', toolLimiter);

/* ---- Routes -------------------------------------------------------------- */
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    providers: llm.configuredProviders,
    pendingToolCalls: sessionStore.size,
    toolCount: TOOL_DEFINITIONS.length,
  });
});

/** Handy during extension development: confirms names match the registry. */
app.get('/api/tools', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      requiresAuth: t.requiresAuth,
      required: t.parameters.required ?? [],
    })),
  });
});

/** UI feature flags the extension reads at boot (see .env). */
app.get('/api/ui-config', (_req: Request, res: Response) => {
  res.json({ ok: true, showBusListUi: CONFIG.showBusListUi, chatFlow: CONFIG.chatFlow });
});

/** Debug: confirm what a city name resolves to, e.g. /api/stations/resolve?name=pune */
app.get('/api/stations/resolve', (req: Request, res: Response) => {
  const name = String(req.query.name ?? '').slice(0, 100);
  if (!name.trim()) {
    res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'name query param required' });
    return;
  }
  res.json({ ok: true, ...resolveStation(name) });
});

app.use('/api', createChatRouter(llm));

app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'No such endpoint' });
});

// Four-arg signature is what marks this as Express's error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled', err);
  if (res.headersSent) return;
  const isCors = err.message?.startsWith('Origin not allowed');
  res.status(isCors ? 403 : 500).json({
    ok: false,
    code: isCors ? 'ORIGIN_NOT_ALLOWED' : 'INTERNAL',
    message: isCors ? err.message : 'Internal server error',
  });
});

/* ========================================================================
 * Boot
 * ====================================================================== */
if (!llm.hasAnyProvider()) {
  console.warn(
    '\n  WARNING: no API keys found. Copy .env.example to .env and add at least one key.\n',
  );
}

const server = app.listen(CONFIG.port, () => {
  console.log(`AbhiBus agent gateway listening on http://localhost:${CONFIG.port}`);
  console.log(`Provider waterfall: ${describeConfig()}`);
  console.log(`Tools registered:   ${TOOL_DEFINITIONS.length}`);
  // Warm the caches now so the first user question does not pay for them.
  try {
    console.log(`Station master:     ${stationCount()} stations indexed`);
  } catch (err) {
    console.error('[server] failed to load station master:', err);
  }
  void getKnowledge().catch(() => {});
});

// SSE connections are long-lived; give them a chance to drain on shutdown.
server.headersTimeout = 0;
server.requestTimeout = 0;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
