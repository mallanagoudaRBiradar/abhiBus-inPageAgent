/**
 * formatters.js
 * ---------------------------------------------------------------------------
 * Turns registry results into short answers WITHOUT an LLM.
 *
 * These exist purely for the Phase 4 fast path: when a prompt is unambiguous
 * ("balance?"), rendering the answer locally is roughly 50x faster than a round
 * trip through the gateway and a model. Same voice as the system prompt, so the
 * user cannot tell which path served them.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const NS = (window.__ABHI_AGENT__ = window.__ABHI_AGENT__ || {});

  /** ₹1,250 — Indian digit grouping. */
  function inr(value) {
    const num = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(num)) return String(value ?? '—');
    return `₹${num.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function formatBalance(result) {
    // Returning null declines the fast path: the raw payload goes to the model
    // instead, which can read shapes this formatter has never seen.
    if (result?.balance === null || result?.balance === undefined) return null;

    const total = Number(result.balance) || 0;
    const promo = result.promoBalance;
    const nonPromo = result.nonPromoBalance;
    const isEmpty = total === 0 && !promo && !nonPromo;

    // Always show the split and the usage rule — even an empty wallet should
    // teach the user how AbhiCash works.
    const lines = [
      isEmpty
        ? 'Your AbhiCash balance is **₹0** — the piggy bank is echoing 🐷'
        : `Your AbhiCash balance is **${inr(result.balance)}**.`,
    ];
    if (promo !== null && promo !== undefined) {
      lines.push(`- Promotional: **${inr(promo)}**`);
    }
    if (nonPromo !== null && nonPromo !== undefined) {
      lines.push(`- Non-promotional: **${inr(nonPromo)}**`);
    }
    if (result.redemptionNote) {
      lines.push('', `*How to use it: ${result.redemptionNote}*`);
    }
    if (isEmpty) {
      lines.push('', 'Book a trip or grab an offer and the cashback starts rolling in!');
    }
    return lines.join('\n');
  }

  /** "07-Aug-2026", "2026-08-07", "07/08/2026" → Date, else null. */
  function parseLooseDate(value) {
    const s = String(value ?? '').trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    const named = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{4})/);
    if (named) {
      const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const m = months.indexOf(named[2].slice(0, 3).toLowerCase());
      if (m >= 0) return new Date(+named[3], m, +named[1]);
    }
    const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }

  function bookingLine(b) {
    const route =
      b.source && b.destination ? `${b.source} → ${b.destination}` : b.source || 'Trip';
    const bits = [];
    if (b.journeyDate) bits.push(b.journeyDate);
    if (b.departureTime) bits.push(b.departureTime);
    if (b.seats) bits.push(`seat ${b.seats}`);
    if (b.pnr) bits.push(`PNR ${b.pnr}`);
    if (b.status) bits.push(String(b.status));
    return `- **${route}** — ${bits.filter(Boolean).join(' · ') || 'details unavailable'}`;
  }

  /**
   * @param {object} result   projected getBookings result — either the live
   *   { upcoming, past, cancelled } split or a legacy flat { bookings } list.
   * @param {string} [prompt] the user's question — "upcoming" changes the answer:
   *   a past trip must never be presented as an upcoming one.
   */
  function formatBookings(result, prompt = '') {
    let upcoming;
    let past;
    let cancelled = [];

    if (Array.isArray(result?.upcoming) || Array.isArray(result?.past)) {
      // The API already classified them — trust it.
      upcoming = result.upcoming ?? [];
      past = result.past ?? [];
      cancelled = result.cancelled ?? [];
    } else {
      const bookings = result?.bookings ?? [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      upcoming = [];
      past = [];
      for (const b of bookings) {
        const when = parseLooseDate(b.journeyDate);
        // Undated rows can't be called "upcoming" — treat them as history.
        if (when && when >= today) upcoming.push(b);
        else past.push(b);
      }
    }

    const total = upcoming.length + past.length + cancelled.length;
    if (total === 0) {
      return (
        'No trips on this account yet — your travel story is a blank page 🚌📖.\n' +
        'Search for a bus and let\'s write chapter one!'
      );
    }

    const lines = [];
    if (/\b(upcoming|next|future)\b/i.test(prompt)) {
      if (upcoming.length === 0) {
        lines.push('You have **no upcoming trips** — the road ahead is wide open 🛣️.');
        if (past.length) {
          lines.push('', `Your ${plural(past.length, 'previous trip', 'previous trips')}:`, '');
          for (const b of past.slice(0, 5)) lines.push(bookingLine(b));
          if (past.length > 5) lines.push('', `…and ${past.length - 5} more.`);
        }
      } else {
        lines.push(`You have ${plural(upcoming.length, 'upcoming trip', 'upcoming trips')}:`, '');
        for (const b of upcoming.slice(0, 5)) lines.push(bookingLine(b));
      }
      return lines.join('\n');
    }

    const parts = [];
    if (upcoming.length) parts.push(`${upcoming.length} upcoming`);
    if (past.length) parts.push(`${past.length} past`);
    if (cancelled.length) parts.push(`${cancelled.length} cancelled`);
    lines.push(`You have ${plural(total, 'booking', 'bookings')} (${parts.join(', ')}).`, '');
    for (const b of upcoming.slice(0, 5)) lines.push(bookingLine(b));
    for (const b of past.slice(0, Math.max(0, 5 - upcoming.length))) lines.push(bookingLine(b));
    const shown = Math.min(5, upcoming.length + past.length);
    if (upcoming.length + past.length > shown) {
      lines.push('', `…and ${upcoming.length + past.length - shown} more.`);
    }
    return lines.join('\n');
  }

  function formatOffers(result) {
    const offers = result?.offers ?? [];
    if (offers.length === 0) {
      return 'No offers are available for this journey right now.';
    }

    const lines = [`${plural(offers.length, 'offer', 'offers')} available:`, ''];
    for (const o of offers.slice(0, 6)) {
      const head = o.code ? `\`${o.code}\`` : o.title || 'Offer';
      const detail = [o.title !== head ? o.title : null, o.discount ? `saves ${inr(o.discount)}` : null]
        .filter(Boolean)
        .join(' — ');
      lines.push(`- ${head}${detail ? ` — ${detail}` : ''}`);
    }
    return lines.join('\n');
  }

  function formatWalletHistory(result) {
    const rows = result?.transactions ?? [];
    if (rows.length === 0) {
      const apiNote = result?.note ? `\n*(AbhiBus says: "${result.note}")*` : '';
      return (
        'Your AbhiCash ledger is squeaky clean ✨ — not a single transaction yet.\n' +
        'Check the Offers page for cashback deals and give it some history!' +
        apiNote
      );
    }

    const lines = [`Last ${Math.min(rows.length, 6)} wallet transactions:`, ''];
    for (const t of rows.slice(0, 6)) {
      const when = t.date ? `${t.date} · ` : '';
      lines.push(`- ${when}**${inr(t.amount)}** ${t.type ?? ''} ${t.description ?? ''}`.trimEnd());
    }
    if (result.canLoadMore) {
      lines.push('', '*There are more transactions — ask me to show more.*');
    }
    return lines.join('\n');
  }

  NS.formatters = {
    inr,
    formatBalance,
    formatBookings,
    formatOffers,
    formatWalletHistory,
  };
})();
