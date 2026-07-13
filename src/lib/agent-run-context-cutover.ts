// ---------------------------------------------------------------------------
// Run-context registry-cutover analysis (#1195, pre-metric remainder).
//
// The observability that judges parity for the metric-gated registry deletion.
// PURE and dependency-free ON PURPOSE: no `server-only`, no `ioredis`, no
// runtime state. It lives OUTSIDE src/lib/agent-run-context-durable.ts (which
// imports `server-only` + constructs an ioredis client and is reachable from
// the LOCKED /api/mcp route) so the offline analysis can be imported by a
// plain `node --import tsx` ops script AND so it never adds a dependency edge
// to a locked route's reachable-module graph. durable.ts deliberately does NOT
// re-export these symbols (a re-export would recreate that edge).
//
// WHAT IT DECIDES. #1195 acceptance requires PROOF that no production traffic
// still rides the legacy in-process registry before it is deleted (and before
// the fail-closed deny posture is activated). The MCP transport emits one
// per-request line fleet-wide:
//
//   [mcp-run-ctx] served-by=<channel> run=<id|-> suppressed=<bool> count=<n>
//
// (see recordMcpRunContextServedBy in agent-run-context-durable.ts). This
// module turns an AGGREGATED stream of those lines into the single go/no-go
// verdict the owner-gated registry-removal (flip) slice consults, instead of
// eyeballing counters.
//
// EVIDENCE INTEGRITY (converged with Codex, #1195 cutover-obs round). The
// verdict green-lights an IRREVERSIBLE deletion, so the analysis is fail-
// CLOSED end to end:
//   - the parser matches only the FULL emission shape (marker + run= +
//     suppressed= + count=), anchored per line and counted at most ONCE per
//     line, so quoted/injected/partial marker text in unrelated log lines
//     cannot inflate a channel;
//   - a line that carries the `[mcp-run-ctx] served-by=` marker but does NOT
//     match the full shape is counted as `malformedMarkerLines` — a positive
//     "untrustworthy stream" signal, never silently dropped;
//   - `judgeCutoverFromLogStream` refuses readiness when ANY malformed marker
//     line is present (garbled evidence is not proof), on top of the strict
//     `evaluateRegistryCutoverReadiness` gate (unknown channel / bad count /
//     insufficient or idle sample all fail closed).
// The CALLER must supply a canonical, complete, trusted, de-duplicated fleet
// log stream over an agreed window; replayed/duplicated lines would inflate
// the sample and are the operator's responsibility to exclude (the tool trusts
// its input by construction — it cannot see beyond the bytes it is given).
// ---------------------------------------------------------------------------

export type RegistryCutoverReadiness = {
  /** True only when the legacy channels served nothing over a sufficient,
   *  genuinely-active sample — the green light for the flip slice. */
  ready: boolean;
  /** Human-readable why (the not-ready cause, or the ready confirmation). */
  reason: string;
  /** registry + header served counts (the traffic that must reach zero). */
  legacyServed: number;
  /** obo + durable served counts (verified identity — must be non-zero, or
   *  the window proves nothing). */
  verifiedServed: number;
  /** Every served-by observation in the window, including "none". */
  total: number;
};

/** The closed set of served-by channels the gate understands. Kept in lockstep
 *  with RunContextServedBy in the mcp-server request-context module; an
 *  unrecognized key in the tally is treated as a schema drift and fails the
 *  gate closed rather than being silently ignored. */
const READINESS_KNOWN_CHANNELS: readonly string[] = [
  "obo",
  "durable",
  "registry",
  "header",
  "none",
];

/**
 * Decide whether the legacy registry can be retired, from an aggregated
 * served-by tally (keys: obo | durable | registry | header | none).
 *
 * ready ⇔ (registry + header served === 0)          — no legacy traffic, AND
 *         (total >= minObservations)                 — a real sample, AND
 *         (obo + durable served > 0)                 — the window was actually
 *                                                        serving verified runs.
 *
 * The verified-non-zero clause guards against a silent/idle window (zero
 * legacy traffic because there was NO run traffic at all) being mistaken for a
 * completed cutover.
 */
