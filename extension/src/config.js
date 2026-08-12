/**
 * config.js
 * ---------------------------------------------------------------------------
 * Loaded first. Creates the single global namespace every other content-script
 * file hangs off, so the extension needs no bundler — `Load unpacked` just works.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  /** @type {Record<string, any>} */
  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});

  NS.CONFIG = {
    /** Overridden at runtime from chrome.storage.sync (see options.html). */
    backendUrl: 'http://localhost:8787',

    /** Where the login button sends the user. */
    loginUrl: 'https://www.abhibus.com/login',

    /** Origin used for all AbhiBus API calls. */
    apiOrigin: 'https://www.abhibus.com',

    /** Give up on a single AbhiBus API call after this long. */
    apiTimeoutMs: 15000,

    /** Hard cap on the JSON we hand to the model, to protect the context window. */
    maxToolResultChars: 12000,

    /** Conversation turns kept client-side and replayed to the backend. */
    maxHistoryTurns: 12,

    /** Set true to log every registry call and SSE event to the console. */
    debug: false,
  };

  /**
   * A/B experiment flags copied verbatim from the captured traffic. AbhiBus
   * echoes these back in pricing decisions, so sending the same values the site
   * itself sends keeps our results consistent with what the user sees on screen.
   */
  NS.API_EXP = Object.freeze({
    exp_fc_pricing: 'B',
    exp_feat_getbuslist: 'v1',
    exp_ixigo_payment: 'C',
    exp_no_results_sdui_web: 'B',
    exp_service_cards: '2',
    exp_srp_outlier: 'yes',
    exp_srp_sort_weighted: 'C',
    exp_uber_seat: 'A',
  });

  /** Sentinel used across the whole extension for "the user is logged out". */
  NS.UNAUTHENTICATED = 'UNAUTHENTICATED';

  /** Load persisted settings before anything else runs. */
  NS.loadSettings = async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(['backendUrl', 'debug']);
      if (typeof stored.backendUrl === 'string' && stored.backendUrl.trim()) {
        NS.CONFIG.backendUrl = stored.backendUrl.trim().replace(/\/+$/, '');
      }
      if (typeof stored.debug === 'boolean') NS.CONFIG.debug = stored.debug;
    } catch {
      // storage unavailable (rare) — fall back to the defaults above
    }
    return NS.CONFIG;
  };

  NS.log = function log(...args) {
    if (NS.CONFIG.debug) console.log('%c[abhi-agent]', 'color:#E5322D;font-weight:600', ...args);
  };
})();
