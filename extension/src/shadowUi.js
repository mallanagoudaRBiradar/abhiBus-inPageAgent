/**
 * shadowUi.js  —  PHASE 2 / PHASE 5
 * ---------------------------------------------------------------------------
 * The whole interface lives inside `attachShadow({ mode: 'open' })`, so nothing
 * abhibus.com ships can reach it: no leaked `* { box-sizing }`, no `.btn`
 * collision, no z-index war beyond the single host element.
 *
 * DESIGN NOTES
 * The subject is intercity bus travel, so the panel borrows from the physical
 * artefacts of that world rather than from generic chat UI:
 *   - Data (fares, times, PNRs, seat numbers) is set in monospace, the way it
 *     appears on a printed ticket. Prose stays in the UI sans face. That split
 *     is the type system.
 *   - The signature element is the route rule: a dotted line between two stop
 *     dots, sitting under the header. While the agent works, a marker travels
 *     along it. It is the only animated thing in the panel, so it reads as
 *     "in transit" rather than as decoration.
 *   - Tool activity appears as ticket-stub chips with punched notches.
 * Everything else is deliberately quiet.
 *
 * No web fonts are loaded: a strict page CSP would block them, and a chat panel
 * that silently loses its typeface is worse than one that uses the system face.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});

  const HOST_ID = 'abhibus-inpage-agent-root';

  /* =====================================================================
   * Styles
   * =================================================================== */

  const STYLES = `
:host {
  /* Palette: night-coach charcoal, ticket paper, AbhiBus signal red,
     destination-board amber. */
  --ink:        #14181F;
  --ink-2:      #2A313C;
  --muted:      #6B7484;
  --paper:      #FFFFFF;
  --paper-2:    #F1F3F7;
  --line:       #DDE2EA;
  --red:        #E5322D;
  --red-dark:   #C2231F;
  --amber:      #F5A524;
  --teal:       #0E8F7E;

  --radius:     14px;
  --radius-sm:  9px;
  --shadow:     0 18px 48px rgba(20, 24, 31, .22), 0 2px 8px rgba(20, 24, 31, .10);

  --ui:   -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  all: initial;
  font-family: var(--ui);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

*, *::before, *::after { box-sizing: border-box; }

button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
button:focus-visible, textarea:focus-visible, a:focus-visible {
  outline: 2px solid var(--red);
  outline-offset: 2px;
}

/* ---------------------------------------------------------- launcher */

.launcher {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 999999;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: var(--red);
  box-shadow: var(--shadow);
  display: grid;
  place-items: center;
  transition: transform .18s ease, background .18s ease;
}
.launcher:hover { transform: translateY(-2px); background: var(--red-dark); }
.launcher:active { transform: translateY(0); }
.launcher svg { width: 25px; height: 25px; fill: #fff; }

/* Unread/attention pip, used when the agent finishes while collapsed. */
.launcher .pip {
  position: absolute;
  top: 3px; right: 3px;
  width: 11px; height: 11px;
  border-radius: 50%;
  background: var(--amber);
  border: 2px solid #fff;
  display: none;
}
.launcher[data-attention="true"] .pip { display: block; }
.launcher[hidden] { display: none; }

/* ------------------------------------------------------------- panel */

.panel {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 999999;
  width: 404px;
  max-width: calc(100vw - 32px);
  height: 640px;
  max-height: calc(100vh - 40px);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: bottom right;
  animation: panel-in .16s ease-out;
  transition: width .18s ease, height .18s ease;
}
.panel[hidden] { display: none; }
.panel[data-wide="true"] {
  width: 640px;
  height: calc(100vh - 40px);
}

@keyframes panel-in {
  from { opacity: 0; transform: scale(.97) translateY(6px); }
  to   { opacity: 1; transform: none; }
}

/* ------------------------------------------------------------ header */

.head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px 11px;
  background: linear-gradient(120deg, var(--red) 60%, var(--red-dark));
  color: #fff;
  overflow: hidden;
}
.head-art {
  position: absolute;
  top: 0; right: 0;
  height: 100%;
  width: 220px;
  pointer-events: none;
}
.head > :not(.head-art) { position: relative; z-index: 1; }
.head .mark {
  width: 30px; height: 30px;
  border-radius: 8px;
  background: rgba(255,255,255,.18);
  display: grid; place-items: center;
  flex: none;
}
.head .mark svg { width: 17px; height: 17px; fill: #fff; }
.head .titles { flex: 1; min-width: 0; }
.head h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -.01em;
}
.head .sub {
  margin: 1px 0 0;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: rgba(255,255,255,.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.icon-btn {
  width: 28px; height: 28px;
  border-radius: 7px;
  display: grid; place-items: center;
  color: rgba(255,255,255,.7);
  flex: none;
}
.icon-btn:hover { background: rgba(255,255,255,.12); color: #fff; }
.icon-btn svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; }

/* ------------------------------------- signature: the route rule */

.route {
  position: relative;
  height: 28px;
  background: linear-gradient(180deg, var(--red-dark), #A81D1A);
  padding: 0 20px;
  display: flex;
  align-items: center;
  flex: none;
  overflow: hidden;
}
.route .sky {
  position: absolute;
  top: 1px;
  left: 30%;
  width: 60px; height: 16px;
  opacity: 0;
  transition: opacity .3s ease;
}
.panel[data-busy="true"] .route .sky {
  opacity: 1;
  animation: drift 9s ease-in-out infinite alternate;
}
@keyframes drift {
  from { transform: translateX(-30px); }
  to   { transform: translateX(50px); }
}
.route::before {                     /* the dotted road */
  content: "";
  position: absolute;
  left: 20px; right: 20px;
  height: 0;
  border-top: 1.5px dotted rgba(255,255,255,.4);
}
.route .stop {                       /* origin + destination dots */
  position: absolute;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: rgba(255,255,255,.7);
}
.route .stop.a { left: 17px; }
.route .stop.b { right: 17px; }
.route .marker {                     /* a little bus drives while working */
  position: absolute;
  left: 20px;
  top: 5px;
  width: 18px; height: 18px;
  opacity: 0;
}
.route .marker svg {
  width: 18px; height: 18px;
  fill: #fff;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.35));
}
.panel[data-busy="true"] .route .marker {
  opacity: 1;
  /* Unhurried: a bus on a scenic road, not a progress bar. */
  animation: travel 5.5s cubic-bezier(.45,.05,.55,.95) infinite;
}
@keyframes travel {
  0%   { left: 14px; }
  100% { left: calc(100% - 34px); }
}

/* --------------------------------------------------------------- log */

.log {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--paper);
  scrollbar-width: thin;
}
/* CRITICAL: log entries must never flex-shrink. A child with overflow hidden
   (the bus card) has an automatic minimum size of ZERO, so once the log
   content exceeds the panel height the flex algorithm crushes it to a sliver
   instead of letting the log scroll. */
.log > * { flex: none; }
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: var(--line); border-radius: 99px; }

.msg {
  max-width: 88%;
  padding: 10px 13px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  line-height: 1.6;
  white-space: normal;
  word-wrap: break-word;
  animation: msg-in .14s ease-out;
}
@keyframes msg-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; } }

.msg.user {
  align-self: flex-end;
  background: var(--red);
  color: #fff;
  border-bottom-right-radius: 3px;
  box-shadow: 0 1px 3px rgba(229,50,45,.25);
}
.msg.bot {
  align-self: flex-start;
  background: #FFF9F8;
  border: 1px solid rgba(229,50,45,.14);
  color: var(--ink);
  border-bottom-left-radius: 3px;
}

/* ----------------------------------------------------------- welcome */

.welcome {
  align-self: center;
  text-align: center;
  padding: 26px 18px 10px;
  animation: msg-in .2s ease-out;
}
.welcome .badge {
  width: 44px; height: 44px;
  margin: 0 auto 12px;
  border-radius: 13px;
  background: var(--red);
  display: grid; place-items: center;
}
.welcome .badge svg { width: 24px; height: 24px; fill: #fff; }
.welcome h2 {
  margin: 0 0 5px;
  font-size: 16px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: -.01em;
}
.welcome p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
  max-width: 270px;
}

/* ------------------------------------------------------ jump-to-latest */

.jump {
  position: absolute;
  right: 16px;
  bottom: 148px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 99px;
  background: var(--red);
  color: #fff;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .06em;
  text-transform: uppercase;
  box-shadow: 0 4px 14px rgba(229,50,45,.35);
  animation: msg-in .15s ease-out;
}
.jump[hidden] { display: none; }
.jump:hover { background: var(--red-dark); }
.msg p { margin: 0 0 7px; }
.msg p:last-child { margin-bottom: 0; }
.msg ul, .msg ol { margin: 5px 0; padding-left: 17px; }
.msg li { margin: 3px 0; }
.msg h3 {
  margin: 12px 0 6px;
  padding: 5px 10px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--red-dark);
  letter-spacing: -.01em;
  background: #FFEFEE;
  border-left: 3px solid var(--red);
  border-radius: 0 6px 6px 0;
}
.msg h3:first-child { margin-top: 0; }
.msg strong { font-weight: 700; }
.msg code {
  font-family: var(--mono);
  font-size: 12px;
  background: rgba(20,24,31,.07);
  padding: 1px 5px;
  border-radius: 4px;
  letter-spacing: -.01em;
}
.msg.user code { background: rgba(255,255,255,.16); }

/* Fares, times, PNRs — set like a printed ticket. */
.msg .data { font-family: var(--mono); font-size: 12.5px; letter-spacing: -.01em; }

/* shimmer while the first token is pending */
.msg.pending::after {
  content: "";
  display: inline-block;
  vertical-align: middle;
  width: 42px; height: 9px;
  margin-left: 1px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--line) 25%, #E8ECF2 45%, var(--line) 65%);
  background-size: 220% 100%;
  animation: shimmer 1.15s linear infinite;
}
@keyframes shimmer {
  from { background-position: 120% 0; }
  to   { background-position: -60% 0; }
}

/* --------------------------------------------- tool chip (ticket stub) */

.chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--paper-2);
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 4px 11px;
  /* punched notches, left and right — the ticket-stub tell */
  -webkit-mask-image:
    radial-gradient(circle 4px at 0 50%, transparent 98%, #000 100%),
    radial-gradient(circle 4px at 100% 50%, transparent 98%, #000 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    radial-gradient(circle 4px at 0 50%, transparent 98%, #000 100%),
    radial-gradient(circle 4px at 100% 50%, transparent 98%, #000 100%);
  mask-composite: intersect;
}
.chip .dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--amber);
  flex: none;
}
.chip[data-state="done"] .dot { background: var(--teal); }
.chip[data-state="failed"] .dot { background: var(--red); }
.chip[data-state="running"] .dot { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }

/* ------------------------------------------------------------- cards */

.card {
  align-self: stretch;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 12px;
  background: var(--paper);
  font-size: 13px;
  line-height: 1.5;
}
.card.auth { border-color: rgba(229,50,45,.35); background: #FFF6F5; }
.card.error { border-color: var(--line); background: var(--paper-2); }
.card h2 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 640;
  color: var(--ink);
}
.card p { margin: 0; color: var(--muted); font-size: 12.5px; }
.card .actions { margin-top: 10px; display: flex; gap: 8px; }

.btn {
  border-radius: 7px;
  padding: 7px 13px;
  font-size: 12.5px;
  font-weight: 580;
  transition: background .15s ease;
}
.btn.primary { background: var(--red); color: #fff; }
.btn.primary:hover { background: var(--red-dark); }
.btn.ghost { border: 1px solid var(--line); color: var(--ink-2); }
.btn.ghost:hover { background: var(--paper-2); }

/* --------------------------------------------------------- bus cards */

.buses {
  align-self: stretch;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--paper);
  overflow: hidden;
  animation: msg-in .14s ease-out;
  box-shadow: 0 1px 3px rgba(20,24,31,.06);
}
.buses .buses-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 9px;
  background: var(--red);
  color: #fff;
}
.buses .buses-route {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 640;
  letter-spacing: -.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.buses .buses-meta {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: rgba(255,255,255,.55);
  white-space: nowrap;
}
.buses .buses-list {
  max-height: 380px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
/* Expanded: drop the inner cap entirely — the LOG scrolls instead. With the
   cap kept, "Show all N buses" appeared to do nothing because the new rows
   landed below the list's own scroll fold. */
.buses[data-expanded="true"] .buses-list {
  max-height: none;
  overflow-y: visible;
}
.buses .buses-list::-webkit-scrollbar { width: 8px; }
.buses .buses-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 99px; }

.bus {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  padding: 10px 12px;
  border-top: 1px dashed var(--line);
}
.bus:first-child { border-top: none; }
.bus .op {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bus .fare {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  text-align: right;
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 700;
  color: var(--red);
  letter-spacing: -.02em;
}
.bus .fare small {
  display: block;
  font-size: 9.5px;
  font-weight: 400;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--muted);
  margin-top: 1px;
}
.bus .fare .was {
  display: block;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--muted);
  text-decoration: line-through;
  margin-bottom: 1px;
}
.bus .type {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bus .times {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-2);
  letter-spacing: -.01em;
  white-space: nowrap;
}
.bus .times .dash {
  flex: none;
  width: 26px;
  border-top: 1px dotted var(--muted);
  position: relative;
  top: 1px;
}
.bus .times .dur { color: var(--muted); font-size: 10px; }
.bus .tags { grid-column: 1; display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; }
.bus .tag {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: .06em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 99px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.bus .tag.best { background: var(--red); border-color: var(--red); color: #fff; }
.bus .tag.ac { border-color: rgba(229,50,45,.4); color: var(--red); font-weight: 700; }
.bus .tag.seats-low { border-color: rgba(229,50,45,.35); color: var(--red); }
.bus[data-best="true"] { background: #FFF6F5; }

/* ---------------------------------------------------------- seat map */

.seatmap .deck-label {
  padding: 8px 12px 4px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--muted);
}
.seatmap .seat-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 12px 10px;
}
.seatmap .seat-chip {
  min-width: 44px;
  padding: 5px 7px 4px;
  border: 1.5px solid rgba(229,50,45,.45);
  border-radius: 7px;
  background: var(--paper);
  text-align: center;
}
.seatmap .seat-chip .num {
  display: block;
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink);
}
.seatmap .seat-chip .price {
  display: block;
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--red);
  margin-top: 1px;
}
.seatmap .seat-chip.ladies {
  border-color: #E91E8C;
  background: #FDF2F8;
}
.seatmap .seat-legend {
  padding: 6px 12px 9px;
  font-size: 10.5px;
  color: var(--muted);
  border-top: 1px dashed var(--line);
}
.seatmap .seatmap-empty {
  padding: 14px 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
}

.bus .seats-btn {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: .05em;
  text-transform: uppercase;
  font-weight: 640;
  padding: 3px 9px;
  border-radius: 99px;
  border: 1px solid rgba(229,50,45,.45);
  color: var(--red);
  background: var(--paper);
  transition: background .15s ease, color .15s ease;
}
.bus .seats-btn:hover { background: var(--red); color: #fff; }

.buses .buses-foot {
  padding: 7px 12px;
  border-top: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--muted);
}

/* Collapsed by default: top rows only, so the card and the answer share the
   viewport. data-extra rows appear when the card is expanded. */
.bus[data-extra="true"] { display: none; }
.buses[data-expanded="true"] .bus[data-extra="true"] { display: grid; }

.buses .buses-more {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border-top: 1px dashed var(--line);
  background: var(--paper);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .05em;
  text-transform: uppercase;
  text-align: center;
  transition: color .15s ease, background .15s ease;
}
.buses .buses-more:hover { color: var(--ink); background: var(--paper-2); }

.buses .buses-open {
  display: block;
  width: 100%;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: var(--paper);
  color: var(--red);
  font-size: 12.5px;
  font-weight: 620;
  text-align: center;
  transition: background .15s ease;
}
.buses .buses-open:hover { background: #FFF6F5; }

/* ------------------------------------------------------- suggestions */

.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 14px 10px;
  flex: none;
}
.suggestions[hidden] { display: none; }
.suggestions button {
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 99px;
  padding: 5px 11px;
  color: var(--ink-2);
  background: var(--paper);
  transition: border-color .15s ease, color .15s ease, transform .15s ease,
              box-shadow .15s ease;
}
.suggestions button:hover {
  border-color: var(--ink-2);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(20,24,31,.08);
}

/* ------------------------------------------------------------ status */

.status {
  flex: none;
  padding: 0 14px 6px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--muted);
  min-height: 15px;
}

/* ----------------------------------------------------------- compose */

.compose {
  flex: none;
  border-top: 1px solid var(--line);
  padding: 9px 10px 10px;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  background: var(--paper);
}
.compose textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 11px;
  font-family: var(--ui);
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--ink);
  background: var(--paper);
  max-height: 104px;
  min-height: 36px;
}
.compose textarea::placeholder { color: var(--muted); }
.compose textarea:focus { border-color: var(--ink-2); outline: none; }

.send {
  width: 36px; height: 36px;
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--red);
  display: grid; place-items: center;
  transition: background .15s ease, opacity .15s ease;
}
.send:hover { background: var(--red-dark); }
.send:disabled { opacity: .4; cursor: not-allowed; }
.send svg { width: 16px; height: 16px; fill: #fff; }

.footnote {
  flex: none;
  padding: 0 14px 9px;
  font-size: 10.5px;
  color: var(--muted);
}

/* ------------------------------------------------------- responsive */

@media (max-width: 480px) {
  .panel {
    width: calc(100vw - 16px);
    right: 8px;
    bottom: 8px;
    height: calc(100vh - 90px);
  }
  .launcher { bottom: 14px; right: 14px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
  .panel[data-busy="true"] .route .marker { opacity: 1; left: 50%; }
}
`;

  /* =====================================================================
   * Icons (inline so no network fetch and no CSP surprises)
   * =================================================================== */

  const ICON_BUS =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v9a2 2 0 0 1-1 1.73V18a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.27A2 2 0 0 1 3 14V5a2 2 0 0 1 2-2Zm0 3v5h14V6H5Zm1.75 6.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm10.5 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
  const ICON_RESET =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_EXPAND =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* Decorative travel scene for the header: sun, birds, palm, waves.
     White fills at low opacity over the AbhiBus red — quiet, not clipart. */
  const HEAD_ART =
    '<svg class="head-art" viewBox="0 0 220 64" aria-hidden="true" preserveAspectRatio="xMaxYMid slice">' +
    '<circle cx="176" cy="16" r="9" fill="#fff" opacity=".22"/>' +
    '<path d="M120 14 q4 -5 8 0 q4 -5 8 0" stroke="#fff" stroke-width="1.6" fill="none" opacity=".4" stroke-linecap="round"/>' +
    '<path d="M142 22 q3 -4 6 0 q3 -4 6 0" stroke="#fff" stroke-width="1.4" fill="none" opacity=".3" stroke-linecap="round"/>' +
    '<path d="M36 54 V30 M36 30 q-12 -8 -22 -4 q12 -10 22 -6 q2 -11 12 -14 q-6 8 -8 14 q11 -4 20 4 q-12 -2 -22 2" ' +
    'stroke="#fff" stroke-width="2.4" fill="none" opacity=".28" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M60 56 q10 -6 20 0 q10 -6 20 0 q10 -6 20 0 q10 -6 20 0 q10 -6 20 0 q10 -6 20 0 q10 -6 20 0" ' +
    'stroke="#fff" stroke-width="1.6" fill="none" opacity=".18" stroke-linecap="round"/>' +
    '</svg>';

  /* Birds drifting in the loading strip while the bus drives. */
  const ROUTE_SKY =
    '<svg class="sky" viewBox="0 0 60 16" aria-hidden="true">' +
    '<path d="M6 9 q3 -4 6 0 q3 -4 6 0" stroke="#fff" stroke-width="1.4" fill="none" opacity=".5" stroke-linecap="round"/>' +
    '<path d="M34 6 q2.5 -3.5 5 0 q2.5 -3.5 5 0" stroke="#fff" stroke-width="1.2" fill="none" opacity=".35" stroke-linecap="round"/>' +
    '</svg>';
  const ICON_SEND =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.1 15.5 12 3.39 13.9z"/></svg>';

  const SUGGESTIONS = [
    "What's my AbhiCash balance?",
    'Cheapest AC bus from Pune to Goa tomorrow',
    'Show my upcoming trips',
    'How do cancellations and refunds work?',
  ];

  /* =====================================================================
   * Safe mini-markdown -> DOM
   *
   * Model output is never trusted into innerHTML. Every literal character
   * goes through textContent; only elements WE create can exist.
   * =================================================================== */

  const HEADING_RE = /^\s*#{1,4}\s+/;
  const BULLET_RE = /^\s*[-*•]\s+/;
  const NUMBERED_RE = /^\s*\d{1,2}[.)]\s+/;

  function renderRichText(container, text) {
    container.textContent = '';
    const blocks = String(text ?? '').split(/\n{2,}/);

    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;

      // A block can mix headings, list items and prose line by line — group
      // consecutive lines of the same kind so "### Title\n1. a\n2. b" works.
      let group = null; // { kind: 'ul'|'ol'|'p', el }
      const flush = () => {
        group = null;
      };

      for (const line of lines) {
        if (HEADING_RE.test(line)) {
          flush();
          const h = document.createElement('h3');
          renderInline(h, line.replace(HEADING_RE, ''));
          container.appendChild(h);
          continue;
        }

        const isBullet = BULLET_RE.test(line);
        const isNumbered = !isBullet && NUMBERED_RE.test(line);
        if (isBullet || isNumbered) {
          const kind = isBullet ? 'ul' : 'ol';
          if (group?.kind !== kind) {
            flush();
            group = { kind, el: document.createElement(kind) };
            container.appendChild(group.el);
          }
          const li = document.createElement('li');
          renderInline(li, line.replace(isBullet ? BULLET_RE : NUMBERED_RE, ''));
          group.el.appendChild(li);
          continue;
        }

        if (group?.kind !== 'p') {
          flush();
          group = { kind: 'p', el: document.createElement('p') };
          container.appendChild(group.el);
        } else {
          group.el.appendChild(document.createElement('br'));
        }
        renderInline(group.el, line);
      }
    }
  }

  /** Handles **bold**, *italic* and `code`, nothing else. */
  function renderInline(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) {
        parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      }
      const token = match[0];
      let el;
      if (token.startsWith('**')) {
        el = document.createElement('strong');
        el.textContent = token.slice(2, -2);
      } else if (token.startsWith('`')) {
        el = document.createElement('code');
        el.textContent = token.slice(1, -1);
      } else {
        el = document.createElement('em');
        el.textContent = token.slice(1, -1);
      }
      parent.appendChild(el);
      cursor = match.index + token.length;
    }

    if (cursor < text.length) {
      parent.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  /* =====================================================================
   * The UI
   * =================================================================== */

  /**
   * @param {{ onSend:(text:string)=>void, onLogin:()=>void, onReset:()=>void,
   *           onStop?:()=>void }} handlers
   */
  function createChatUI(handlers) {
    let host = document.getElementById(HOST_ID);
    if (host) host.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    // The host itself must not participate in the page's layout.
    host.style.cssText = 'all: initial; position: static;';

    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    root.appendChild(style);

    /* ---- launcher --------------------------------------------------- */
    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Open the AbhiBus assistant');
    launcher.innerHTML = `${ICON_BUS}<span class="pip"></span>`;
    root.appendChild(launcher);

    /* ---- panel ------------------------------------------------------ */
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'AbhiBus assistant');
    panel.hidden = true;
    panel.innerHTML = `
      <div class="head">
        ${HEAD_ART}
        <span class="mark">${ICON_BUS}</span>
        <div class="titles">
          <h1>AbhiBus assistant</h1>
          <p class="sub" data-sub>Ready</p>
        </div>
        <button class="icon-btn" type="button" data-expand title="Expand"
                aria-label="Toggle a wider panel">${ICON_EXPAND}</button>
        <button class="icon-btn" type="button" data-reset title="Start over"
                aria-label="Start a new conversation">${ICON_RESET}</button>
        <button class="icon-btn" type="button" data-close title="Close"
                aria-label="Close the assistant">${ICON_CLOSE}</button>
      </div>

      <div class="route" aria-hidden="true">
        ${ROUTE_SKY}
        <span class="stop a"></span>
        <span class="marker">${ICON_BUS}</span>
        <span class="stop b"></span>
      </div>

      <div class="log" role="log" aria-live="polite" aria-atomic="false" data-log></div>
      <button class="jump" type="button" data-jump hidden
              aria-label="Scroll to the latest message">&darr; Latest</button>

      <div class="suggestions" data-suggestions></div>
      <div class="status" data-status aria-live="polite"></div>

      <div class="compose">
        <textarea data-input rows="1" placeholder="Ask about buses, bookings or AbhiCash"
                  aria-label="Message the AbhiBus assistant"></textarea>
        <button class="send" type="button" data-send aria-label="Send message">${ICON_SEND}</button>
      </div>
    `;
    root.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    const logEl = $('[data-log]');
    const statusEl = $('[data-status]');
    const subEl = $('[data-sub]');
    const inputEl = $('[data-input]');
    const sendEl = $('[data-send]');
    const suggestionsEl = $('[data-suggestions]');
    const jumpEl = $('[data-jump]');
    const expandEl = $('[data-expand]');

    let isOpen = false;
    let isBusy = false;
    let welcomeEl = null;

    /* ---- scrolling -------------------------------------------------- */
    let pinnedToBottom = true;
    logEl.addEventListener('scroll', () => {
      const distance = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
      pinnedToBottom = distance < 48;
      jumpEl.hidden = pinnedToBottom;
    });
    function scrollToEnd(force = false) {
      if (force || pinnedToBottom) {
        logEl.scrollTop = logEl.scrollHeight;
        jumpEl.hidden = true;
      }
    }
    jumpEl.addEventListener('click', () => scrollToEnd(true));

    /* ---- wide mode --------------------------------------------------- */
    expandEl.addEventListener('click', () => {
      const wide = panel.dataset.wide === 'true';
      panel.dataset.wide = String(!wide);
      expandEl.title = wide ? 'Expand' : 'Shrink';
      scrollToEnd();
    });

    /* ---- suggestions ------------------------------------------------ */
    for (const text of SUGGESTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        if (isBusy) return;
        handlers.onSend(text);
      });
      suggestionsEl.appendChild(btn);
    }

    /* ---- composing -------------------------------------------------- */
    function autoGrow() {
      inputEl.style.height = 'auto';
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 104)}px`;
    }
    inputEl.addEventListener('input', autoGrow);

    function submit() {
      const text = inputEl.value.trim();
      if (!text || isBusy) return;
      inputEl.value = '';
      autoGrow();
      handlers.onSend(text);
    }

    sendEl.addEventListener('click', submit);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    /* ---- open / close ------------------------------------------------ */
    function open() {
      isOpen = true;
      panel.hidden = false;
      launcher.hidden = true;
      launcher.dataset.attention = 'false';
      setTimeout(() => inputEl.focus(), 30);
      scrollToEnd(true);
    }
    function close() {
      isOpen = false;
      panel.hidden = true;
      launcher.hidden = false;
      launcher.focus();
    }
    function toggle() {
      isOpen ? close() : open();
    }

    launcher.addEventListener('click', open);
    $('[data-close]').addEventListener('click', close);
    $('[data-reset]').addEventListener('click', () => {
      logEl.textContent = '';
      suggestionsEl.hidden = false;
      api.setStatus('');
      handlers.onReset();
    });

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        close();
      }
    });

    /* =================================================================
     * Public API
     * =============================================================== */

    const api = {
      mount() {
        (document.body || document.documentElement).appendChild(host);
        return api;
      },

      destroy() {
        host.remove();
      },

      open,
      close,
      toggle,
      get isOpen() {
        return isOpen;
      },

      /** Header subtitle: session identity, or the active model. */
      setSubtitle(text) {
        subEl.textContent = text;
      },

      /** Drives the shimmer, the route marker and the send button. */
      setBusy(busy) {
        isBusy = busy;
        panel.dataset.busy = String(busy);
        sendEl.disabled = busy;
        inputEl.disabled = busy;
      },

      setStatus(text) {
        statusEl.textContent = text || '';
      },

      /** Friendly empty state: shown on first open and after a reset. */
      showWelcome(name) {
        if (welcomeEl?.isConnected) welcomeEl.remove();
        welcomeEl = document.createElement('div');
        welcomeEl.className = 'welcome';

        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.innerHTML = ICON_BUS;

        const title = document.createElement('h2');
        title.textContent = name ? `Namaste, ${name}!` : 'Namaste!';

        const sub = document.createElement('p');
        sub.textContent =
          'I can find and compare buses, read seat maps and offers, track your ' +
          'bookings and AbhiCash, and answer any AbhiBus question.';

        welcomeEl.append(badge, title, sub);
        logEl.prepend(welcomeEl);
      },

      addUserMessage(text) {
        suggestionsEl.hidden = true;
        if (welcomeEl?.isConnected) welcomeEl.remove();
        const el = document.createElement('div');
        el.className = 'msg user';
        renderRichText(el, text);
        logEl.appendChild(el);
        scrollToEnd(true);
        return el;
      },

      /**
       * Open an assistant bubble that can be streamed into.
       * @returns {{append:(s:string)=>void, set:(s:string)=>void,
       *            finish:()=>void, remove:()=>void, isEmpty:()=>boolean}}
       */
      startAssistantMessage() {
        const el = document.createElement('div');
        el.className = 'msg bot pending';
        logEl.appendChild(el);
        scrollToEnd(true);

        // The bubble is created before any tools run, but the answer arrives
        // after them. Re-appending on first content keeps the log
        // chronological: activity chips, then data cards, then the answer —
        // so finishing never buries the bus card above the fold.
        const ensureLast = () => {
          if (logEl.lastElementChild !== el) logEl.appendChild(el);
        };

        let buffer = '';
        return {
          append(chunk) {
            buffer += chunk;
            el.classList.remove('pending');
            ensureLast();
            renderRichText(el, buffer);
            scrollToEnd();
          },
          set(text) {
            buffer = text;
            el.classList.remove('pending');
            ensureLast();
            renderRichText(el, buffer);
            scrollToEnd();
          },
          finish() {
            el.classList.remove('pending');
            if (!buffer.trim()) el.remove();
            scrollToEnd(true);
          },
          remove() {
            el.remove();
          },
          /** The accumulated text, for the conversation history. */
          getText() {
            return buffer;
          },
          isEmpty() {
            return buffer.trim().length === 0;
          },
        };
      },

      /**
       * Rich bus-list card rendered straight from a searchBuses tool result,
       * so the data the user sees is the data the API returned — the model's
       * prose only has to point at it. Sorted by fare; the cheapest bus (and
       * the cheapest A/C bus, when different) get badges.
       */
      addBusResults(data) {
        // Accept both the plain array and capForModel's truncated wrapper
        // ({ truncated, items: [...] }) so a large result still gets a card.
        const services = Array.isArray(data?.services)
          ? data.services
          : Array.isArray(data?.services?.items)
            ? data.services.items
            : [];
        if (!services.length) return null;

        const parseFare = (v) => {
          const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
          return Number.isFinite(n) && n > 0 ? n : Infinity;
        };
        // What the user pays: the discounted offerFare when present.
        const fareOf = (svc) => Math.min(parseFare(svc.offerFare), parseFare(svc.fare));
        const baseFareOf = (svc) => parseFare(svc.fare);
        const isAc = (svc) => {
          // Prefer the API's explicit flag when the projection found one.
          if (svc.isAc === true || svc.isAc === 1 || svc.isAc === '1' || svc.isAc === 'Y') return true;
          if (svc.isAc === false || svc.isAc === 0 || svc.isAc === '0' || svc.isAc === 'N') return false;
          const type = String(svc.busType ?? '');
          return /\bA\/?C\b/i.test(type) && !/non\s*-?\s*a\/?c/i.test(type);
        };
        const inr = (n) =>
          Number.isFinite(n) && n !== Infinity
            ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
            : '—';
        const duration = (svc) => {
          const raw = svc.durationMinutes;
          // The live API sends "11:00:00" (HH:MM:SS); older shapes send minutes.
          const hms = String(raw ?? '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
          const mins = hms ? Number(hms[1]) * 60 + Number(hms[2]) : Number(raw);
          if (!Number.isFinite(mins) || mins <= 0) return '';
          if (mins < 60) return `${mins}m`;
          return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
        };
        // Times arrive as "21:30", "8:30 PM", "2026-08-12 21:30:00" or epoch
        // ms — always show 24-hour HH:MM, matching the model's prose.
        const fmtTime = (value) => {
          const s = String(value ?? '').trim();
          if (!s) return '--:--';
          // 12-hour clock: convert, never just strip the meridiem.
          const ampm = s.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])\.?\s*\.?[Mm]\b/);
          if (ampm) {
            let hours = Number(ampm[1]) % 12;
            if (/p/i.test(ampm[3])) hours += 12;
            return `${String(hours).padStart(2, '0')}:${ampm[2]}`;
          }
          const m = s.match(/\b(\d{1,2}:\d{2})(?::\d{2})?\b/);
          if (m) return m[1].padStart(5, '0');
          const n = Number(s);
          if (Number.isFinite(n) && n > 1e11) {
            const d = new Date(n);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          }
          return s.slice(0, 8);
        };

        const sorted = [...services].sort((a, b) => fareOf(a) - fareOf(b));
        const cheapest = sorted.find((s) => fareOf(s) !== Infinity) ?? null;
        const cheapestAc = sorted.find((s) => isAc(s) && fareOf(s) !== Infinity) ?? null;

        const card = document.createElement('div');
        card.className = 'buses';

        /* head: route + count */
        const head = document.createElement('div');
        head.className = 'buses-head';
        const routeEl = document.createElement('span');
        routeEl.className = 'buses-route';
        routeEl.textContent = data.route || 'Buses';
        const metaEl = document.createElement('span');
        metaEl.className = 'buses-meta';
        metaEl.textContent = [
          data.date,
          `${data.totalServices ?? services.length} ${data.filter ? `${data.filter} ` : ''}buses`,
        ]
          .filter(Boolean)
          .join(' · ');
        head.append(routeEl, metaEl);
        card.appendChild(head);

        /* rows — collapsed to the top few so the card and the streamed answer
           share the viewport; the expander reveals the rest. */
        const VISIBLE_ROWS = 8;
        const list = document.createElement('div');
        list.className = 'buses-list';
        let rowIndex = 0;

        for (const svc of sorted) {
          const row = document.createElement('div');
          row.className = 'bus';
          if (rowIndex >= VISIBLE_ROWS) row.dataset.extra = 'true';
          rowIndex++;
          const isBest = svc === cheapest;
          if (isBest) row.dataset.best = 'true';

          const op = document.createElement('div');
          op.className = 'op';
          op.textContent = String(svc.operator ?? 'Unknown operator');

          const fare = document.createElement('div');
          fare.className = 'fare';
          const paying = fareOf(svc);
          const base = baseFareOf(svc);
          if (base !== Infinity && paying < base) {
            // Discounted: show the old price struck through above the real one.
            const was = document.createElement('s');
            was.className = 'was';
            was.textContent = inr(base);
            fare.appendChild(was);
          }
          fare.appendChild(document.createTextNode(inr(paying)));
          const seats = Number(svc.seatsAvailable);
          if (Number.isFinite(seats) && seats > 0) {
            const small = document.createElement('small');
            small.textContent = `${seats} seats`;
            fare.appendChild(small);
          }

          const type = document.createElement('div');
          type.className = 'type';
          type.textContent = String(svc.busType ?? '');

          const times = document.createElement('div');
          times.className = 'times';
          const dep = document.createElement('span');
          dep.textContent = fmtTime(svc.departure);
          const dash = document.createElement('span');
          dash.className = 'dash';
          const arr = document.createElement('span');
          arr.textContent = fmtTime(svc.arrival);
          times.append(dep, dash, arr);
          const dur = duration(svc);
          if (dur) {
            const durEl = document.createElement('span');
            durEl.className = 'dur';
            durEl.textContent = dur;
            times.appendChild(durEl);
          }

          const tags = document.createElement('div');
          tags.className = 'tags';
          if (isBest) {
            const tag = document.createElement('span');
            tag.className = 'tag best';
            tag.textContent = 'Lowest fare';
            tags.appendChild(tag);
          } else if (svc === cheapestAc && cheapestAc !== cheapest) {
            const tag = document.createElement('span');
            tag.className = 'tag best';
            tag.textContent = 'Cheapest A/C';
            tags.appendChild(tag);
          }
          if (isAc(svc)) {
            const tag = document.createElement('span');
            tag.className = 'tag ac';
            tag.textContent = 'A/C';
            tags.appendChild(tag);
          }
          if (Number.isFinite(seats) && seats > 0 && seats <= 5) {
            const tag = document.createElement('span');
            tag.className = 'tag seats-low';
            tag.textContent = `Only ${seats} left`;
            tags.appendChild(tag);
          }
          if (svc.rating) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = `★ ${svc.rating}`;
            tags.appendChild(tag);
          }

          // Per-bus seat selection: opens the site's seat page in a NEW TAB.
          // The page's serviceKey query param takes the buslist *serviceId*
          // (verified live — the buslist serviceKey value is rejected).
          const seatServiceId = svc.serviceId ?? null;
          const seatUrl = (() => {
            const q = (v) => encodeURIComponent(String(v));
            if (seatServiceId && svc.operatorId && data.sourceId && data.destinationId && data.date) {
              return (
                'https://www.abhibus.com/seat-layout-web/' +
                `?sourceid=${q(data.sourceId)}&destinationid=${q(data.destinationId)}` +
                `&jdate=${q(data.date)}&serviceKey=${q(seatServiceId)}` +
                `&operatorId=${q(svc.operatorId)}&isReturnJourney=0`
              );
            }
            return typeof data.searchUrl === 'string' &&
              data.searchUrl.startsWith('https://www.abhibus.com/')
              ? data.searchUrl
              : null;
          })();

          if (seatUrl) {
            const seatsBtn = document.createElement('button');
            seatsBtn.type = 'button';
            seatsBtn.className = 'seats-btn';
            seatsBtn.textContent = 'Select seats ↗';
            seatsBtn.dataset.url = seatUrl;
            seatsBtn.setAttribute(
              'aria-label',
              `Select seats on ${svc.operator ?? 'this bus'} (opens abhibus.com)`,
            );
            seatsBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              window.open(seatUrl, '_blank', 'noopener');
            });
            tags.appendChild(seatsBtn);
          }

          row.append(op, fare, type, times);
          if (tags.childElementCount) row.appendChild(tags);
          list.appendChild(row);
        }
        card.appendChild(list);

        /* expander for the collapsed rows */
        if (sorted.length > VISIBLE_ROWS) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'buses-more';
          more.textContent = `Show all ${sorted.length} buses ▾`;
          more.addEventListener('click', () => {
            const expanded = card.dataset.expanded === 'true';
            card.dataset.expanded = String(!expanded);
            more.textContent = expanded
              ? `Show all ${sorted.length} buses ▾`
              : 'Show fewer ▴';
          });
          card.appendChild(more);
        }

        /* foot: truncation note */
        const total = Number(data.totalServices);
        if (Number.isFinite(total) && total > services.length) {
          const foot = document.createElement('div');
          foot.className = 'buses-foot';
          foot.textContent = `Showing ${services.length} of ${total} · sorted by fare`;
          card.appendChild(foot);
        }

        /* open the real results page in a new tab. The URL is built by the
           registry from the exact search arguments — only same-site URLs
           are ever rendered. */
        if (
          typeof data.searchUrl === 'string' &&
          data.searchUrl.startsWith('https://www.abhibus.com/')
        ) {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'buses-open';
          open.textContent = 'Open these results on AbhiBus ↗';
          open.setAttribute('aria-label', 'Open these bus results on abhibus.com in a new tab');
          open.addEventListener('click', () => {
            window.open(data.searchUrl, '_blank', 'noopener');
          });
          card.appendChild(open);
        }

        logEl.appendChild(card);
        scrollToEnd();
        return card;
      },

      /**
       * Seat map card rendered from a getSeatLayout result: available seats
       * grouped by deck, fares on each seat, ladies seats marked.
       */
      addSeatMap(data) {
        const seats = Array.isArray(data?.seats) ? data.seats : [];
        const card = document.createElement('div');
        card.className = 'buses seatmap';

        const head = document.createElement('div');
        head.className = 'buses-head';
        const title = document.createElement('span');
        title.className = 'buses-route';
        title.textContent = [data.operator, data.busType].filter(Boolean).join(' · ') || 'Seat map';
        const meta = document.createElement('span');
        meta.className = 'buses-meta';
        meta.textContent = `${data.availableSeats ?? seats.length}/${data.totalSeats ?? seats.length} free`;
        head.append(title, meta);
        card.appendChild(head);

        if (!seats.length) {
          const empty = document.createElement('div');
          empty.className = 'seatmap-empty';
          empty.textContent =
            'No open seats came back for this bus — either it is filling fast or the ' +
            'operator\'s seat chart is napping 😴. Try another bus!';
          card.appendChild(empty);
        } else {
          const decks = new Map();
          for (const seat of seats) {
            const deck = seat.deck || 'Seats';
            if (!decks.has(deck)) decks.set(deck, []);
            decks.get(deck).push(seat);
          }
          for (const deckName of ['Lower', 'Upper', 'Seats']) {
            const deckSeats = decks.get(deckName);
            if (!deckSeats?.length) continue;
            const label = document.createElement('div');
            label.className = 'deck-label';
            label.textContent = `${deckName} deck`;
            card.appendChild(label);

            const grid = document.createElement('div');
            grid.className = 'seat-grid';
            for (const seat of deckSeats) {
              const chip = document.createElement('div');
              chip.className = `seat-chip${seat.ladies ? ' ladies' : ''}`;
              const num = document.createElement('span');
              num.className = 'num';
              num.textContent = String(seat.seatNumber ?? '?');
              chip.appendChild(num);
              if (seat.fare !== null && seat.fare !== undefined) {
                const price = document.createElement('span');
                price.className = 'price';
                price.textContent = `₹${Number(seat.fare).toLocaleString('en-IN')}`;
                chip.appendChild(price);
              }
              grid.appendChild(chip);
            }
            card.appendChild(grid);
          }

          const legend = document.createElement('div');
          legend.className = 'seat-legend';
          legend.textContent = data.cancellationPolicy
            ? `Pink = ladies seat · Cancellation: ${data.cancellationPolicy}`
            : 'Pink = ladies seat · fares are per seat';
          card.appendChild(legend);
        }

        if (
          typeof data.searchUrl === 'string' &&
          data.searchUrl.startsWith('https://www.abhibus.com/')
        ) {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'buses-open';
          open.textContent = 'Book these seats on AbhiBus ↗';
          open.addEventListener('click', () => window.open(data.searchUrl, '_blank', 'noopener'));
          card.appendChild(open);
        }

        logEl.appendChild(card);
        scrollToEnd(true);
        return card;
      },

      /** Ticket-stub chip showing a tool running, then its outcome. */
      addToolChip(label) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.dataset.state = 'running';
        const dot = document.createElement('span');
        dot.className = 'dot';
        const text = document.createElement('span');
        text.textContent = label;
        chip.append(dot, text);
        logEl.appendChild(chip);
        scrollToEnd();

        return {
          done(finalLabel) {
            chip.dataset.state = 'done';
            if (finalLabel) text.textContent = finalLabel;
          },
          failed(finalLabel) {
            chip.dataset.state = 'failed';
            if (finalLabel) text.textContent = finalLabel;
          },
        };
      },

      /**
       * PHASE 2: the logged-out state. One clear sentence, one clear action.
       */
      showLoginRequired(message) {
        suggestionsEl.hidden = true;
        const card = document.createElement('div');
        card.className = 'card auth';

        const title = document.createElement('h2');
        title.textContent = 'Sign in to continue';

        const body = document.createElement('p');
        body.textContent =
          message ||
          'This needs your AbhiBus account. Your session has expired or you are not signed in.';

        const actions = document.createElement('div');
        actions.className = 'actions';

        const login = document.createElement('button');
        login.type = 'button';
        login.className = 'btn primary';
        login.textContent = 'Click here to Log In';
        login.addEventListener('click', () => handlers.onLogin());

        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn ghost';
        retry.textContent = 'I have signed in';
        retry.addEventListener('click', () => {
          card.remove();
          handlers.onRetry?.();
        });

        actions.append(login, retry);
        card.append(title, body, actions);
        logEl.appendChild(card);
        scrollToEnd(true);
        return card;
      },

      showError(message, { retry = false } = {}) {
        const card = document.createElement('div');
        card.className = 'card error';

        const title = document.createElement('h2');
        title.textContent = 'That did not work';

        const body = document.createElement('p');
        body.textContent = message;

        card.append(title, body);

        if (retry) {
          const actions = document.createElement('div');
          actions.className = 'actions';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn ghost';
          btn.textContent = 'Try again';
          btn.addEventListener('click', () => {
            card.remove();
            handlers.onRetry?.();
          });
          actions.appendChild(btn);
          card.appendChild(actions);
        }

        logEl.appendChild(card);
        scrollToEnd(true);
        return card;
      },

      /** Small grey line under the compose box, e.g. latency of the fast path. */
      setFootnote(text) {
        let note = panel.querySelector('.footnote');
        if (!text) {
          note?.remove();
          return;
        }
        if (!note) {
          note = document.createElement('div');
          note.className = 'footnote';
          panel.insertBefore(note, panel.querySelector('.compose'));
        }
        note.textContent = text;
      },

      /** Amber pip on the launcher when a reply lands while collapsed. */
      flagAttention() {
        if (!isOpen) launcher.dataset.attention = 'true';
      },

      clear() {
        logEl.textContent = '';
        suggestionsEl.hidden = false;
        api.setStatus('');
      },
    };

    return api;
  }

  NS.createChatUI = createChatUI;
  NS.renderRichText = renderRichText;
})();