export function evaluateRegistryCutoverReadiness(
  servedBy: Record<string, number>,
  opts: { minObservations: number },
): RegistryCutoverReadiness {
  // Fail CLOSED on any input the gate cannot fully trust — this predicate
  // green-lights an IRREVERSIBLE deletion, so a NaN/negative/Infinity count, a
  // non-integer, an unknown channel, or a malformed threshold must NEVER be
  // silently coerced to a passing zero. Every reject path still reports the
  // best-effort tallies it could parse (for the operator), but ready === false.
  const cleanCount = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

  const counts: Record<string, number> = {};
  let malformed: string | null = null;
  for (const [key, value] of Object.entries(servedBy)) {
    if (!READINESS_KNOWN_CHANNELS.includes(key)) {
      malformed ??= `unrecognized served-by channel "${key}"`;
      continue;
    }
    const c = cleanCount(value);
    if (c === null) {
      malformed ??= `malformed count for channel "${key}"`;
      continue;
    }
    counts[key] = c;
  }
  const at = (key: string): number => counts[key] ?? 0;
  const legacyServed = at("registry") + at("header");
  const verifiedServed = at("obo") + at("durable");
  const total = legacyServed + verifiedServed + at("none");

  const minOk =
    typeof opts.minObservations === "number" &&
    Number.isInteger(opts.minObservations) &&
    opts.minObservations >= 1;

  if (malformed !== null) {
    return {
      ready: false,
      reason: `not ready: ${malformed}`,
      legacyServed,
      verifiedServed,
      total,
    };
  }
  if (!minOk) {
    return {
      ready: false,
      reason: "not ready: minObservations must be a positive integer",
      legacyServed,
      verifiedServed,
      total,
    };
  }

  let ready = true;
  let reason = `cutover-ready: 0 legacy-served over ${total} observation(s) (${verifiedServed} verified)`;
  if (legacyServed > 0) {
    ready = false;
    reason = `not ready: ${legacyServed} request(s) still served by a legacy channel (registry+header)`;
  } else if (total < opts.minObservations) {
    ready = false;
    reason = `not ready: insufficient sample (${total} < ${opts.minObservations} observations)`;
  } else if (verifiedServed === 0) {
    ready = false;
    reason =
      "not ready: no verified (obo/durable) traffic in the window — an idle sample cannot prove cutover";
  }

  return { ready, reason, legacyServed, verifiedServed, total };
}

// --- served-by log-stream parser --------------------------------------------

export type ServedByLogParse = {
  /** Per-channel tally of full-shape emissions (channel token verbatim,
   *  INCLUDING an unrecognized one — the strict gate rejects it, the parser
   *  never silently drops it). */
  servedBy: Record<string, number>;
  /** Total lines scanned. */
  linesScanned: number;
  /** Lines that matched the full `[mcp-run-ctx] served-by=` emission shape
   *  (each such line contributes exactly one channel increment). */
  matchedLines: number;
  /** Lines carrying the `[mcp-run-ctx] served-by=` marker that did NOT match
   *  the full emission shape — a positive untrustworthy-stream signal. */
  malformedMarkerLines: number;
};

/** The bare marker prefix — a line carrying this is CLAIMING to be a served-by
 *  emission and must therefore either match the full shape or be flagged. */
const SERVED_BY_MARKER = "[mcp-run-ctx] served-by=";

/** The full emission shape. Requiring the trailing `run= suppressed= count=`
 *  fields (not just the marker) resists counting quoted/injected marker text
 *  in unrelated log lines: a crafted line would have to reproduce the entire
 *  suffix. The channel capture is a bare lowercase token so an unrecognized
 *  channel is still captured (and later rejected by the strict gate) rather
 *  than dropped. Global-free, applied per line, first match only. */
const SERVED_BY_LINE =
  /\[mcp-run-ctx\] served-by=([a-z][a-z0-9_-]*) run=\S+ suppressed=(?:true|false) count=\d+/;

/**
 * Parse an aggregated fleet log stream into a served-by tally. Permissive on
 * WHICH channel (unknown tokens pass through for the strict gate to reject),
 * strict on WHAT counts as an emission (full shape only, one per line). Never
 * throws.
 */
export function parseServedByLogStream(text: string): ServedByLogParse {
  const servedBy: Record<string, number> = {};
  let linesScanned = 0;
  let matchedLines = 0;
  let malformedMarkerLines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    // Skip the trailing empty element from a final newline without counting it.
    if (rawLine.length === 0) continue;
    linesScanned++;
    const m = SERVED_BY_LINE.exec(rawLine);
    if (m) {
      const channel = m[1];
      servedBy[channel] = (servedBy[channel] ?? 0) + 1;
      matchedLines++;
    } else if (rawLine.includes(SERVED_BY_MARKER)) {
      // Claims to be an emission but is not a well-formed one — untrustworthy.
      malformedMarkerLines++;
    }
  }

  return { servedBy, linesScanned, matchedLines, malformedMarkerLines };
}

export type CutoverLogVerdict = {
  parse: ServedByLogParse;
  readiness: RegistryCutoverReadiness;
};

/**
 * End-to-end: parse a fleet log stream, then evaluate cutover readiness.
 * Fail-CLOSED beyond the strict gate: any `malformedMarkerLines` present makes
 * the verdict not-ready (a garbled emission stream is not proof for an
 * irreversible deletion), while still reporting the counts it could parse.
 */
export function judgeCutoverFromLogStream(
  text: string,
  opts: { minObservations: number },
): CutoverLogVerdict {
  const parse = parseServedByLogStream(text);
  const base = evaluateRegistryCutoverReadiness(parse.servedBy, opts);
  if (parse.malformedMarkerLines > 0) {
    return {
      parse,
      readiness: {
        ...base,
        ready: false,
        reason: `not ready: ${parse.malformedMarkerLines} malformed "[mcp-run-ctx] served-by=" line(s) — untrustworthy evidence stream`,
      },
    };
  }
  return { parse, readiness: base };
}
