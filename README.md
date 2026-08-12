# AbhiBus In-Page Agent

An AI assistant that lives inside `abhibus.com`. It injects a chat panel into the page,
calls AbhiBus APIs with the user's own signed-in session, and reasons over the results
using a cloud LLM behind a Node gateway.

```
┌──────────────────────── Chrome (abhibus.com tab) ───────────────────────┐
│                                                                          │
│  content.js ── preRouter ──► AbhiBusAPIRegistry ──► www.abhibus.com     │
│      │           (fast path)        ▲                (session cookies)   │
│      │                              │                                    │
│      └── shadowUi (Shadow DOM chat panel)                                │
│      │                              │                                    │
│      └── agentClient ───SSE───┐     │ tool execution                     │
│                               │     │                                    │
└───────────────────────────────┼─────┼────────────────────────────────────┘
                                ▼     │
                    ┌──────────────────────────────┐
                    │  Node / Express gateway      │
                    │  LLMAdapter waterfall:       │
                    │    Claude 3.5 Haiku          │
                    │      └► Gemini 1.5 Flash     │
                    │           └► GPT-4o-mini     │
                    └──────────────────────────────┘
```

Two secrets, two places, no overlap: **the extension never sees an LLM API key, and the
gateway never sees an AbhiBus cookie.** All AbhiBus traffic is same-origin from the tab.

---

## ⚠️ Read this first: the credentials in your CSV

`ABHIBUS_public_API_-_Sheet1.csv` contains a **live bearer JWT, a refresh token, and the
full cookie jar** for a real AbhiBus account (`rahul…@gmail.com`, ending `…8164`). None of
it was copied into this codebase — the extension reads the token from the browser's own
`__abrs_auth_state` cookie at call time instead.

Before you share that file or commit it anywhere:

1. Log out of AbhiBus in that browser and log back in, which rotates the refresh token.
2. Delete the CSV from any repo, chat or drive it has been uploaded to.

The `.gitignore` in this project already excludes `*.csv` for that reason.

---

## Quick start

### 1. Backend

```bash
cd backend
cp .env.example .env      # add at least one API key
npm install
npm run dev               # http://localhost:8787
```

Confirm it is up:

```bash
curl http://localhost:8787/health
# {"ok":true,"providers":["anthropic","gemini","openai"], ...}
```

The waterfall silently skips any provider whose key is blank, so a single key is enough
to run the whole system — you just lose the fallback hops.

Verify the fallback and tool loop without spending a token:

```bash
npm run smoke   # fakes a dead primary provider, asserts Gemini finishes the job
```

### 2. Extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. The settings page opens automatically. Leave the gateway at
   `http://localhost:8787` and click **Test connection**.
5. Open `https://www.abhibus.com`, sign in, and click the red bus button at the
   bottom-right.

There is no build step. The content scripts are plain ES2020 sharing one global
namespace (`window.__ABHI_AGENT__`), loaded in dependency order by the manifest.

### 3. Try it

| Prompt | Path taken |
| --- | --- |
| `balance?` | Local pre-route, ~50 ms, no LLM |
| `my upcoming tickets` | Local pre-route |
| `is my AbhiCash enough for a Goa trip on Saturday?` | LLM + 2–3 tool calls |
| `find me the cheapest sleeper from Goa to Pune on 15 Aug` | LLM + `resolveCityIds` → `searchBuses` |

---

## Project layout

