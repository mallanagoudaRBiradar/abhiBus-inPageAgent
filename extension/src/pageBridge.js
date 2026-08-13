/**
 * pageBridge.js  —  PHASE 6 (in-page results)
 * ---------------------------------------------------------------------------
 * Treats the HOST PAGE as part of the answer. Two jobs:
 *
 *  1. Conversation persistence. After a successful bus search the tab itself
 *     navigates to the live results URL. That reloads every content script,
 *     so the chat (history, rendered cards, open state) is snapshotted into
 *     sessionStorage — per-tab, survives same-tab navigation, dies with the
 *     tab — and replayed on boot. The chat "remains the same" across the jump.
 *
 *  2. Filter automation. What the user asked for in prose ("cheaper", "AC
 *     sleeper") is applied to the live results list: sort by price, tick the
 *     matching bus-type filters. Best-effort BY DESIGN: abhibus.com is a
 *     hydrated Next.js app with generated class names, so controls are found
 *     by their visible text — the way the user would find them — and anything
 *     that cannot be found is skipped and reported, never thrown. The worst
 *     case is the untouched results page plus the already-sorted chat card.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});

  const CHAT_KEY = '__abhi_agent_chat_v1';
  const ACTION_KEY = '__abhi_agent_action_v1';
  const CHAT_TTL_MS = 45 * 60 * 1000; // a chat older than this restarts fresh
  const ACTION_TTL_MS = 2 * 60 * 1000; // a navigation that took longer is stale

  /* =====================================================================
   * sessionStorage — namespaced, TTL-guarded, never throws
   * =================================================================== */

  function put(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ ...value, ts: Date.now() }));
    } catch {
      /* quota or privacy mode — persistence is best-effort */
    }
  }

  function get(key, ttl) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value?.ts || Date.now() - value.ts > ttl) {
        sessionStorage.removeItem(key);
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function drop(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* nothing to clean */
    }
  }

  const saveChat = (snapshot) => put(CHAT_KEY, snapshot);
  const loadChat = () => get(CHAT_KEY, CHAT_TTL_MS);
  const clearChat = () => drop(CHAT_KEY);

  const savePageAction = (action) => put(ACTION_KEY, action);

  /**
   * Accept intents in any shape this extension has ever saved — an action
   * queued by the previous version right before an extension reload must
   * still apply its price sort, not silently drop it.
   */
  function normalizeIntent(intent) {
    if (!intent || typeof intent !== 'object') return intent;
    return {
      sort:
        intent.sort ??
        (intent.sortCheapest ? 'price' : intent.sortRating ? 'rating' : null),
      skippedSorts: Array.isArray(intent.skippedSorts) ? intent.skippedSorts : [],
      busTypes: Array.isArray(intent.busTypes) ? intent.busTypes : [],
      timeWindows: Array.isArray(intent.timeWindows) ? intent.timeWindows : [],
      offers: Boolean(intent.offers),
      busTrack: Boolean(intent.busTrack),
      operator: intent.operator ?? null,
      boardingPoint: intent.boardingPoint ?? null,
      droppingPoint: intent.droppingPoint ?? null,
    };
  }

  /** Read-and-consume: a queued page action fires at most once. */
  function takePageAction() {
    const action = get(ACTION_KEY, ACTION_TTL_MS);
    drop(ACTION_KEY);
    if (action?.intent) action.intent = normalizeIntent(action.intent);
    return action;
  }

  /* =====================================================================
   * Intent — what the user's own words ask the results page to do
   * =================================================================== */

  const TYPE_LABELS = Object.freeze({
    ac: 'A/C',
    nonac: 'Non A/C',
    sleeper: 'Sleeper',
    seater: 'Seater',
    volvo: 'Volvo',
  });

  const WINDOW_LABELS = Object.freeze({
    before10: 'Before 10 AM',
    '10to5': '10 AM - 5 PM',
    '5to11': '5 PM - 11 PM',
    after11: 'After 11 PM',
  });

  const SORT_LABELS = Object.freeze({
    price: 'price low → high',
    rating: 'rating high → low',
    seats: 'most seats first',
    arrival: 'earliest arrival',
    departure: 'earliest departure',
  });

  /**
   * @param {string} promptText   the user's message ("cheaper AC buses…")
   * @param {string} [modelFilter] the `filter` arg the model passed to
   *   searchBuses ("evening ac sleeper") — catches phrasings the regexes miss.
   * @param {string} [modelOperator] the `operator` arg the model passed
   *   ("vrl") — the primary source for the Bus Partner filter.
   */
  function deriveFilterIntent(promptText, modelFilter, modelOperator) {
    const text = `${promptText ?? ''} ${modelFilter ?? ''}`.toLowerCase();
    const intent = {
      /** One of SORT_LABELS' keys, or null. A list sorts one way only. */
      sort: null,
      /** Sorts the user ALSO asked for that the page cannot apply at the
       *  same time — surfaced in the chip instead of silently dropped. */
      skippedSorts: [],
      busTypes: [],
      /** Departure-time windows, keyed as in WINDOW_LABELS. */
      timeWindows: [],
      offers: false,
      busTrack: false,
      operator: null,
      boardingPoint: null,
      droppingPoint: null,
    };

    /* ---- sort: collect every match; highest priority is applied, the
     *      rest are reported as skipped rather than vanishing ----------- */
    const wantedSorts = [];
    if (/\b(cheap(est|er)?|lowest|low[\s-]*(price|fare|cost)|budget|affordable)\b/.test(text)) {
      wantedSorts.push('price');
    }
    if (
      /\b(high(est|ly)?[\s-]*rat(ed|ing)s?|top[\s-]*rated|best[\s-]*rated|good[\s-]*rat(ed|ing)s?|[45][\s-]*star)/.test(
        text,
      )
    ) {
      wantedSorts.push('rating');
    }
    if (/\b(most|max(imum)?|more)\s*(available\s*)?seats?\b/.test(text)) {
      wantedSorts.push('seats');
    }
    if (/\b(arriv\w*|reach\w*)\b[^.]{0,16}\b(early|earliest|first|soon(est)?)\b|\bearliest\s*arrival\b/.test(text)) {
      wantedSorts.push('arrival');
    }
    if (/\b(depart\w*|leav\w*|start\w*)\b[^.]{0,16}\b(early|earliest|first)\b|\bearliest\s*(bus|departure)\b/.test(text)) {
      wantedSorts.push('departure');
    }
    intent.sort = wantedSorts[0] ?? null;
    intent.skippedSorts = wantedSorts.slice(1);

    /* ---- bus type ----------------------------------------------------- */
    if (/non\s*-?\s*a\/?c/.test(text)) intent.busTypes.push('nonac');
    else if (/\ba\/?c\b/.test(text)) intent.busTypes.push('ac');
    if (/\bsleeper\b/.test(text)) intent.busTypes.push('sleeper');
    if (/\bseater\b/.test(text)) intent.busTypes.push('seater');
    if (/\bvolvo\b/.test(text)) intent.busTypes.push('volvo');

    /* ---- departure-time windows ---------------------------------------
     * "late night" is checked before "night" so it lands in After 11 PM
     * rather than the evening bucket.
     * ------------------------------------------------------------------ */
    const lateNight = /\b(late\s*night|after\s*11|midnight)\b/.test(text);
    if (lateNight) intent.timeWindows.push('after11');
    if (/\b(early\s*morning|morning|before\s*10)\b/.test(text)) intent.timeWindows.push('before10');
    if (/\b(afternoon|mid\s*-?\s*day|noon)\b/.test(text)) intent.timeWindows.push('10to5');
    if (/\b(evening|tonight)\b/.test(text) || (!lateNight && /\bnight\b/.test(text))) {
      intent.timeWindows.push('5to11');
    }

    /* ---- toggle chips -------------------------------------------------- */
    if (/\b(offers?|discounts?|deals?|coupons?|cashback)\b/.test(text)) intent.offers = true;
    if (/\b(bus\s*track(ing)?|live\s*track(ing)?|gps|track(able)?\s*(the\s*)?bus(es)?)\b/.test(text)) {
      intent.busTrack = true;
    }

    /* ---- boarding / dropping point -------------------------------------
     * Best-effort capture of the place name that follows the keyword,
     * trimmed at connector words so "boarding from gachibowli on 17th aug"
     * yields just "gachibowli".
     * ------------------------------------------------------------------- */
    const PLACE_STOP = new Set([
      'bus', 'buses', 'on', 'at', 'for', 'to', 'from', 'the', 'and', 'with', 'a', 'an',
      'tomorrow', 'today', 'next', 'this', 'point', 'points',
      'morning', 'afternoon', 'evening', 'night', 'late', 'early', 'tonight',
      'cheap', 'cheapest', 'cheaper', 'ac', 'sleeper', 'seater', 'volvo', 'rated', 'rating',
      'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    ]);
    const place = (re) => {
      const m = text.match(re);
      if (!m) return null;
      // Point names on the site are one or two words (Kphb, Nashik Phata) —
      // keep at most two, stopping at the first word that is clearly not a
      // place ("boarding from gachibowli evening buses" -> "gachibowli").
      const kept = [];
      for (const word of m[1].replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)) {
        if (PLACE_STOP.has(word)) break;
        kept.push(word);
        if (kept.length === 2) break;
      }
      const name = kept.join(' ');
      return name.length >= 3 && name.length <= 30 ? name : null;
    };
    intent.boardingPoint = place(
      /\b(?:boarding(?:\s*point)?|board|pick\s*-?\s*up|pickup)\s*(?:at|from|in|near|point)?\s+([a-z][a-z0-9 ]{2,30})/,
    );
    intent.droppingPoint = place(
      /\b(?:dropping(?:\s*point)?|drop(?:\s*-?\s*off)?)\s*(?:at|in|near|point)?\s+([a-z][a-z0-9 ]{2,30})/,
    );

    /* ---- operator / bus partner -----------------------------------------
     * The model's `operator` argument is the primary source — it understands
     * "search for vrl bus only" natively. The regexes are a fallback for the
     * common only-phrasings.
     * ------------------------------------------------------------------- */
    const modelOp = String(modelOperator ?? '').trim().toLowerCase();
    if (modelOp && modelOp.length >= 2 && modelOp.length <= 30) {
      intent.operator = modelOp;
    } else {
      const opFrom =
        text.match(/\b([a-z][a-z0-9&.]{1,20})\s+(?:travels?|tours?)\b/) ||
        text.match(/\b(?:only|just)\s+([a-z][a-z0-9&.]{2,20})\s+bus/) ||
        text.match(/\b([a-z][a-z0-9&.]{2,20})\s+bus(?:es)?\s+only\b/);
      const candidate = opFrom?.[1] ?? null;
      if (candidate && !PLACE_STOP.has(candidate) && !/^(non|new|these|those|some|any)$/.test(candidate)) {
        intent.operator = candidate;
      }
    }

    return intent;
  }

  function hasWork(intent) {
    return Boolean(
      intent?.sort ||
        intent?.busTypes?.length ||
        intent?.timeWindows?.length ||
        intent?.offers ||
        intent?.busTrack ||
        intent?.operator ||
        intent?.boardingPoint ||
        intent?.droppingPoint,
    );
  }

  /** Human labels for the chip in the chat log. */
  function describeIntent(intent) {
    const parts = [];
    if (intent?.sort) parts.push(SORT_LABELS[intent.sort] || intent.sort);
    for (const type of intent?.busTypes ?? []) parts.push(TYPE_LABELS[type] || type);
    for (const win of intent?.timeWindows ?? []) parts.push(WINDOW_LABELS[win] || win);
    if (intent?.offers) parts.push('Offers');
    if (intent?.busTrack) parts.push('Bus Track');
    if (intent?.operator) parts.push(`Operator: ${intent.operator}`);
    if (intent?.boardingPoint) parts.push(`Boarding: ${intent.boardingPoint}`);
    if (intent?.droppingPoint) parts.push(`Drop: ${intent.droppingPoint}`);
    return parts;
  }

  /* =====================================================================
   * URL — is this tab already showing that search?
   * =================================================================== */

  const SEARCH_RE = /\/bus_search\/[^/]+\/(\d+)\/[^/]+\/(\d+)\/(\d{2}-\d{2}-\d{4})/i;

  /**
   * True when `url` is the bus_search page THIS tab is already on (same city
   * ids, same date) — navigating again would be a pointless full reload.
   */
  function isSameSearchPage(url) {
    try {
      const target = new URL(url, window.location.href).pathname.match(SEARCH_RE);
      const here = window.location.pathname.match(SEARCH_RE);
      return Boolean(
        target &&
          here &&
          target[1] === here[1] &&
          target[2] === here[2] &&
          target[3] === here[3],
      );
    } catch {
      return false;
    }
  }

  /* =====================================================================
   * DOM automation on the live results page
   * =================================================================== */

  const CLICKABLE = 'button, [role="button"], a, label, li, span, p, div';

  function isVisible(el) {
    if (!el?.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  /** "AC (114)" -> "ac" — filter rows carry live result counts. */
  function norm(text) {
    return String(text ?? '')
      .replace(/\(\d+\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * The tightest visible element whose own text satisfies one of `matchers` —
   * shortest text wins, and among equals the deeper node, so we click the
   * "Low to High" span rather than the whole sort bar around it.
   */
  function findByText(matchers, maxLen = 42) {
    let best = null;
    let bestLen = Infinity;
    for (const el of document.querySelectorAll(CLICKABLE)) {
      // Labels are leaf-ish; skipping busy containers keeps the scan cheap.
      if (el.childElementCount > 3) continue;
      const text = norm(el.textContent);
      if (!text || text.length > maxLen) continue;
      if (!matchers.some((m) => m(text))) continue;
      // Never click a link that would NAVIGATE away — the header nav carries
      // "Offers"/"Bus Track" items whose labels collide with the filter
      // chips. Inert anchors (no/#/javascript href) and links back to the
      // page we are already on (sort controls are sometimes anchors) are fine.
      const link = el.closest('a[href]');
      if (link) {
        const href = link.getAttribute('href') || '';
        const inert = !href || href.startsWith('#') || href.startsWith('javascript');
        if (!inert) {
          let samePage = false;
          try {
            samePage =
              new URL(href, window.location.href).pathname === window.location.pathname;
          } catch {
            samePage = false;
          }
          if (!samePage) continue;
        }
      }
      if (!isVisible(el)) continue;
      if (text.length < bestLen || (text.length === bestLen && best && best.contains(el))) {
        best = el;
        bestLen = text.length;
      }
    }
    return best;
  }

  /**
   * ALL distinct visible elements matching one of `matchers` — for
   * multi-select filters (operator checkboxes) where several rows can match
   * "vrl". Ancestors of another match are dropped so each row is clicked
   * once, not once per wrapper.
   */
  function findAllByText(matchers, maxLen = 60, cap = 4) {
    const hits = [];
    for (const el of document.querySelectorAll(CLICKABLE)) {
      if (el.childElementCount > 3) continue;
      const text = norm(el.textContent);
      if (!text || text.length > maxLen) continue;
      if (!matchers.some((m) => m(text))) continue;
      const link = el.closest('a[href]');
      if (link) {
        const href = link.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !href.startsWith('javascript')) continue;
      }
      if (!isVisible(el)) continue;
      hits.push(el);
    }
    const leaves = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
    return leaves.slice(0, cap);
  }

  /**
   * Set a text input's value the way React expects: through the native
   * setter (bypassing React's own descriptor), then an input event.
   */
  function setInputValue(input, value) {
    try {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        'value',
      ) || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc?.set) desc.set.call(input, value);
      else input.value = value;
    } catch {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** The first visible search box, e.g. Bus Partner's "Search here". */
  function findSearchInput() {
    for (const input of document.querySelectorAll(
      'input[type="text"], input[type="search"], input:not([type])',
    )) {
      if (!isVisible(input)) continue;
      const hint = `${input.placeholder ?? ''} ${input.getAttribute('aria-label') ?? ''}`;
      if (/search/i.test(hint)) return input;
    }
    return null;
  }

  /** React listens at the root; labels/checkboxes want the full sequence. */
  function fire(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    const Pointer = window.PointerEvent || MouseEvent;
    el.dispatchEvent(new Pointer('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new Pointer('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Poll until `probe` returns truthy or the timeout lapses. */
  async function waitFor(probe, timeoutMs = 15000, pollMs = 400) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = probe();
      if (hit) return hit;
      await sleep(pollMs);
    }
    return null;
  }

  /* ---- what the controls are called on the page --------------------- */

  /** Squash spaces/dashes so "10 AM - 5 PM" and "10AM-5PM" both match. */
  const squash = (t) => t.replace(/[\s\-–]+/g, '');

  /**
   * One entry per column of the site's "Sort by" bar. `explicit` finds a
   * ready-made option ("Price: Low to High"); `generic` finds the column
   * header itself; `dropdown` picks the right option if the header click
   * opened a menu instead of sorting directly.
   */
  const SORTS = {
    price: {
      explicit: [
        (t) => /^(sort\s*by\s*:?\s*)?price\s*[:\-–]?\s*low\s*to\s*high$/.test(t),
        (t) => t === 'low to high',
        (t) => t === 'cheapest' || t === 'cheapest first',
      ],
      generic: [(t) => t === 'price' || t === 'fare' || t === 'fares'],
      dropdown: /low\s*to\s*high/,
    },
    rating: {
      explicit: [
        (t) => /^(sort\s*by\s*:?\s*)?ratings?\s*[:\-–]?\s*high\s*to\s*low$/.test(t),
        (t) => t === 'top rated' || t === 'highest rated',
      ],
      generic: [(t) => t === 'ratings' || t === 'rating'],
      dropdown: /high\s*to\s*low/,
    },
    seats: {
      explicit: [(t) => /^seats?\s*[:\-–]?\s*(high\s*to\s*low|most\s*first)$/.test(t)],
      generic: [(t) => t === 'seats' || t === 'seat'],
      dropdown: /high\s*to\s*low|most/,
    },
    arrival: {
      explicit: [(t) => /^arrival(\s*time)?\s*[:\-–]?\s*(low\s*to\s*high|earliest)$/.test(t)],
      generic: [(t) => t === 'arrival time' || t === 'arrival'],
      dropdown: /earliest|low\s*to\s*high/,
    },
    departure: {
      explicit: [(t) => /^departure(\s*time)?\s*[:\-–]?\s*(low\s*to\s*high|earliest)$/.test(t)],
      generic: [(t) => t === 'departure time' || t === 'departure'],
      dropdown: /earliest|low\s*to\s*high/,
    },
  };

  /** The sidebar / popular-filter chips, by intent key. */
  const WINDOW_MATCHERS = {
    before10: [(t) => squash(t) === 'before10am'],
    '10to5': [(t) => squash(t) === '10am5pm'],
    '5to11': [(t) => squash(t) === '5pm11pm'],
    after11: [(t) => squash(t) === 'after11pm'],
  };
  const OFFERS_MATCHERS = [(t) => t === 'offers' || t === 'offer'];
  const BUS_TRACK_MATCHERS = [(t) => squash(t) === 'bustrack' || squash(t) === 'bustracking'];

  const TYPE_MATCHERS = {
    ac: [(t) => (t === 'ac' || /^a\/?c\b/.test(t)) && !/non/.test(t)],
    nonac: [(t) => /^non\s*-?\s*a\/?c\b/.test(t)],
    sleeper: [(t) => /^sleeper\b/.test(t) && !/semi/.test(t)],
    seater: [(t) => /^seater\b/.test(t)],
    volvo: [(t) => /^volvo\b/.test(t)],
  };

  /**
   * Click a sort control: the explicit option ("Price: Low to High") first;
   * failing that, the generic column header ("Price" / "Ratings"), which may
   * either sort directly or open a dropdown whose options only exist after
   * the click — `dropdownRe` finds the right one in that case.
   */
  async function applySort(explicitMatchers, genericMatchers, dropdownRe) {
    const explicit = findByText(explicitMatchers);
    if (explicit) {
      fire(explicit);
      return true;
    }

    const generic = findByText(genericMatchers);
    if (!generic) return false;
    fire(generic);
    await sleep(350);
    const option = findByText(explicitMatchers.concat([(t) => dropdownRe.test(t)]));
    if (option) fire(option);
    return true;
  }

  /**
   * Click one chip and pause for the list re-render. Returns true on a hit.
   */
  async function applyChip(matchers, label, applied) {
    const el = findByText(matchers);
    if (!el) return false;
    fire(el);
    applied.push(label);
    await sleep(500);
    return true;
  }

  /**
   * Boarding/dropping point by name. The "Popular Filters" strip carries the
   * points as chips under a Boarding Points / Dropping Points tab; the
   * sidebar repeats them under a collapsible dropdown. Try the tab + chip
   * first, then the dropdown.
   */
  async function applyPointFilter(kind, name, applied) {
    const tabLabel = kind === 'boarding' ? 'boarding points' : 'dropping points';
    const ddLabel = kind === 'boarding' ? 'boarding point' : 'dropping point';
    const wanted = norm(name);
    const chipMatcher = [
      (t) => t === wanted || (t.length >= 3 && (t.includes(wanted) || wanted.includes(t))),
    ];

    const tab = findByText([(t) => t === tabLabel]);
    if (tab) {
      fire(tab);
      await sleep(400);
      if (findByText(chipMatcher)) {
        return applyChip(chipMatcher, `${kind === 'boarding' ? 'Boarding' : 'Drop'}: ${name}`, applied);
      }
    }

    const dropdown = findByText([(t) => t === ddLabel]);
    if (dropdown) {
      fire(dropdown);
      await sleep(400);
      return applyChip(chipMatcher, `${kind === 'boarding' ? 'Boarding' : 'Drop'}: ${name}`, applied);
    }
    return false;
  }

  /**
   * Operator ("Bus Partner") filter: chips under the Popular Filters
   * "Operators" tab when present, else the sidebar's Bus Partner section —
   * expand it, narrow with its search box, then tick EVERY row whose name
   * contains the asked-for fragment ("vrl" -> "VRL Travels").
   */
  async function applyOperatorFilter(name, applied) {
    const wanted = norm(name);
    if (wanted.length < 2) return false;
    const rowMatcher = [(t) => t.length >= wanted.length && t.includes(wanted)];

    const tickAllMatches = async () => {
      const rows = findAllByText(rowMatcher);
      for (const row of rows) {
        fire(row);
        await sleep(350); // list re-renders between ticks
      }
      if (rows.length) {
        applied.push(`Operator: ${name} (${rows.length} matched)`);
        return true;
      }
      return false;
    };

    // 1) Popular Filters → Operators tab
    const tab = findByText([(t) => t === 'operators' || t === 'operator']);
    if (tab) {
      fire(tab);
      await sleep(400);
      if (await tickAllMatches()) return true;
    }

    // 2) Sidebar → Bus Partner (may be collapsed; may have a search box)
    const section = findByText([(t) => t === 'bus partner' || t === 'bus partners']);
    if (section) {
      fire(section);
      await sleep(400);
    }
    const search = findSearchInput();
    if (search) {
      setInputValue(search, name);
      await sleep(500); // let the list narrow down
    }
    return tickAllMatches();
  }

  /**
   * Apply the intent to the live page. Resolves to the labels of what was
   * actually applied — possibly empty. Never throws.
   */
  async function applyFiltersOnPage(intent) {
    const applied = [];
    if (!hasWork(intent)) return applied;

    // Any of these existing means the results UI has hydrated enough to try.
    await waitFor(
      () =>
        findByText([(t) => t.startsWith('sort')]) ||
        findByText([(t) => t === 'filters' || t === 'filter']) ||
        findByText(SORTS.price.explicit.concat(SORTS.price.generic)),
      20000,
    );
    await sleep(600); // let the list settle after hydration

    for (const type of intent.busTypes ?? []) {
      await applyChip(TYPE_MATCHERS[type] ?? [], TYPE_LABELS[type] || type, applied);
    }
    for (const win of intent.timeWindows ?? []) {
      await applyChip(WINDOW_MATCHERS[win] ?? [], WINDOW_LABELS[win] || win, applied);
    }
    if (intent.offers) await applyChip(OFFERS_MATCHERS, 'Offers', applied);
    if (intent.busTrack) await applyChip(BUS_TRACK_MATCHERS, 'Bus Track', applied);

    if (intent.operator) await applyOperatorFilter(intent.operator, applied);
    if (intent.boardingPoint) await applyPointFilter('boarding', intent.boardingPoint, applied);
    if (intent.droppingPoint) await applyPointFilter('dropping', intent.droppingPoint, applied);

    // Sort LAST so the filtered list is what gets ordered. A list can only
    // sort one way; deriveFilterIntent already picked the winner, and any
    // runner-up ("cheapest AND high rating") is reported, not swallowed.
    const sort = intent.sort && SORTS[intent.sort];
    if (sort && (await applySort(sort.explicit, sort.generic, sort.dropdown))) {
      applied.push(SORT_LABELS[intent.sort]);
      for (const skipped of intent.skippedSorts ?? []) {
        applied.push(`${SORT_LABELS[skipped] || skipped}: page sorts one way — skipped`);
      }
    }

    return applied;
  }

  /* =====================================================================
   * Public surface
   * =================================================================== */

  NS.pageBridge = {
    saveChat,
    loadChat,
    clearChat,
    savePageAction,
    takePageAction,
    deriveFilterIntent,
    describeIntent,
    hasWork,
    isSameSearchPage,
    applyFiltersOnPage,
  };
})();
