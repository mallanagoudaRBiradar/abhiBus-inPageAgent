/**
 * preRouter.js  —  PHASE 4 (fast path)
 * ---------------------------------------------------------------------------
 * Some questions do not need a language model. "balance?" has exactly one
 * possible intent, and answering it locally costs one same-origin fetch —
 * typically 40-90 ms, versus 1-3 s through the gateway.
 *
 * The rules are deliberately conservative. A false positive here means a wrong
 * answer with no model to catch it, so anything that looks even slightly
 * compound ("balance enough for Goa tomorrow?") is handed to the LLM instead.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});
  const F = NS.formatters;

  /**
   * Ordered rules. First match wins.
   * `guard` returns false to decline the fast path and defer to the model.
   */
  const RULES = [
    {
      id: 'wallet-history',
      // Checked before `balance` so "wallet history" is not caught by it.
      test: /\b(wallet\s*(history|transactions?|statement)|transaction\s*history|passbook)\b/i,
      tool: 'getWalletHistory',
      args: () => ({}),
      render: (r) => F.formatWalletHistory(r),
    },
    {
      id: 'balance',
      test: /\b(balance|abhicash|abhi\s*cash|wallet)\b/i,
      tool: 'getAbhiCashBalance',
      args: () => ({}),
      render: (r) => F.formatBalance(r),
    },
    {
      id: 'bookings',
      test: /\b(booking|bookings|ticket|tickets|pnr|upcoming|my\s*trips?)\b/i,
      tool: 'getBookings',
      args: () => ({ bookType: 'Mobile' }),
      // The prompt matters: "upcoming trips" must not present past trips.
      render: (r, prompt) => F.formatBookings(r, prompt),
    },
    {
      id: 'offers',
      test: /\b(offer|offers|coupon|coupons|discount|discounts|promo\s*code)\b/i,
      tool: 'getSeatLayoutOffers',
      // Offers are per-service, so this only fires on a seat-layout page where
      // the service context can be read straight out of the URL.
      guard: () => readServiceContext() !== null,
      args: () => readServiceContext(),
      render: (r) => F.formatOffers(r),
    },
  ];

  /**
   * Words that turn a simple lookup into a reasoning task. If any appear, the
   * model handles it — comparisons, conditionals and multi-step asks are
   * exactly what the fast path is bad at.
   */
  const COMPLEXITY_MARKERS =
    /\b(compare|cheapest|best|should|recommend|why|how\s+do|explain|instead|versus|vs\.?|enough|if\s|and\s+also|then\s)\b/i;

  function readServiceContext() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = NS.AbhiBusAPIRegistry.cityIdsFromUrl();

    const serviceKey = params.get('serviceKey') || params.get('service_key');
    const operatorId = params.get('operatorId') || params.get('operator_id');
    const sourceId = params.get('sourceId') || fromUrl?.sourceId;
    const destinationId = params.get('destinationId') || fromUrl?.destinationId;
    const jdate = params.get('jdate') || params.get('date');

    if (!serviceKey || !operatorId || !sourceId || !destinationId || !jdate) return null;

    return {
      serviceKey: String(serviceKey),
      operatorId: String(operatorId),
      sourceId: String(sourceId),
      destinationId: String(destinationId),
      jdate: String(jdate),
      travelPartnerKey: params.get('travelPartnerKey') || '',
    };
  }

  /**
   * @param {string} prompt
   * @returns {{id:string, tool:string, args:object, render:(r:any)=>string}|null}
   */
  function match(prompt) {
    const text = String(prompt || '').trim();

    // Long prompts are almost never simple lookups.
    if (!text || text.length > 120) return null;
    if (COMPLEXITY_MARKERS.test(text)) return null;

    // Two distinct intents in one sentence needs a model to sequence them.
    const hits = RULES.filter((rule) => rule.test.test(text));
    if (hits.length !== 1) return null;

    const rule = hits[0];
    if (rule.guard && !rule.guard()) return null;

    return { id: rule.id, tool: rule.tool, args: rule.args(), render: rule.render };
  }

  /**
   * Run the fast path.
   * @returns {Promise<{handled:boolean, text?:string, error?:object, elapsedMs?:number}>}
   */
  async function run(prompt) {
    const rule = match(prompt);
    if (!rule) return { handled: false };

    const startedAt = performance.now();
    const outcome = await NS.AbhiBusAPIRegistry.execute(rule.tool, rule.args);
    const elapsedMs = Math.round(performance.now() - startedAt);

    if (!outcome.ok) {
      // Let the caller decide: UNAUTHENTICATED shows the login card, anything
      // else quietly falls through to the model, which may still cope.
      return { handled: false, error: outcome.error, elapsedMs };
    }

    let text;
    try {
      text = rule.render(outcome.result, String(prompt || ''));
    } catch {
      return { handled: false, elapsedMs };
    }

    // A formatter that cannot make sense of the payload returns null; hand the
    // question to the model rather than showing a dead-end apology.
    if (!text) return { handled: false, elapsedMs };

    NS.log(`pre-route "${rule.id}" answered in ${elapsedMs}ms`);
    return { handled: true, text, elapsedMs, rule: rule.id };
  }

  NS.preRouter = { match, run, readServiceContext };
})();