```
extension/
├── manifest.json          MV3: activeTab, storage, cookies; hosts limited to abhibus.com
├── background.js          Toolbar toggle + first-run defaults. Deliberately thin.
├── options.html/.js       Gateway URL + debug logging, with a health check
├── dev/preview.html       Standalone UI harness (hostile page CSS, no backend needed)
└── src/
    ├── config.js          Global namespace, settings, API_EXP flags
    ├── apiRegistry.js     PHASE 1 — the 8 endpoints + resolveCityIds
    ├── formatters.js      Local answer rendering for the fast path
    ├── preRouter.js       PHASE 4 — regex intent routing
    ├── shadowUi.js        PHASE 2 — the entire UI, inside attachShadow()
    ├── agentClient.js     PHASE 4 — SSE reader + tool-result callback
    └── content.js         Entrypoint and routing decision

backend/
├── src/
│   ├── server.ts          Express, CORS, two rate-limit buckets
│   ├── config.ts          Every tunable, read from env once
│   ├── types.ts           PHASE 5 — all cross-boundary contracts
│   ├── tools.ts           JSON schemas mirroring the registry
│   ├── prompt.ts          One system prompt for all three providers
│   ├── stations.ts        22k-station master index for resolveCityIds
│   ├── knowledge.ts       llm.txt fetch/cache + built-in FAQ fallback
│   ├── serverTools.ts     Tools the gateway runs itself (no browser hop)
│   ├── routes/chat.ts     POST /api/chat (SSE) + POST /api/tool-result
│   ├── routes/routes.json The AbhiBus station master (10 MB, loaded once)
│   ├── session/           Pending tool-call promises — the re-entrancy trick
│   ├── dev/smokeLoop.ts   Offline waterfall + tool-loop assertion
│   └── llm/
│       ├── llmAdapter.ts  PHASE 3 — the waterfall and the agent loop
│       ├── http.ts        timedFetch, retry classification, SSE frame reader
│       ├── schema.ts      One tool, three schema dialects
│       ├── anthropic.ts   /v1/messages
│       ├── gemini.ts      :streamGenerateContent?alt=sse
│       └── openai.ts      /v1/chat/completions
```

---

## Phase 1 — the API registry

Nine handlers, eight of them derived directly from the cURL captures in your CSV.

| Handler | Endpoint | Method | Notes |
| --- | --- | --- | --- |
| `getAbhiCashBalance` | `/wap/abhicash` | POST json | auth |
| `getWalletHistory` | `/wap/getWallet` | POST **form** | auth; the one urlencoded endpoint |
| `searchBuses` | `/buslist/v3/services` | POST json | `x-app-name: nextgenweb` |
| `getSeatLayout` | `/wap/GetSeatLayout` | POST json | needs `serviceKey` + `operatorId` |
| `getSeatLayoutOffers` | `/wap/getSeatLayoutOffers` | POST json | field is `destionationID` — the live API's typo, preserved |
| `getSavedPassengers` | `/wap/Passengers` | **GET** | auth; no body |
| `getBookings` | `/wap/GetBookings` | POST json | auth |
| `getFailedTrips` | `/wap/getFailureTrips` | POST json | auth |
| `resolveCityIds` | *(gateway, station master)* | — | see below |
| `getHelpContent` | *(gateway, llm.txt / FAQ pack)* | — | see below |

Three things every handler does:

- **`credentials: 'include'`** on every request, so the live session rides along. The
  extension never reads, stores or transmits a cookie value; the browser attaches them.
- **The bearer token** is read from the `__abrs_auth_state` cookie at call time, matching
  what the AbhiBus SPA itself sends. It expires roughly every two hours and the site
  refreshes it — reading it per call means we never hold a stale one.
- **Responses are projected down** before they reach a model. A bus-list response can be
  400 KB; `searchBuses` returns the top 15 services with 11 fields each. `capForModel()`
  is a hard backstop that trims anything still over 12 KB.

`origin`, `referer`, `user-agent` and the `sec-*` headers from your cURL captures are
**not** set. They are forbidden header names — the browser writes them itself and
silently discards anything we supply.

### The UNAUTHENTICATED contract

Any 401/403, **or** a 200 whose payload smells like an auth failure (`statusCode: 401`,
or a message containing `invalid token` / `session expired` / `please login`), throws:

```js
{ name: 'AbhiBusApiError', code: 'UNAUTHENTICATED', status: 401 }
```

That single code travels unchanged through the registry → the tool loop → the SSE
`error` event → the login card in the panel. Nothing downstream needs to know how
AbhiBus signals a logged-out session.

### About `resolveCityIds`

`searchBuses` needs numeric city ids. This tool is now **server-side**: the gateway
loads the full AbhiBus station master (`backend/src/routes/routes.json`, 22,600+
stations) into an in-memory index at boot and resolves any city name instantly —
exact names, short codes (`HYD`), old names (`bombay`, `bengaluru`), prefixes and
substrings all work. The response carries the canonical station name alongside the id,
and the system prompt tells the model to pass exactly those to `searchBuses`.

Debug it directly: `curl "localhost:8787/api/stations/resolve?name=pune"`.

### About `getHelpContent`

