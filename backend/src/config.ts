/**
 * config.ts
 * ---------------------------------------------------------------------------
 * All tunables in one place, read from the environment once at boot.
 * ---------------------------------------------------------------------------
 */

import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function list(name: string, fallback: string[]): string[] {
  const raw = str(name);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const CONFIG = {
  port: num('PORT', 8787),
  nodeEnv: str('NODE_ENV', 'development'),

  /* --- provider credentials ------------------------------------------ */
  anthropicApiKey: str('ANTHROPIC_API_KEY'),
  geminiApiKey: str('GEMINI_API_KEY'),
  /** Extra Gemini keys (comma-separated GEMINI_API_KEYS). The adapter
   *  rotates to the next key when one is quota-limited or overloaded —
   *  free-tier keys are per-project, so N keys ≈ N× the quota. */
  geminiApiKeys: list('GEMINI_API_KEYS', []),
  openaiApiKey: str('OPENAI_API_KEY'),

  /* --- models (overridable without touching code) --------------------- */
  anthropicModel: str('ANTHROPIC_MODEL', 'claude-3-5-haiku-latest'),
  geminiModel: str('GEMINI_MODEL', 'gemini-1.5-flash'),
  openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),

  /* --- API base URLs ---------------------------------------------------
   * Overridable so the gateway can sit behind a corporate proxy, Azure /
   * Vertex style endpoint, or a local mock during tests. Leave blank for
   * the vendors' own hosts.
   * ------------------------------------------------------------------- */
  anthropicBaseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
  geminiBaseUrl: str('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com'),

  /* --- generation ------------------------------------------------------
   * Thinking models (Gemini 3.x, Claude with extended thinking) spend part
   * of maxTokens on internal reasoning BEFORE any visible text, so a small
   * ceiling truncates answers mid-sentence. 4096 leaves room for both.
   * -------------------------------------------------------------------- */
  maxTokens: num('MAX_TOKENS', 4096),
  temperature: num('TEMPERATURE', 0.2),

  /* --- loop + timeouts -------------------------------------------------- */
  /** Hard ceiling on time-to-completion for one provider call. */
  providerTimeoutMs: num('PROVIDER_TIMEOUT_MS', 30_000),
  /** How long the backend waits for the browser to run a tool. */
  toolTimeoutMs: num('TOOL_TIMEOUT_MS', 20_000),
  /** Model turn -> tool -> model turn ... cycles before the forced final
   *  answer turn (tools disabled) kicks in. */
  maxToolIterations: num('MAX_TOOL_ITERATIONS', 8),
  /** SSE comment frame interval, to defeat proxy idle timeouts. */
  heartbeatMs: num('HEARTBEAT_MS', 15_000),

  /* --- input limits ------------------------------------------------------ */
  maxMessageChars: num('MAX_MESSAGE_CHARS', 4000),
  maxHistoryTurns: num('MAX_HISTORY_TURNS', 12),

  /* --- rate limiting ------------------------------------------------------ */
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: num('RATE_LIMIT_MAX', 20),
  toolRateLimitMax: num('TOOL_RATE_LIMIT_MAX', 200),

  /**
   * CORS allow-list. `chrome-extension://<id>` is added by the operator once
   * the unpacked extension has an id; during development the extension calls
   * from the abhibus.com page origin, which is why it is present by default.
   */
  allowedOrigins: list('ALLOWED_ORIGINS', [
    'https://www.abhibus.com',
    'https://abhibus.com',
  ]),
  /** Set ALLOW_ALL_ORIGINS=true only for local development. */
  allowAllOrigins: str('ALLOW_ALL_ORIGINS', 'false') === 'true',

  /* --- UI feature flags -------------------------------------------------
   * SHOW_BUS_LIST_UI=no hides the rich bus-results card inside the chat
   * panel: searches still run, the page still navigates to the live results
   * with the user's filters auto-applied, but the chat shows a short playful
   * note instead of the list and tucks itself away while the page does the
   * talking (reopening it keeps the full history). Anything except
   * no/false/0/off counts as yes.
   * -------------------------------------------------------------------- */
  showBusListUi: !['no', 'false', '0', 'off'].includes(
    str('SHOW_BUS_LIST_UI', 'yes').toLowerCase(),
  ),

  /**
   * CHAT_FLOW=row lays the minimal chat out horizontally — new messages
   * push to the RIGHT along the bottom of the screen instead of stacking
   * upward. Anything except "row" means the classic small column.
   */
  chatFlow: str('CHAT_FLOW', 'column').toLowerCase() === 'row' ? 'row' : 'column',
} as const;

export function describeConfig(): string {
  const geminiKeyCount = new Set(
    [CONFIG.geminiApiKey, ...CONFIG.geminiApiKeys].filter(Boolean),
  ).size;

  const keys = [
    CONFIG.anthropicApiKey ? `anthropic(${CONFIG.anthropicModel})` : null,
    geminiKeyCount
      ? `gemini(${CONFIG.geminiModel}${geminiKeyCount > 1 ? ` ×${geminiKeyCount} keys` : ''})`
      : null,
    CONFIG.openaiApiKey ? `openai(${CONFIG.openaiModel})` : null,
  ].filter(Boolean);

  return keys.length ? keys.join(' -> ') : 'NO PROVIDERS CONFIGURED';
}
