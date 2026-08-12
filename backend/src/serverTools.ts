/**
 * serverTools.ts
 * ---------------------------------------------------------------------------
 * Tools the GATEWAY executes itself, without the SSE round trip to the browser.
 *
 * Everything that needs the user's AbhiBus session still runs in the tab; these
 * two need only data the server already holds, so answering locally saves a
 * full network hop per call and works even before the extension has replied to
 * anything:
 *
 *   resolveCityIds  — the 22k-row station master (stations.ts)
 *   getHelpContent  — llm.txt / built-in FAQ pack (knowledge.ts)
 *
 * The chat route still emits a display-only `server_tool` SSE event for each,
 * so the panel shows the same ticket-stub activity chips either way.
 * ---------------------------------------------------------------------------
 */

import type { ToolOutcome } from './llm/llmAdapter.js';
import { resolveStation, type StationMatch } from './stations.js';
import { searchHelp } from './knowledge.js';

const SERVER_TOOLS = new Set(['resolveCityIds', 'getHelpContent']);

export function isServerTool(name: string): boolean {
  return SERVER_TOOLS.has(name);
}

/* ------------------------------------------------------------------------ */

function describeMatch(m: StationMatch): { id: number; name: string; state: string } {
  return { id: m.id, name: m.name, state: m.state };
}

function runResolveCityIds(args: Record<string, unknown>): ToolOutcome {
  const source = typeof args.source === 'string' ? args.source.trim() : '';
  const destination = typeof args.destination === 'string' ? args.destination.trim() : '';

  if (!source && !destination) {
    return { result: { resolved: false, hint: 'Provide a source and/or destination city name.' } };
  }

  const out: Record<string, unknown> = {};
  const unresolved: string[] = [];

  if (source) {
    const { match, alternatives } = resolveStation(source);
    if (match) {
      out.source = match.name; // canonical name — use THIS in searchBuses
      out.sourceId = match.id;
      if (alternatives.length) out.sourceAlternatives = alternatives.map(describeMatch);
    } else {
      unresolved.push(source);
    }
  }

  if (destination) {
    const { match, alternatives } = resolveStation(destination);
    if (match) {
      out.destination = match.name;
      out.destinationId = match.id;
      if (alternatives.length) out.destinationAlternatives = alternatives.map(describeMatch);
    } else {
      unresolved.push(destination);
    }
  }

  if (unresolved.length) {
    return {
      result: {
        resolved: false,
        unresolved,
        hint:
          'No station in the AbhiBus master matches these names. Ask the user to ' +
          'confirm the city (they may have used an uncommon spelling).',
        ...out,
      },
    };
  }

  return {
    result: {
      resolved: true,
      note: 'Pass these exact names and ids to searchBuses.',
      ...out,
    },
  };
}

async function runGetHelpContent(args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const result = await searchHelp(query);
  return { result };
}

/* ------------------------------------------------------------------------ */

/** Execute a server-side tool. Never throws — errors become tool results the
 *  model can read and recover from. */
export async function runServerTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'resolveCityIds':
        return runResolveCityIds(args);
      case 'getHelpContent':
        return await runGetHelpContent(args);
      default:
        return { error: { code: 'UNKNOWN_TOOL', message: `Not a server tool: ${name}` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[serverTools] ${name} failed:`, message);
    return { error: { code: 'UNKNOWN', message } };
  }
}