FAQ and policy questions ("how do refunds work?") are answered from
`https://www.abhibus.com/llms.txt` (the llms.txt standard; override with
`KNOWLEDGE_URL`), fetched lazily and cached for 6 hours. If it is unreachable the
gateway falls back to `llm.txt` and then to a built-in FAQ pack — the model is told
which source it got. Only the sections keyword-relevant to the question are returned,
never the whole document.

Both tools are executed by the gateway itself (`serverTools.ts`) — no extension round
trip. The panel still shows their activity chips via the display-only `server_tool`
SSE event.

---

## Phase 2 — Shadow DOM UI

`attachShadow({ mode: 'open' })` on a single host div. AbhiBus ships a global
`* { box-sizing }` reset and generic `.btn` rules; neither can reach inside.
`extension/dev/preview.html` proves it by loading the panel under deliberately hostile
page CSS.

Design choices worth knowing before you edit them:

- **No web fonts.** A strict page CSP would block `fonts.googleapis.com`, and a chat
  panel that silently loses its typeface is worse than one using the system face.
  Prose is the system UI stack; **all data — fares, times, PNRs, seat numbers — is
  monospace**, the way it appears on a printed ticket. That split is the type system.
- **The route rule** under the header — a dotted line between two stop dots, with a
  marker that travels along it while the agent works — is the one animated element.
  It reads as "in transit" rather than as decoration.
- **Tool activity** appears as ticket-stub chips with punched notches (CSS
  `mask-composite`), amber while running, teal when done, red when failed.
- Model output never touches `innerHTML`. `renderRichText()` builds DOM nodes and puts
  every literal character through `textContent`, supporting only `**bold**`, `*italic*`,
  `` `code` `` and `- lists`.
- `prefers-reduced-motion` is respected; focus is visible; Escape closes the panel.

---

## Phase 3 — the gateway

No `@anthropic-ai/sdk`, no `@google/genai`, no `openai`. Every provider is spoken to
with Node 20's global `fetch`, and every stream is decoded by one shared SSE reader in
`llm/http.ts` that handles the two things naive parsers get wrong: frames split across
chunk boundaries, and multi-line `data:` fields.

### Schema dialects

The same tool, three ways (`llm/schema.ts`):

| | Shape | Gotcha |
| --- | --- | --- |
| Anthropic | `{ name, description, input_schema }` | accepts JSON Schema as-is |
| OpenAI | `{ type: 'function', function: {...} }` | arguments arrive as a JSON **string** |
| Gemini | `{ functionDeclarations: [...] }` | OpenAPI subset: `TYPE` uppercase, no `additionalProperties`/`default`, and an object with **zero** properties 400s — so no-arg tools omit `parameters` entirely |

### Fallback rules

A provider is retried past on 408/409/429/5xx and on network errors. It is **not**
retried past on 400/401/403/404 — a malformed request or a bad key fails identically
downstream, and the wasted round trip only delays the error you need to see.

Once a provider has failed it is burned for the rest of the request, so a flapping
upstream cannot cost three timeouts on every loop iteration.

**Commit semantics.** Once the active provider emits its first token to the browser the
response is committed and fallback stops. Restarting the answer mid-word would be worse
than the error. After commit, a failure surfaces as an `error` event.

---

## Phase 4 — routing

### Fast path

