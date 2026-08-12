/**
 * knowledge.ts
 * ---------------------------------------------------------------------------
 * FAQ / policy knowledge for the `getHelpContent` tool.
 *
 * Source of truth is `https://www.abhibus.com/llms.txt` (the llms.txt
 * standard — note the "s"; the singular spelling is kept as a fallback
 * candidate). Overridable with KNOWLEDGE_URL. Fetched lazily, cached for
 * KNOWLEDGE_TTL_MS, and validated: a 404 or an HTML error page falls through
 * to the next candidate, and finally to the built-in FAQ pack below. Either
 * way the model receives only the chunks relevant to the question, not the
 * whole document — the query is keyword-scored against heading chunks.
 * ---------------------------------------------------------------------------
 */

const KNOWLEDGE_URLS = [
  process.env.KNOWLEDGE_URL?.trim() || '',
  'https://www.abhibus.com/llms.txt',
  'https://www.abhibus.com/llm.txt',
].filter(Boolean);
const KNOWLEDGE_TTL_MS = Number(process.env.KNOWLEDGE_TTL_MS) || 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULT_CHARS = 6000;

/**
 * Built-in fallback so FAQ answers still work while llm.txt is unavailable.
 * Condensed from AbhiBus's public help pages. Each `##` section is one chunk.
 */
const FALLBACK_FAQ = `
# AbhiBus Help (built-in summary)

## Booking a bus ticket
Search by entering source city, destination city and journey date, then pick a
bus and seats, enter passenger details and pay. A ticket (with PNR) is sent by
SMS, WhatsApp and email immediately after payment. You can also show the
m-ticket on your phone — a printout is not required on most services.

## Cancelling a ticket and refunds
Tickets can be cancelled from "Track Ticket" or "My Bookings" using the PNR.
Cancellation charges depend on the operator's policy and how close to departure
you cancel — the exact refund amount is shown before you confirm the
cancellation. Refunds are returned to the original payment method, typically
within 5–7 business days; AbhiCash refunds are instant. Partial cancellation
(some seats of a multi-seat booking) is allowed on most, not all, operators.

## Rescheduling a trip
Many operators allow rescheduling to a different date or time from
"My Bookings" without cancelling. Where the operator does not support it,
cancel (charges apply) and book afresh.

## Failed payment / money deducted but no ticket
If money was deducted and no ticket was issued, the booking appears under
failed transactions and the amount is auto-refunded to the source within 5–7
business days. If the refund does not arrive, contact support with the
transaction id.

## AbhiCash
AbhiCash is AbhiBus's wallet credit. It is earned as cashback from offers and
refunds, applies automatically at checkout, and can cover part or all of a
fare. Promotional AbhiCash carries an expiry date; check the wallet page for
expiring credit. AbhiCash is not transferable and cannot be withdrawn to a bank
account.

## Offers and coupon codes
Active coupon codes are listed on the Offers page and on the seat-selection
screen for the chosen bus. A coupon is applied at payment; discounts and
cashback are credited per the offer's terms. Only one coupon can be used per
booking.

## Boarding, m-tickets and ID
Arrive at the boarding point at least 15 minutes early. Carry the m-ticket
(SMS/app) and a government photo ID. The operator's staff may call from the
driver/attendant number shown in the ticket details.

## Track my bus / live status
Use "Track Ticket" with your PNR to see live bus tracking (where the operator
supports GPS), boarding point details and the crew's contact number.

## Contacting support
Help is available in-app via "Need Help?", at support@abhibus.com, and on the
24×7 helpline listed on the Contact Us page. Keep your PNR or transaction id
handy.

## About AbhiBus
AbhiBus (part of ixigo) is one of India's largest online bus-ticketing
platforms, selling tickets for thousands of private and state (RTC) operators,
including APSRTC, TSRTC and more. It also offers train and hotel bookings.
`.trim();

/* ------------------------------------------------------------------------ */

interface KnowledgeCache {
  text: string;
  source: 'llms.txt' | 'built-in';
  fetchedAt: number;
}

