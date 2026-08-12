/**
 * tools.ts
 * ---------------------------------------------------------------------------
 * Tool definitions for the eight AbhiBus endpoints captured in
 * `ABHIBUS_public_API_-_Sheet1.csv`.
 *
 * IMPORTANT: `name` values here MUST match the keys of
 * `AbhiBusAPIRegistry.handlers` in extension/src/apiRegistry.js. The backend
 * never calls abhibus.com itself — it only names the function it wants the
 * extension to run inside the user's authenticated tab.
 *
 * Schemas are written in the JSON-Schema subset all three providers accept.
 * `llm/schema.ts` handles the per-provider dialect differences.
 * ---------------------------------------------------------------------------
 */

import type { ToolDefinition } from './types.js';

/** Shared date-format hint reused across several schemas. */
const JDATE_DESC =
  'Journey date in YYYY-MM-DD format (e.g. 2026-08-15). Resolve relative ' +
  'phrases like "tomorrow" or "next Friday" against the current date before calling.';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  /* ---------------------------------------------------------------------
   * 1. POST /wap/abhicash   (CSV row 1 — "get currently abhicash details")
   * ------------------------------------------------------------------- */
  {
    name: 'getAbhiCashBalance',
    requiresAuth: true,
    description:
      'Get the signed-in user\'s current AbhiCash wallet balance and summary ' +
      '(usable balance, promotional/expiring credits). Use this for any question ' +
      'about "balance", "AbhiCash", "wallet money", or "how much do I have".',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 2. POST /wap/getWallet  (CSV row 2 — wallet transaction history)
   *    Note: this endpoint is form-urlencoded, not JSON.
   * ------------------------------------------------------------------- */
  {
    name: 'getWalletHistory',
    requiresAuth: true,
    description:
      'Get the full AbhiCash wallet transaction history (credits, debits, refunds, ' +
      'cashback) for the signed-in user. Use when the user asks about past wallet ' +
      'activity, "where did my money go", refunds received, or cashback earned. ' +
      'For the current balance alone prefer getAbhiCashBalance.',
    parameters: {
      type: 'object',
      properties: {
        transactionId: {
          type: 'string',
          description:
            'Optional. Filter to a single transaction id. Leave empty to fetch all.',
        },
        mode: {
          type: 'string',
          description:
            'Optional listing mode understood by the endpoint. Defaults to "1" (all transactions).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 3. POST /buslist/v3/services  (CSV row 3 — "Listing of all the buses")
   * ------------------------------------------------------------------- */
  {
    name: 'searchBuses',
    requiresAuth: false,
    description:
      'Search available bus services between two cities on a given date. Returns ' +
      'operators, departure/arrival times, bus types, fares and seat availability. ' +
      'Both the city NAME and the numeric AbhiBus city ID are required — if you only ' +
      'know the names, call resolveCityIds first, or read them from the current ' +
      'search-results URL which has the form /bus_search/Goa/102/Pune/51/15-08-2026/O.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Origin city name, e.g. "Goa".' },
        sourceId: {
          type: 'integer',
          description: 'Numeric AbhiBus id of the origin city, e.g. 102.',
        },
        destination: { type: 'string', description: 'Destination city name, e.g. "Pune".' },
        destinationId: {
          type: 'integer',
          description: 'Numeric AbhiBus id of the destination city, e.g. 51.',
        },
        jdate: { type: 'string', description: JDATE_DESC },
        filter: {
          type: 'string',
          description:
            'Optional bus-type constraint taken from the user\'s words, e.g. "ac", ' +
            '"non ac", "sleeper", "ac sleeper", "seater", "volvo". When set, the ' +
            'results (and the card the user sees) contain only matching buses — ' +
            'ALWAYS set it when the user names a bus type.',
        },
        isReturnJourney: {
          type: 'string',
          enum: ['0', '1'],
          description: 'Set to "1" only for the return leg of a round trip. Defaults to "0".',
        },
      },
      required: ['source', 'sourceId', 'destination', 'destinationId', 'jdate'],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 4. POST /wap/GetSeatLayout  (CSV row 4)
   * ------------------------------------------------------------------- */
  {
    name: 'getSeatLayout',
    requiresAuth: false,
    description:
      'Get the seat map for one specific bus service: which seats are available or ' +
      'booked, sleeper vs seater, upper vs lower deck, ladies-only seats and ' +
      'per-seat fares. Requires the serviceKey and operatorId returned by searchBuses, ' +
      'so call searchBuses first unless the user is already on a seat-layout page.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Numeric origin city id as a string, e.g. "102".' },
        destinationId: {
          type: 'string',
          description: 'Numeric destination city id as a string, e.g. "51".',
        },
        jdate: { type: 'string', description: JDATE_DESC },
        serviceKey: {
          type: 'string',
          description:
            'IMPORTANT: pass the serviceId value (NOT serviceKey) of the chosen bus ' +
            'from searchBuses results — the seat endpoint names it serviceKey but ' +
            'expects the serviceId.',
        },
        operatorId: {
          type: 'string',
          description: 'Operator id of the chosen bus, from searchBuses results.',
        },
        isReturnJourney: {
          type: 'string',
          enum: ['0', '1'],
          description: 'Defaults to "0".',
        },
      },
      required: ['sourceId', 'destinationId', 'jdate', 'serviceKey', 'operatorId'],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 5. POST /wap/getSeatLayoutOffers  (CSV row 5)
   *    NB: the live endpoint misspells the destination field as
   *    "destionationID" — preserved verbatim in the extension registry.
   * ------------------------------------------------------------------- */
  {
    name: 'getSeatLayoutOffers',
    requiresAuth: false,
    description:
      'Get coupons, discounts and promotional offers applicable to one specific bus ' +
      'service. Use for questions about "offers", "coupons", "discount codes" or ' +
      '"how do I pay less" when a particular bus has been chosen.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Numeric origin city id as a string.' },
        destinationId: { type: 'string', description: 'Numeric destination city id as a string.' },
        jdate: { type: 'string', description: JDATE_DESC },
        operatorId: { type: 'string', description: 'Operator id from searchBuses.' },
        serviceKey: { type: 'string', description: 'Service key from searchBuses.' },
        travelPartnerKey: {
          type: 'string',
          description: 'Travel partner key from searchBuses results, e.g. "173".',
        },
      },
      required: ['sourceId', 'destinationId', 'jdate', 'operatorId', 'serviceKey'],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 6. GET /wap/Passengers  (CSV row 6 — no request body)
   * ------------------------------------------------------------------- */
  {
    name: 'getSavedPassengers',
    requiresAuth: true,
    description:
      'Get the saved passenger profiles on the user\'s account (names, ages, genders) ' +
      'that can be reused when filling in traveller details.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 6b. Account identity — session JWT claims + GET /wap/Passengers.
   *     Implemented in the extension (apiRegistry.getUserProfile).
   * ------------------------------------------------------------------- */
  {
    name: 'getUserProfile',
    requiresAuth: true,
    description:
      'Get the signed-in user\'s account identity — name, email and phone — plus ' +
      'the saved traveller profiles on the account (name, age, gender). Use for ' +
      '"my profile", "my details", "tell me about me", "what is my email/phone". ' +
      'Date of birth is not available from AbhiBus.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 7. POST /wap/GetBookings  (CSV row 7)
   * ------------------------------------------------------------------- */
  {
    name: 'getBookings',
    requiresAuth: true,
    description:
      'Get the signed-in user\'s bus booking history — upcoming trips, completed trips ' +
      'and cancellations, including PNR/ticket numbers, boarding points, seat numbers ' +
      'and fares. Use for "my bookings", "my tickets", "PNR", "upcoming trip", ' +
      '"when is my bus".',
    parameters: {
      type: 'object',
      properties: {
        bookType: {
          type: 'string',
          description: 'Booking channel filter understood by the endpoint. Defaults to "Mobile".',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 8. POST /wap/getFailureTrips  (CSV row 8)
   * ------------------------------------------------------------------- */
  {
    name: 'getFailedTrips',
    requiresAuth: true,
    description:
      'Get bookings that failed or were left incomplete (payment failed, seat blocked ' +
      'but not confirmed). Use when the user says money was deducted but no ticket ' +
      'arrived, or asks about a failed/pending booking or a stuck refund.',
    parameters: {
      type: 'object',
      properties: {
        bookType: {
          type: 'string',
          description: 'Booking channel filter. Defaults to "Mobile".',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 9. Server-side: the full AbhiBus station master (22,000+ stations) lives
   *    in the gateway (stations.ts), so any city name resolves instantly —
   *    no extension round trip. See serverTools.ts.
   * ------------------------------------------------------------------- */
  {
    name: 'resolveCityIds',
    requiresAuth: false,
    serverSide: true,
    description:
      'Convert city names into the numeric AbhiBus station ids that searchBuses ' +
      'requires, using the full station database (22,000+ stations, old names and ' +
      'common misspellings included). Always call this before searchBuses unless the ' +
      'current page URL already contains both ids. The response includes the canonical ' +
      'station name for each id — pass those exact names and ids to searchBuses.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Origin city name to resolve, e.g. "Pune".' },
        destination: {
          type: 'string',
          description: 'Destination city name to resolve, e.g. "Goa".',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },

  /* ---------------------------------------------------------------------
   * 10. Server-side: FAQ / policy knowledge from abhibus.com/llm.txt (with a
   *     built-in fallback pack). See knowledge.ts.
   * ------------------------------------------------------------------- */
  {
    name: 'getHelpContent',
    requiresAuth: false,
    serverSide: true,
    description:
      'Look up AbhiBus help, FAQ and policy content: cancellations, refunds, ' +
      'rescheduling, failed payments, AbhiCash rules, coupons, boarding/m-ticket ' +
      'rules, bus tracking, contacting support, and general questions about AbhiBus. ' +
      'Call this for any how-does-it-work or policy question instead of answering ' +
      'from memory, then summarise the returned sections for the user.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The user\'s question, or keywords from it, e.g. "cancellation refund charges".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

/** Fast lookup used for validating tool names coming back from a model. */
export const TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_DEFINITIONS.map((t) => t.name),
);

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}