Three regex rules in `preRouter.js` (`/balance|abhicash/i`, `/booking|ticket|pnr|upcoming/i`,
`/offer|coupon|discount/i`, plus a wallet-history rule checked before `balance` so it
isn't swallowed). A match runs one registry call and renders locally — typically 40–90 ms
against 1–3 s through a model.

Two guards keep it honest, because a false positive here produces a wrong answer with no
model to catch it:

- prompts over 120 chars, or containing `compare|cheapest|best|should|enough|why|if…`,
  are handed to the model
- if **two** rules match, the model handles it — sequencing two intents is not
  something a regex should attempt

The offers rule additionally requires a seat-layout page, since offers are per-service.

### Tool loop

```
extension ──POST /api/chat─────────────────► gateway
          ◄──── SSE: meta, status ──────────
                                              model picks a tool
          ◄──── SSE: tool_call ──────────────  (loop parks on a promise)
  registry runs it with session cookies
          ──POST /api/tool-result──────────►  (promise resolves, loop resumes)
          ◄──── SSE: text_delta × n ────────
          ◄──── SSE: done ──────────────────
```

The reply leg is a separate POST because a content script cannot stream a request body
upward. `session/sessionStore.ts` holds the pending promise keyed by
`(sessionId, toolCallId)`; resolving it unblocks the still-open SSE response.

On the client, tool execution is **fire-and-forget**. Awaiting it inside the read loop
would stop the socket draining, so heartbeats and later events would queue behind a slow
AbhiBus call.

Bounded by `MAX_TOOL_ITERATIONS` (6) and `TOOL_TIMEOUT_MS` (20 s). An `UNAUTHENTICATED`
tool result ends the turn immediately — no amount of model cleverness fixes a logged-out
session, and looping just burns tokens re-requesting the same tool.

---

## Phase 5 — hardening

- **Typing indicator** — a shimmer bar on the pending bubble plus the travelling route
  marker, both driven by `status` events, both suppressed under reduced motion.
- **Rate limiting** — two `express-rate-limit` buckets. Chat is expensive (a model call
  plus a held socket) at 20/min; tool results are cheap and one turn legitimately makes
  several, at 200/min. Sharing one bucket would let a normal multi-tool conversation
  rate-limit itself.
- **Strict types** — every cross-boundary contract is in `types.ts`, and `SseEvent` is a
  discriminated union. The frontend switches on `type` and never on provider, so a
  mid-conversation Claude→Gemini switch is invisible.
- **Heartbeats** — a `: keep-alive` comment frame every 15 s, plus `X-Accel-Buffering: no`,
  because nginx will otherwise buffer an SSE stream into uselessness.
- **Graceful shutdown**, per-request abort propagation, and `abandonSession()` so a
  dropped socket does not leave promises pending.

---

## Configuration

All backend settings are env vars — see `backend/.env.example`. The ones you are most
likely to touch:

| Variable | Default | Why |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-3-5-haiku-latest` | any Messages-API model |
| `MAX_TOOL_ITERATIONS` | `6` | raise for longer chains |
| `TOOL_TIMEOUT_MS` | `20000` | raise if AbhiBus is slow |
| `RATE_LIMIT_MAX` | `20` | chat messages per minute |
| `ALLOWED_ORIGINS` | abhibus.com | `chrome-extension://*` is always allowed |
| `*_BASE_URL` | vendor hosts | Point a provider at a proxy, an Azure/Vertex-style endpoint, or a local mock |

Extension settings live in `chrome.storage.sync` (gateway URL, debug logging) and are
edited from the options page.

### Deploying the gateway

1. `npm run build && npm start`, or point your platform at `dist/server.js`.
2. Set `ALLOWED_ORIGINS` to your real origins and leave `ALLOW_ALL_ORIGINS=false`.
3. **Add the deployed URL to `host_permissions` in `manifest.json`** and reload the
   extension — Chrome blocks content-script requests to hosts the manifest does not
   declare. Then set it in the options page.

### Scaling

`sessionStore` is process-local, so the SSE connection and its `tool-result` POSTs must
land on the same instance. For more than one instance, either enable sticky sessions on
the load balancer or move the pending map to Redis with a pub/sub channel to resolve it.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Cannot reach the assistant backend" | Gateway down, or its URL is missing from `host_permissions` |
| Login card on every question | `__abrs_auth_state` cookie absent or expired — sign in on the tab, then hit "I have signed in" |
| Panel never appears | Not on an `abhibus.com` URL, or the page loaded before the extension was enabled (reload) |
| Chat works, tools always time out | `/api/tool-result` blocked by CORS — check `ALLOWED_ORIGINS` |
| Gemini returns 400 on tools | A schema gained an unsupported key; `schema.ts` must strip it |
| Answers stall then arrive in a burst | A proxy is buffering SSE — confirm `X-Accel-Buffering: no` survives it |

Turn on debug logging in the options page to see every registry call and SSE event in
the page console.

---

## Scope and limits

The agent reads. It can search buses, read seat maps and offers, and report on the
account. **It cannot book a seat, make a payment, or cancel a ticket** — no endpoint in
this registry mutates anything, by design. Adding write endpoints means adding an
explicit confirmation step in the UI, not just another registry handler.

This is unofficial software built against private endpoints observed in your own browser
traffic. Those endpoints carry no compatibility guarantee and can change without notice;
the defensive field probing in `apiRegistry.js` (`pick()` / `findArray()`) is there to
degrade gracefully when they do, not to make it safe to ignore. Check AbhiBus's terms
before deploying this to anyone but yourself.