let cache: KnowledgeCache | null = null;

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 300).toLowerCase();
  return head.includes('<!doctype') || head.includes('<html');
}

async function fetchOne(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/plain, text/markdown, */*' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim() || looksLikeHtml(text)) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** First candidate URL that yields real text wins. */
async function fetchLlmsTxt(): Promise<{ text: string; url: string } | null> {
  for (const url of KNOWLEDGE_URLS) {
    const text = await fetchOne(url);
    if (text) return { text, url };
  }
  return null;
}

/** The full knowledge text, from llms.txt when live, else the built-in pack. */
export async function getKnowledge(): Promise<KnowledgeCache> {
  if (cache && Date.now() - cache.fetchedAt < KNOWLEDGE_TTL_MS) return cache;

  const live = await fetchLlmsTxt();
  cache = {
    text: live?.text ?? FALLBACK_FAQ,
    source: live ? 'llms.txt' : 'built-in',
    fetchedAt: Date.now(),
  };
  console.log(
    `[knowledge] loaded ${cache.text.length} chars from ${
      live ? live.url : 'built-in FAQ pack (llms.txt unavailable)'
    }`,
  );
  return cache;
}

/* ------------------------------------------------------------------------ */

interface Chunk {
  heading: string;
  body: string;
}

/** Split on markdown headings; fall back to blank-line paragraphs. */
function chunkKnowledge(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const parts = text.split(/^(?=#{1,3}\s)/m).filter((p) => p.trim());

  if (parts.length > 1) {
    for (const part of parts) {
      const lines = part.trim().split('\n');
      const heading = lines[0]!.replace(/^#+\s*/, '').trim();
      chunks.push({ heading, body: lines.slice(1).join('\n').trim() });
    }
    return chunks;
  }

  for (const para of text.split(/\n{2,}/)) {
    const body = para.trim();
    if (body) chunks.push({ heading: body.slice(0, 60), body });
  }
  return chunks;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'do', 'does', 'how', 'what', 'when',
  'where', 'why', 'can', 'i', 'my', 'me', 'to', 'of', 'for', 'in', 'on', 'and',
  'or', 'it', 'about', 'abhibus', 'bus', 'ticket', 'tickets',
]);

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export interface HelpResult {
  source: 'llms.txt' | 'built-in';
  sections: Array<{ heading: string; content: string }>;
  note: string;
}

/**
 * Return the sections most relevant to `query`, capped so a single tool result
 * cannot blow the model's context window.
 */
export async function searchHelp(query: string): Promise<HelpResult> {
  const { text, source } = await getKnowledge();
  const chunks = chunkKnowledge(text);
  const queryTerms = terms(query);

  const scored = chunks
    .map((chunk) => {
      const haystackHeading = chunk.heading.toLowerCase();
      const haystackBody = chunk.body.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (haystackHeading.includes(term)) score += 3;
        if (haystackBody.includes(term)) score += 1;
      }
      return { chunk, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // No keyword overlap (or an empty query): send the section index instead of
  // nothing, so the model can still orient itself and ask a follow-up.
  const picked =
    scored.length > 0
      ? scored.map((s) => s.chunk)
      : chunks.map((c) => ({ heading: c.heading, body: '' }));

  const sections: HelpResult['sections'] = [];
  let budget = MAX_RESULT_CHARS;
  for (const chunk of picked) {
    const content = chunk.body.slice(0, Math.max(0, budget));
    sections.push({ heading: chunk.heading, content });
    budget -= chunk.heading.length + content.length;
    if (budget <= 0 || sections.length >= 6) break;
  }

  return {
    source,
    sections,
    note:
      source === 'llms.txt'
        ? 'Content from abhibus.com/llms.txt. Summarise the relevant parts for the user.'
        : 'abhibus.com/llms.txt is currently unavailable; this is the built-in AbhiBus help summary. ' +
          'Summarise the relevant parts and avoid inventing specifics not present here.',
  };
}
