/**
 * apiRegistry.js  —  PHASE 1
 * ---------------------------------------------------------------------------
 * Every AbhiBus endpoint the agent can reach, expressed as an async JS handler.
 *
 * DESIGN RULES
 *  1. Every request uses `credentials: 'include'`, so the user's live session
 *     cookies ride along. We never store, copy or transmit those cookies —
 *     the browser attaches them, the request is same-origin, done.
 *  2. The bearer token AbhiBus itself sends is read out of the `__abrs_auth_state`
 *     cookie at call time. It is short-lived (~2h) and refreshed by the site.
 *  3. Any 401, or any payload that smells like an auth failure, throws an error
 *     whose `.code` is exactly 'UNAUTHENTICATED'. Nothing else in the codebase
 *     needs to know how AbhiBus signals a logged-out session.
 *  4. Responses are projected down to the fields that matter before they reach
 *     a model. A bus-list response can be 400 KB; a model needs about 4 KB of it.
 *
 * Handler names here MUST match `TOOL_DEFINITIONS` in backend/src/tools.ts.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});
  const { CONFIG, API_EXP } = NS;

  /* =====================================================================
   * Errors
   * =================================================================== */

  class AbhiBusApiError extends Error {
    /**
     * @param {'UNAUTHENTICATED'|'NETWORK'|'HTTP_ERROR'|'TIMEOUT'|'UNKNOWN_TOOL'|'UNKNOWN'} code
     */
    constructor(code, message, status) {
      super(message);
      this.name = 'AbhiBusApiError';
      this.code = code;
      if (status !== undefined) this.status = status;
    }
  }

  /** The standard error object required by the brief. */
  function unauthenticated(detail = 'AbhiBus session is missing or expired.') {
    return new AbhiBusApiError(NS.UNAUTHENTICATED, detail, 401);
  }

  /* =====================================================================
   * Session helpers
   * =================================================================== */

  function readCookie(name) {
    const prefix = `${name}=`;
    for (const part of document.cookie.split('; ')) {
      if (part.startsWith(prefix)) {
        return decodeURIComponent(part.slice(prefix.length));
      }
    }
    return '';
  }

  /** The JWT the AbhiBus SPA puts in its own Authorization header. */
  function getAuthToken() {
    return readCookie('__abrs_auth_state');
  }

  /** CleverTap device id — AbhiBus includes it in every payload; so do we. */
  function getClevertapId() {
    return readCookie('WZRK_G') || '';
  }

  /** Cheap, synchronous "is there a session at all" check. */
  function hasSession() {
    return getAuthToken().length > 0;
  }

  /**
   * Decode the JWT payload for display only (greeting the user by name).
   * Never used for a security decision — the server is the only authority.
   */
  function getSessionProfile() {
    const token = getAuthToken();
    if (!token) return null;
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      const claims = JSON.parse(json);
      return {
        firstName: claims.firstName || '',
        email: claims.email || '',
        phone: claims.phone || '',
        expiresAt: claims.exp ? claims.exp * 1000 : null,
        expired: claims.exp ? claims.exp * 1000 < Date.now() : false,
      };
    } catch {
      return null;
    }
  }

  /* =====================================================================
   * Core request helper
   * =================================================================== */

  /**
   * @param {string} path            e.g. '/wap/abhicash'
   * @param {object} options
   * @param {'GET'|'POST'} [options.method]
   * @param {object|string} [options.body]
   * @param {'json'|'form'} [options.encoding]
   * @param {'nextgenmweb'|'nextgenweb'} [options.appName]
   * @param {boolean} [options.requiresAuth]
   */
  async function request(path, options = {}) {
    const {
      method = 'POST',
      body,
      encoding = 'json',
      appName = 'nextgenmweb',
      accept = 'application/json, text/plain, */*',
      requiresAuth = false,
    } = options;

    const token = getAuthToken();

    // Fail fast rather than burning a round trip on a request we know is dead.
    if (requiresAuth && !token) throw unauthenticated('No AbhiBus session cookie found.');

    /** @type {Record<string,string>} */
    const headers = { accept, 'x-app-name': appName };
    if (token) headers.authorization = `Bearer ${token}`;

    let payload;
    if (method !== 'GET' && body !== undefined) {
      if (encoding === 'form') {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        payload = toFormBody(body);
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }

    // origin / referer / user-agent / sec-* are forbidden header names: the
    // browser sets them itself and silently drops any value we supply.

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.apiTimeoutMs);

    let res;
    try {
      res = await fetch(`${CONFIG.apiOrigin}${path}`, {
        method,
        headers,
        body: payload,
        // THE important line: attach the live AbhiBus session.
        credentials: 'include',
        mode: 'cors',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new AbhiBusApiError('TIMEOUT', `${path} timed out after ${CONFIG.apiTimeoutMs}ms`);
      }
      throw new AbhiBusApiError('NETWORK', `${path} failed: ${err && err.message}`);
    } finally {
      clearTimeout(timer);
    }

    // ---- Global rule: 401 always becomes UNAUTHENTICATED --------------
    if (res.status === 401 || res.status === 403) {
      throw unauthenticated(`AbhiBus returned ${res.status} for ${path}.`);
    }

    const text = await res.text();
    const data = safeParse(text);

    if (!res.ok) {
      throw new AbhiBusApiError(
        'HTTP_ERROR',
        `${path} returned HTTP ${res.status}: ${String(text).slice(0, 200)}`,
        res.status,
      );
    }

    // ---- Global rule: an auth-failure *payload* counts as a 401 -------
    if (looksUnauthenticated(data)) {
      throw unauthenticated(`AbhiBus rejected the session on ${path}.`);
    }

    NS.log('API', path, data);
    return data;
  }

  function toFormBody(obj) {
    if (typeof obj === 'string') return obj;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) continue;
      params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return params.toString();
  }

  function safeParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: String(text).slice(0, 2000) };
    }
  }

  /**
   * AbhiBus does not always use HTTP status codes for auth failures — some
   * endpoints return 200 with a failure envelope. Detect the common shapes.
   */
  function looksUnauthenticated(data) {
    if (!data || typeof data !== 'object') return false;

    const code = data.statusCode ?? data.status_code ?? data.code;
    if (code === 401 || code === '401') return true;

    const message = String(
      data.message ?? data.msg ?? data.error ?? data.errorMessage ?? '',
    ).toLowerCase();
    if (!message) return false;

    return (
      message.includes('unauthor') ||
      message.includes('unauthenticated') ||
      message.includes('invalid token') ||
      message.includes('token expired') ||
      message.includes('session expired') ||
      message.includes('please login') ||
      message.includes('please log in')
    );
  }

  /* =====================================================================
   * Payload shaping — keep the model's context window survivable
   * =================================================================== */

  /** Depth-first search for the first array of objects under any of `keys`. */
  function findArray(data, keys) {
    if (!data || typeof data !== 'object') return null;

    // Some endpoints (/wap/Passengers) return a bare top-level array.
    if (Array.isArray(data)) {
      return data.length && typeof data[0] === 'object' ? data : null;
    }

    for (const key of keys) {
      const value = data[key];
      if (Array.isArray(value)) return value;
    }
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value;
      if (value && typeof value === 'object') {
        const nested = findArray(value, keys);
        if (nested) return nested;
      }
    }
    return null;
  }

  /** Return the first defined value among `keys`. */
  function pick(obj, keys) {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    }
    return undefined;
  }

  /** "₹1,250.00" / "1250" / 1250 -> 1250. Anything else -> null. */
  function toAmount(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const num = Number(value.replace(/[₹,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Like `pick`, but searches nested objects breadth-first (the live buslist
   * API nests fare under `fares.fare` and times under `timings.*`). Returns
   * the first scalar found under any of `keys`.
   */
  function deepPick(root, keys, maxDepth = 4) {
    const queue = [[root, 0]];
    const seen = new Set();
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const hit = pick(node, keys);
      if (hit !== undefined && typeof hit !== 'object') return hit;
      if (depth < maxDepth) {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') queue.push([value, depth + 1]);
        }
      }
    }
    return undefined;
  }

  /**
   * Breadth-first search of a whole response for the first numeric value under
   * any of `priorityKeys` (checked in order at each node), falling back to the
   * first key matching `fallbackPattern`. Different AbhiBus builds nest the
   * wallet balance at different depths, so a fixed path breaks silently —
   * this does not.
   */
  function deepFindAmount(root, priorityKeys, fallbackPattern) {
    const queue = [root];
    const seen = new Set();
    let fallback = null;

    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      for (const key of priorityKeys) {
        const amount = toAmount(node[key]);
        if (amount !== null) return amount;
      }
      for (const [key, value] of Object.entries(node)) {
        if (fallback === null && fallbackPattern.test(key)) {
          const amount = toAmount(value);
          if (amount !== null) fallback = amount;
        }
        if (value && typeof value === 'object') queue.push(value);
      }
    }
    return fallback;
  }

  /**
   * Last line of defence: stringify, and if it is still too big, drop array
   * tails until it fits. Guarantees no single tool result can blow the budget.
   */
  function capForModel(value, maxChars = CONFIG.maxToolResultChars) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch {
      return { note: 'Result could not be serialised.' };
    }
    if (json.length <= maxChars) return value;

    if (Array.isArray(value)) {
      const trimmed = [];
      let size = 2;
      for (const item of value) {
        const chunk = JSON.stringify(item);
        if (size + chunk.length > maxChars) break;
        trimmed.push(item);
        size += chunk.length + 1;
      }
      return { truncated: true, shownItems: trimmed.length, totalItems: value.length, items: trimmed };
    }

    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        out[key] = Array.isArray(inner) ? capForModel(inner, Math.floor(maxChars / 2)) : inner;
      }
      const retry = JSON.stringify(out);
      if (retry.length <= maxChars) return out;
      return { truncated: true, preview: retry.slice(0, maxChars) };
    }

    return { truncated: true, preview: json.slice(0, maxChars) };
  }

  /* =====================================================================
   * Handlers — one per row of ABHIBUS_public_API_-_Sheet1.csv
   * =================================================================== */

  /* ---- 1. POST /wap/abhicash --------------------------------------- */
  async function getAbhiCashBalance() {
    const data = await request('/wap/abhicash', {
      method: 'POST',
      requiresAuth: true,
      appName: 'nextgenmweb',
      body: {
        method: 'transactions',
        api_exp: API_EXP,
        clevertapID: getClevertapId(),
      },
    });

    // Live shape: { promotional: {balance}, non_promotional: {balance},
    // wallet_balance, message } — read it directly, deep-search as fallback.
    const root = data?.data ?? data ?? {};
    const promoBalance = toAmount(root?.promotional?.balance);
    const nonPromoBalance = toAmount(root?.non_promotional?.balance);
    const balance =
      toAmount(root.wallet_balance) ??
      (promoBalance !== null || nonPromoBalance !== null
        ? (promoBalance ?? 0) + (nonPromoBalance ?? 0)
        : deepFindAmount(
            root,
            ['usableBalance', 'totalBalance', 'walletBalance', 'abhicash', 'balance'],
            /balance|abhicash/i,
          ));

    return capForModel({
      balance,
      promoBalance,
      nonPromoBalance,
      // e.g. "5% promotional abhicash can be redeemed (...)" — worth surfacing.
      redemptionNote: typeof root.message === 'string' ? root.message : undefined,
      currency: 'INR',
    });
  }

  /* ---- 2. POST /wap/getWallet (form-urlencoded) --------------------- */
  async function getWalletHistory(args = {}) {
    const data = await request('/wap/getWallet', {
      method: 'POST',
      encoding: 'form',
      requiresAuth: true,
      appName: 'nextgenmweb',
      body: {
        method: 'transactions',
        transaction_id: args.transactionId ?? '',
        doFormatDate: '1',
        mode: args.mode ?? '1',
        api_exp: API_EXP, // URLSearchParams JSON-encodes this automatically
        clevertapID: getClevertapId(),
      },
    });

    const rows = findArray(data, ['transactions', 'walletHistory', 'history', 'data', 'list']) ?? [];

    return capForModel({
      count: rows.length,
      walletBalance: toAmount(data?.wallet_balance),
      // "1" when the endpoint has more pages of history to fetch.
      canLoadMore: data?.canLoadMore === '1' || data?.canLoadMore === 1,
      note: rows.length === 0 && typeof data?.message === 'string' ? data.message : undefined,
      transactions: rows.slice(0, 40).map((row) => ({
        date: pick(row, ['date', 'transactionDate', 'created_at', 'txnDate']),
        amount: pick(row, ['amount', 'txnAmount', 'value']),
        type: pick(row, ['type', 'txnType', 'transactionType', 'creditDebit']),
        description: pick(row, ['description', 'remarks', 'narration', 'title']),
        balanceAfter: pick(row, ['balance', 'closingBalance', 'runningBalance']),
        reference: pick(row, ['transaction_id', 'transactionId', 'refNo', 'ticketNo']),
      })),
    });
  }

  /**
   * The site's own results URL for a search, e.g.
   * /bus_search/Goa/102/Pune/51/11-08-2026/O — rendered as an "open on
   * AbhiBus" button under the results card. Multi-word city names use
   * hyphens, matching how the site itself writes them.
   */
  function buildBusSearchUrl(args) {
    const seg = (name) => encodeURIComponent(String(name ?? '').trim().replace(/\s+/g, '-'));
    const [y, m, d] = String(args.jdate ?? '').split('-');
    if (!y || !m || !d) return undefined;
    // Stay on the subdomain the user is already on (www / web / m): the chat
    // snapshot lives in per-origin sessionStorage, so a cross-subdomain jump
    // would silently lose the conversation.
    const origin = /(^|\.)abhibus\.com$/i.test(window.location.hostname)
      ? window.location.origin
      : CONFIG.apiOrigin;
    return (
      `${origin}/bus_search/${seg(args.source)}/${Number(args.sourceId)}` +
      `/${seg(args.destination)}/${Number(args.destinationId)}/${d}-${m}-${y}/O`
    );
  }

  /**
   * Bus-type constraint matcher for searchBuses' optional `filter` arg.
   * Understands "ac", "non ac", "sleeper", "seater", "volvo" and combinations
   * ("non ac sleeper").
   */
  function busTypeMatches(svc, filterRaw) {
    const f = String(filterRaw).toLowerCase();
    const type = String(svc.busType ?? '').toLowerCase();
    const typeIsNonAc = /non\s*-?\s*a\/?c/.test(type);
    const typeIsAc = !typeIsNonAc && /\ba\/?c\b|\bac\b/.test(type);

    if (/non\s*-?\s*a\/?c/.test(f)) {
      if (!typeIsNonAc) return false;
    } else if (/\ba\/?c\b|\bac\b/.test(f)) {
      if (!typeIsAc) return false;
    }
    if (/sleeper/.test(f) && !/sleeper/.test(type)) return false;
    if (/seater/.test(f) && !/seater/.test(type)) return false;
    if (/volvo/.test(f) && !/volvo/.test(type)) return false;
    return true;
  }

  /** Departure hour (0-23) from whatever shape the API sent, else null. */
  function departureHour(svc) {
    const s = String(svc.departure ?? '');
    const ampm = s.match(/(\d{1,2})(?::\d{2})?\s*([ap])\.?\s*\.?m/i);
    if (ampm) {
      let hours = Number(ampm[1]) % 12;
      if (/p/i.test(ampm[2])) hours += 12;
      return hours;
    }
    const hm = s.match(/\b(\d{1,2}):\d{2}/);
    if (hm) return Number(hm[1]);
    const n = Number(s);
    if (Number.isFinite(n) && n > 1e11) return new Date(n).getHours();
    return null;
  }

  /**
   * Departure-time constraint for searchBuses' `filter` arg ("evening",
   * "morning ac sleeper", "late night"). Mirrors the windows the results
   * page offers: Before 10 AM / 10 AM-5 PM / 5 PM-11 PM / After 11 PM.
   * A service whose departure cannot be parsed is kept, not dropped.
   */
  function timeWindowMatches(svc, filterRaw) {
    const f = String(filterRaw).toLowerCase();
    const windows = [];
    const lateNight = /late\s*night|after\s*11|midnight/.test(f);
    if (lateNight) windows.push([23, 24], [0, 4]);
    if (/early\s*morning|morning|before\s*10/.test(f)) windows.push([4, 10]);
    if (/afternoon|mid\s*-?\s*day|noon/.test(f)) windows.push([10, 17]);
    if (/evening|tonight/.test(f) || (!lateNight && /\bnight\b/.test(f))) windows.push([17, 23]);
    if (!windows.length) return true; // no time words in the filter

    const hour = departureHour(svc);
    if (hour === null) return true;
    return windows.some(([from, to]) => hour >= from && hour < to);
  }

  /* ---- 3. POST /buslist/v3/services --------------------------------- */
  async function searchBuses(args = {}) {
    const required = ['source', 'sourceId', 'destination', 'destinationId', 'jdate'];
    const missing = required.filter((key) => args[key] === undefined || args[key] === '');
    if (missing.length) {
      return { error: 'MISSING_ARGUMENTS', missing, hint: 'Call resolveCityIds first.' };
    }

    // SHOW_BUS_LIST_UI=no is single-API-call mode: the extension does not
    // fetch the bus list AT ALL. The results page — which the interface is
    // about to open in this tab with the user's sort/filters auto-applied —
    // makes the one and only buslist call. The stub tells the model exactly
    // what it may and may not say without live data in hand.
    if (NS.CONFIG.showBusListUi === false) {
      return {
        route: `${args.source} → ${args.destination}`,
        date: String(args.jdate),
        ...(args.filter ? { filter: String(args.filter) } : {}),
        sourceId: Number(args.sourceId),
        destinationId: Number(args.destinationId),
        searchUrl: buildBusSearchUrl(args),
        ...(args.operator ? { operatorFilter: String(args.operator) } : {}),
        fetchSkipped: true,
        note:
          'Bus-list display is disabled by configuration, so this tool did NOT ' +
          'fetch live fares. The live results page is opening on the user\'s ' +
          'screen right now with their requested sort/filters applied. Answer in ' +
          'ONE short sentence that the results are loading on the page (mention ' +
          'the applied sort/filter if any). Do NOT invent fares, times, operators ' +
          'or bus counts — you have none.',
      };
    }

    const data = await request('/buslist/v3/services', {
      method: 'POST',
      accept: '*/*',
      appName: 'nextgenweb',
      body: {
        source: String(args.source),
        sourceid: Number(args.sourceId),
        destination: String(args.destination),
        destinationid: Number(args.destinationId),
        jdate: String(args.jdate),
        prd: 'mobile',
        filters: '1',
        isReturnJourney: String(args.isReturnJourney ?? '0'),
        version: '105',
        api_exp: API_EXP,
        clevertapID: getClevertapId(),
      },
    });

    const services =
      findArray(data, ['serviceDetailsList', 'services', 'serviceList', 'buses', 'data']) ?? [];

    // The live response keeps operator name/rating in a separate top-level
    // map keyed by operatorId — services only carry the id. Join them here.
    const operatorsMap =
      data?.operators && typeof data.operators === 'object' && !Array.isArray(data.operators)
        ? data.operators
        : {};

    const projectService = (svc) => {
      // Nested shapes in the wild: fares.fare, timings.startTime, etc. —
      // deepPick handles both those and the older flat layout.
      const operatorId = deepPick(svc, ['operatorId', 'operator_id', 'travelId']);
      const op = operatorsMap[String(operatorId)] || {};
      const fare = deepPick(svc, ['fare', 'minFare', 'startingFare', 'displayFare', 'price']);
      // The price the user actually pays after flash/edge offers.
      const offerFare = deepPick(svc, ['offerPrice', 'discountedFare', 'offerFare']);

      return {
        serviceKey: deepPick(svc, ['serviceKey', 'service_key']),
        // NB: the seat-layout API's "serviceKey" field actually takes THIS id.
        serviceId: deepPick(svc, ['serviceId', 'service_id']),
        operatorId,
        operator:
          op.travelerAgentName ??
          deepPick(svc, ['travelerAgentName', 'operatorName', 'travelsName', 'travels']),
        busType: deepPick(svc, ['busType', 'busTypeName', 'coachType', 'serviceType', 'vehicleType']),
        departure: deepPick(svc, [
          'startTime', 'departureTime', 'depTime', 'sourceTime', 'boardingTime', 'startTimeStr',
        ]),
        arrival: deepPick(svc, [
          'arriveTime', 'arrivalTime', 'arrTime', 'destinationTime', 'droppingTime', 'endTime',
        ]),
        durationMinutes: deepPick(svc, [
          'duration', 'travelTime', 'journeyTime', 'travelDuration', 'journeyDuration',
        ]),
        fare,
        ...(toAmount(offerFare) !== null && toAmount(offerFare) < (toAmount(fare) ?? Infinity)
          ? { offerFare }
          : {}),
        seatsAvailable: deepPick(svc, [
          'availableSeats', 'seatsAvailable', 'availableSeatCount', 'avlSeats', 'totalSeatsAvailable',
        ]),
        isAc: deepPick(svc, ['isAC', 'isAc', 'acFlag']),
        rating: op.rating ?? deepPick(svc, ['rating', 'avgRating', 'operatorRating']),
        travelPartnerKey:
          op.travelPartnerKey ?? deepPick(svc, ['travelPartnerKey', 'partnerKey']),
      };
    };

    const projected = services.map(projectService);

    // Optional constraints from the model ("evening ac sleeper", "non ac",
    // "vrl only"...) so the card shows what the user actually asked for.
    // Operator matching is a fuzzy substring — "vrl" hits "VRL Travels".
    const wantedOperator = String(args.operator ?? '').trim().toLowerCase();
    const operatorMatches = (svc) =>
      !wantedOperator || String(svc.operator ?? '').toLowerCase().includes(wantedOperator);
    const filtered = projected.filter(
      (svc) =>
        operatorMatches(svc) &&
        (!args.filter ||
          (busTypeMatches(svc, args.filter) && timeWindowMatches(svc, args.filter))),
    );

    // Cheapest FIRST, before slicing — with 296 services, taking the API's
    // first 15 could drop the genuinely cheapest buses entirely.
    const effectiveFare = (svc) =>
      toAmount(svc.offerFare) ?? toAmount(svc.fare) ?? Infinity;
    const ranked = [...filtered].sort((a, b) => effectiveFare(a) - effectiveFare(b));

    return capForModel({
      route: `${args.source} → ${args.destination}`,
      date: args.jdate,
      ...(args.filter ? { filter: String(args.filter) } : {}),
      ...(args.operator ? { operatorFilter: String(args.operator) } : {}),
      sourceId: Number(args.sourceId),
      destinationId: Number(args.destinationId),
      searchUrl: buildBusSearchUrl(args),
      totalServices: filtered.length,
      note:
        'Fares are per-seat. offerFare, when present, is the discounted price the ' +
        'user pays — rank and quote by it. For getSeatLayout, pass each service\'s ' +
        'serviceId as the serviceKey argument.',
      // 15 is plenty for "which bus should I take"; more just wastes context.
      services: ranked.slice(0, 15),
    });
  }

  /* ---- 4. POST /wap/GetSeatLayout ----------------------------------- */
  async function getSeatLayout(args = {}) {
    const data = await request('/wap/GetSeatLayout', {
      method: 'POST',
      appName: 'nextgenmweb',
      body: {
        sourceid: String(args.sourceId ?? ''),
        destinationid: String(args.destinationId ?? ''),
        jdate: String(args.jdate ?? ''),
        // The endpoint's "serviceKey" is the buslist serviceId (verified live:
        // the buslist serviceKey value is rejected with "could not retrieve").
        serviceKey: String(args.serviceId ?? args.serviceKey ?? ''),
        prd: 'mobile',
        version: '58',
        isReturnJourney: String(args.isReturnJourney ?? '0'),
        operatorId: String(args.operatorId ?? ''),
        api_exp: API_EXP,
        clevertapID: getClevertapId(),
      },
    });

    // The seat array's key varies by operator integration — find the largest
    // array whose items look like seats (a seat number plus fare/status).
    const findSeatArray = (root) => {
      let best = null;
      const scan = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 3) return;
        for (const value of Object.values(node)) {
          if (Array.isArray(value) && value.length > 2 && typeof value[0] === 'object' && value[0]) {
            const first = value[0];
            const hasSeat = ['seatName', 'seatNumber', 'seatNo', 'seat_number', 'name'].some(
              (k) => first[k] !== undefined,
            );
            const hasMeta = ['fare', 'price', 'seatFare', 'status', 'available', 'isAvailable',
              'seatStatus', 'bookingStatus'].some((k) => first[k] !== undefined);
            if (hasSeat && hasMeta && (!best || value.length > best.length)) best = value;
          } else if (value && typeof value === 'object') {
            scan(value, depth + 1);
          }
        }
      };
      scan(data, 0);
      return best ?? [];
    };

    const seats = findSeatArray(data);

    const FREE_MARKS = new Set([true, 1, '1', 'A', 'a', 'Y', 'available', 'Available', 'AVAILABLE']);
    const truthy = (v) => v === true || v === 1 || v === '1' || v === 'Y' || v === 'true';

    const resolveDeck = (seat, seatNumber) => {
      const raw = String(pick(seat, ['deck', 'deckName', 'berth', 'level', 'zIndex']) ?? '');
      if (/up|^1$/i.test(raw)) return 'Upper';
      if (/low|^0$/i.test(raw)) return 'Lower';
      const name = String(seatNumber ?? '');
      if (/^U/i.test(name)) return 'Upper';
      if (/^L/i.test(name)) return 'Lower';
      return 'Seats';
    };

    const normalised = seats.map((seat) => {
      const seatNumber = pick(seat, ['seatName', 'seatNumber', 'seatNo', 'seat_number', 'name']);
      return {
        seatNumber,
        available: FREE_MARKS.has(pick(seat, ['available', 'isAvailable', 'seatStatus', 'status', 'bookingStatus'])),
        fare: toAmount(pick(seat, ['fare', 'price', 'seatFare', 'amount', 'netFare'])),
        deck: resolveDeck(seat, seatNumber),
        ladies: truthy(pick(seat, ['ladiesSeat', 'isLadiesSeat', 'ladies', 'isLadies', 'forFemale'])),
      };
    });

    const free = normalised.filter((s) => s.available);
    const fares = free.map((s) => s.fare).filter((n) => n !== null);

    return capForModel({
      serviceKey: args.serviceKey,
      operator: pick(data, ['travelerAgentName', 'operatorName']),
      busType: pick(data, ['busTypeName', 'busType']),
      totalSeats: normalised.length,
      availableSeats: free.length,
      minFare: fares.length ? Math.min(...fares) : null,
      // Top cancellation slab, e.g. "Rs 935 /- @ 85% refund".
      cancellationPolicy: Array.isArray(data?.cancellationsPolicy)
        ? pick(data.cancellationsPolicy[0] ?? {}, ['tl'])
        : undefined,
      // The model rarely needs 50 booked seats — send the bookable ones.
      seats: free.slice(0, 60),
    });
  }

  /* ---- 5. POST /wap/getSeatLayoutOffers ------------------------------ */
  async function getSeatLayoutOffers(args = {}) {
    const data = await request('/wap/getSeatLayoutOffers', {
      method: 'POST',
      accept: '*/*',
      appName: 'nextgenweb',
      body: {
        prd: 'mobile',
        sourceID: String(args.sourceId ?? ''),
        // NB: "destionationID" is misspelled in the live API. Do not "fix" it.
        destionationID: String(args.destinationId ?? ''),
        jDate: String(args.jdate ?? ''),
        operatorID: String(args.operatorId ?? ''),
        travelPartnerKey: String(args.travelPartnerKey ?? ''),
        api: '610',
        serviceKey: String(args.serviceKey ?? ''),
        api_exp: API_EXP,
        clevertapID: getClevertapId(),
      },
    });

    const offers = findArray(data, ['offers', 'offerList', 'coupons', 'data']) ?? [];

    return capForModel({
      count: offers.length,
      offers: offers.slice(0, 20).map((offer) => ({
        code: pick(offer, ['couponCode', 'code', 'offerCode', 'promoCode']),
        title: pick(offer, ['title', 'offerTitle', 'header', 'name']),
        description: pick(offer, ['description', 'offerDescription', 'subTitle', 'terms']),
        discount: pick(offer, ['discount', 'discountAmount', 'maxDiscount', 'value']),
        minFare: pick(offer, ['minFare', 'minAmount', 'minTransactionAmount']),
      })),
    });
  }

  /* ---- 6. GET /wap/Passengers --------------------------------------- */
  async function getSavedPassengers() {
    const data = await request('/wap/Passengers', {
      method: 'GET',
      requiresAuth: true,
      appName: 'nextgenweb',
    });

    const rows = findArray(data, ['passengers', 'passengerList', 'data', 'list']) ?? [];

    return capForModel({
      count: rows.length,
      passengers: rows.slice(0, 25).map((p) => ({
        // The live endpoint uses snake_case (first_name / last_name).
        name: [
          pick(p, ['name', 'passengerName', 'fullName', 'firstName', 'first_name']),
          pick(p, ['lastName', 'last_name']),
        ]
          .filter(Boolean)
          .join(' ')
          .trim(),
        age: pick(p, ['age', 'passengerAge']),
        gender: pick(p, ['gender', 'sex', 'passengerGender']),
        id: pick(p, ['id', 'passengerId']),
      })),
    });
  }

  /* ---- 6b. Account profile: JWT claims + saved traveller profiles ----
   * The user's own identity (name, email, phone) lives in the session JWT;
   * /wap/Passengers adds the other traveller profiles saved on the account.
   * DOB is not exposed by any captured AbhiBus endpoint.
   * ------------------------------------------------------------------- */
  async function getUserProfile() {
    const session = getSessionProfile();
    if (!session || session.expired) {
      throw unauthenticated('No active AbhiBus session for profile lookup.');
    }

    let savedPassengers = [];
    try {
      const saved = await getSavedPassengers();
      savedPassengers = Array.isArray(saved?.passengers) ? saved.passengers : [];
    } catch {
      /* traveller list is garnish — identity alone is still a good answer */
    }

    return capForModel({
      name: session.firstName || null,
      email: session.email || null,
      phone: session.phone || null,
      savedPassengers,
      note:
        'savedPassengers are the other traveller profiles saved on this account ' +
        '(shown when booking). Date of birth is not exposed by AbhiBus APIs.',
    });
  }

  /* ---- 7. POST /wap/GetBookings -------------------------------------- */
  async function getBookings(args = {}) {
    const data = await request('/wap/GetBookings', {
      method: 'POST',
      requiresAuth: true,
      appName: 'nextgenmweb',
      body: {
        booktype: String(args.bookType ?? 'Mobile'),
        api_exp: API_EXP,
        clevertapID: getClevertapId(),
      },
    });

    // The live endpoint pre-classifies: { upcoming: [], past: [], cancelled: [] }.
    // Preserve that split — flattening it caused past trips to be presented
    // as upcoming ones.
    const asRows = (value) => (Array.isArray(value) ? value : []);
    const upcoming = asRows(data?.upcoming);
    const past = asRows(data?.past);
    const cancelled = asRows(data?.cancelled);

    if (upcoming.length || past.length || cancelled.length || Array.isArray(data?.upcoming)) {
      return capForModel({
        counts: { upcoming: upcoming.length, past: past.length, cancelled: cancelled.length },
        upcoming: upcoming.slice(0, 10).map(normaliseBooking),
        past: past.slice(0, 10).map(normaliseBooking),
        cancelled: cancelled.slice(0, 10).map(normaliseBooking),
      });
    }

    // Older/unknown shapes: one flat list.
    const rows =
      findArray(data, ['bookings', 'bookingList', 'trips', 'tickets', 'data', 'list']) ?? [];
    return capForModel({
      count: rows.length,
      bookings: rows.slice(0, 25).map(normaliseBooking),
    });
  }

  /* ---- 8. POST /wap/getFailureTrips ---------------------------------- */
  async function getFailedTrips(args = {}) {
    const data = await request('/wap/getFailureTrips', {
      method: 'POST',
      requiresAuth: true,
      appName: 'nextgenmweb',
      body: {
        booktype: String(args.bookType ?? 'Mobile'),
        api_exp: API_EXP,
        clevertapID: getClevertapId(),
      },
    });

    // Live shape: { failures: [...], canLoadMore }.
    const rows =
      findArray(data, ['failures', 'trips', 'failureTrips', 'bookings', 'data', 'list']) ?? [];

    return capForModel({
      count: rows.length,
      canLoadMore: data?.canLoadMore === '1' || data?.canLoadMore === 1,
      failedTrips: rows.slice(0, 25).map((row) => ({
        ...normaliseBooking(row),
        paymentStatus: pick(row, ['paymentStatus', 'pgStatus']),
        failureReason: pick(row, ['failedBookingMsg', 'failureReason', 'reason', 'errorMessage', 'remarks']),
        refundStatus: pick(row, ['refundStatus', 'refund_status', 'refundState', 'refundInfo']),
        refundDate: pick(row, ['refundDate']),
        statusNote: pick(row, ['refreshMsg']),
      })),
    });
  }

  function normaliseBooking(row) {
    const passengers = Array.isArray(row?.passengerdetails)
      ? row.passengerdetails
          .map((p) => pick(p, ['Passenger_Name', 'name', 'passengerName']))
          .filter(Boolean)
          .map((n) => String(n).trim())
      : undefined;

    return {
      pnr: pick(row, ['pnr', 'PNR', 'ticketNo', 'ticketNumber', 'bookingId', 'referenceNo', 'trackId']),
      status: pick(row, ['status', 'bookingStatus', 'ticketStatus']),
      source: pick(row, ['source', 'fromCity', 'origin', 'sourceName']),
      destination: pick(row, ['destination', 'toCity', 'destinationName']),
      journeyDate: pick(row, ['jdate', 'journeyDate', 'travelDate', 'date']),
      departureTime: pick(row, ['startTime', 'departureTime', 'boardingTime']),
      operator: pick(row, ['travelerAgentName', 'operatorName', 'Service_Name', 'travels', 'travelsName']),
      seats: pick(row, ['seatNumbers', 'selectedSeats', 'seats', 'seatNos', 'seatNo']),
      fare: pick(row, ['fare', 'totalFare', 'totalAmount', 'amount', 'ticketAmount']),
      boardingPoint: pick(row, ['boardingPoint', 'boardingPlace', 'boardingPointName', 'pickupPoint']),
      ...(passengers?.length ? { passengers } : {}),
      downloadTicketUrl: pick(row, ['DownloadTicket']),
      canCancel: pick(row, ['canCancel', 'isCancellable', 'cancellable']),
    };
  }

  /* ---- 9. resolveCityIds (local helper, best-effort) ------------------
   * searchBuses needs numeric city ids. Three sources, cheapest first:
   *   a) the current /bus_search/... URL, which encodes both id pairs
   *   b) the Next.js hydration payload the site already shipped to the page
   *   c) a tiny table of ids observed in the captured traffic
   * If none hit, we say so rather than guessing — a wrong city id silently
   * returns the wrong route, which is worse than admitting ignorance.
   * ------------------------------------------------------------------- */

  /** Only ids actually observed in the reference cURL captures. */
  const KNOWN_CITY_IDS = Object.freeze({ goa: 102, pune: 51 });

  function cityIdsFromUrl() {
    // /bus_search/Goa/102/Pune/51/15-08-2026/O
    const match = window.location.pathname.match(
      /\/bus_search\/([^/]+)\/(\d+)\/([^/]+)\/(\d+)\/([^/]+)/i,
    );
    if (!match) return null;
    return {
      source: decodeURIComponent(match[1]).replace(/-/g, ' '),
      sourceId: Number(match[2]),
      destination: decodeURIComponent(match[3]).replace(/-/g, ' '),
      destinationId: Number(match[4]),
      dateToken: match[5],
    };
  }

  function cityIdFromPageState(name) {
    const wanted = String(name).trim().toLowerCase();
    const seen = new Set();

    const walk = (node, depth) => {
      if (!node || depth > 6 || typeof node !== 'object') return null;
      if (seen.has(node)) return null;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          const hit = walk(item, depth + 1);
          if (hit) return hit;
        }
        return null;
      }

      const label = pick(node, ['cityName', 'city', 'name', 'stationName', 'label']);
      const id = pick(node, ['cityId', 'id', 'stationId', 'value']);
      if (label && id && String(label).trim().toLowerCase() === wanted) {
        const numeric = Number(id);
        if (Number.isFinite(numeric)) return numeric;
      }

      for (const value of Object.values(node)) {
        const hit = walk(value, depth + 1);
        if (hit) return hit;
      }
      return null;
    };

    try {
      const nextData = document.getElementById('__NEXT_DATA__');
      if (nextData?.textContent) {
        const hit = walk(JSON.parse(nextData.textContent), 0);
        if (hit) return hit;
      }
    } catch {
      /* page state absent or not JSON — fine */
    }
    return null;
  }

  function resolveOneCity(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();

    const fromUrl = cityIdsFromUrl();
    if (fromUrl) {
      if (fromUrl.source.toLowerCase() === key) return fromUrl.sourceId;
      if (fromUrl.destination.toLowerCase() === key) return fromUrl.destinationId;
    }

    const fromState = cityIdFromPageState(name);
    if (fromState) return fromState;

    return KNOWN_CITY_IDS[key] ?? null;
  }

  async function resolveCityIds(args = {}) {
    const sourceId = resolveOneCity(args.source);
    const destinationId = args.destination ? resolveOneCity(args.destination) : undefined;

    const unresolved = [];
    if (args.source && sourceId === null) unresolved.push(args.source);
    if (args.destination && destinationId === null) unresolved.push(args.destination);

    if (unresolved.length) {
      return {
        resolved: false,
        unresolved,
        hint:
          'These city ids are not available on the current page. Ask the user to run the ' +
          'search once on abhibus.com, or to say which cities they mean, then retry.',
        ...(sourceId !== null ? { source: args.source, sourceId } : {}),
        ...(destinationId ? { destination: args.destination, destinationId } : {}),
      };
    }

    return {
      resolved: true,
      source: args.source,
      sourceId,
      ...(args.destination ? { destination: args.destination, destinationId } : {}),
    };
  }

  /* =====================================================================
   * Public surface
   * =================================================================== */

  const handlers = {
    getAbhiCashBalance,
    getWalletHistory,
    searchBuses,
    getSeatLayout,
    getSeatLayoutOffers,
    getSavedPassengers,
    getUserProfile,
    getBookings,
    getFailedTrips,
    resolveCityIds,
  };

  NS.AbhiBusAPIRegistry = {
    handlers,
    AbhiBusApiError,
    hasSession,
    getSessionProfile,
    getClevertapId,
    cityIdsFromUrl,

    /** True when a tool name is known to this registry. */
    has(name) {
      return Object.prototype.hasOwnProperty.call(handlers, name);
    },

    /**
     * Single entry point used by both the pre-router and the LLM tool loop.
     * Resolves to `{ ok: true, result }` or `{ ok: false, error }`, so callers
     * never need a try/catch — except UNAUTHENTICATED, which is preserved in
     * `error.code` so the UI can offer the login button.
     */
    async execute(name, args = {}) {
      if (!this.has(name)) {
        return {
          ok: false,
          error: { code: 'UNKNOWN_TOOL', message: `No registry handler named "${name}"` },
        };
      }

      const startedAt = performance.now();
      try {
        const result = await handlers[name](args);
        NS.log(`${name} ok in ${Math.round(performance.now() - startedAt)}ms`);
        return { ok: true, result, elapsedMs: Math.round(performance.now() - startedAt) };
      } catch (err) {
        const code = err && err.code ? err.code : 'UNKNOWN';
        NS.log(`${name} failed:`, code, err && err.message);
        return {
          ok: false,
          error: {
            code,
            message: (err && err.message) || 'Unknown error',
            ...(err && err.status ? { status: err.status } : {}),
          },
        };
      }
    },
  };
})();
