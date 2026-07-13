/**
 * Registry-cutover parity observability (#1195, pre-metric remainder).
 *
 * The PURE leaf that judges whether the legacy in-process registry can be
 * retired, from an aggregated fleet `[mcp-run-ctx] served-by=` log stream. The
 * verdict green-lights an IRREVERSIBLE deletion, so every path fails CLOSED:
 *   - the strict readiness gate (unknown channel / bad count / insufficient or
 *     idle sample) — MOVED here byte-for-byte from agent-run-context-durable;
 *   - the log parser matches only the FULL emission shape, one per line, so
 *     quoted/injected/partial marker text cannot inflate a channel, and flags
 *     malformed marker lines instead of dropping them;
 *   - the composite judge refuses readiness when any malformed marker line is
 *     present (a garbled stream is not proof).
 */
import { describe, it, expect } from "vitest";
import {
  evaluateRegistryCutoverReadiness,
  parseServedByLogStream,
  judgeCutoverFromLogStream,
} from "@/lib/agent-run-context-cutover";

// A canonical well-formed emission line (matches recordMcpRunContextServedBy).
const line = (
  channel: string,
  opts: { run?: string; suppressed?: boolean; count?: number } = {},
): string =>
  `[mcp-run-ctx] served-by=${channel} run=${opts.run ?? "run_abc"} ` +
  `suppressed=${opts.suppressed === true} count=${opts.count ?? 1}`;

describe("registry cutover readiness gate", () => {
  const MIN = 100;

  it("READY: zero legacy-served over a sufficient, verified-active window", () => {
    const r = evaluateRegistryCutoverReadiness(
      { obo: 120, durable: 380, none: 5, registry: 0, header: 0 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(true);
    expect(r.legacyServed).toBe(0);
    expect(r.verifiedServed).toBe(500);
    expect(r.total).toBe(505);
  });

  it("NOT READY: any registry-served traffic blocks the flip", () => {
    const r = evaluateRegistryCutoverReadiness(
      { obo: 100, durable: 400, registry: 1 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(false);
    expect(r.legacyServed).toBe(1);
    expect(r.reason).toMatch(/legacy channel/i);
  });

  it("NOT READY: header-served traffic counts as legacy too", () => {
    const r = evaluateRegistryCutoverReadiness(
      { durable: 500, header: 3 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(false);
    expect(r.legacyServed).toBe(3);
  });

  it("NOT READY: sample below the minimum cannot prove cutover", () => {
    const r = evaluateRegistryCutoverReadiness(
      { obo: 5, durable: 4 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/insufficient sample/i);
  });

  it("NOT READY: an idle window (no verified traffic) is not a completed cutover", () => {
    const r = evaluateRegistryCutoverReadiness(
      { none: 500 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(false);
    expect(r.verifiedServed).toBe(0);
    expect(r.reason).toMatch(/no verified/i);
  });

  it("legacy traffic is checked BEFORE the sample-size clause (worst-cause wins)", () => {
    // registry present AND sample tiny — the legacy cause must be reported.
    const r = evaluateRegistryCutoverReadiness(
      { registry: 2, durable: 1 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/legacy channel/i);
  });

  it("FAILS CLOSED on a malformed legacy count (NaN registry never coerces to a passing zero)", () => {
    const r = evaluateRegistryCutoverReadiness(
      { obo: 1, durable: 999, registry: Number.NaN as unknown as number },
      { minObservations: 1 },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/malformed count.*registry/i);
  });

  it("FAILS CLOSED on negative or Infinity counts (unknowable traffic ≠ zero)", () => {
    for (const bad of [-3, Number.POSITIVE_INFINITY]) {
      const r = evaluateRegistryCutoverReadiness(
        { obo: 500, header: bad as number },
        { minObservations: MIN },
      );
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/malformed count.*header/i);
    }
  });

  it("FAILS CLOSED on a non-integer count (request tallies are whole numbers)", () => {
    const r = evaluateRegistryCutoverReadiness(
      { obo: 250.5 as number, durable: 250 },
      { minObservations: MIN },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/malformed count.*obo/i);
  });

  it("FAILS CLOSED on an unrecognized channel (schema drift is not silently ignored, and never inflates total)", () => {
    const r = evaluateRegistryCutoverReadiness(
      { obo: 1, durable: 1, typo: 999 as number },
      { minObservations: 1000 },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/unrecognized served-by channel.*typo/i);
    // The unknown key must NOT be counted toward the sample size.
    expect(r.total).toBe(2);
  });

  it("FAILS CLOSED on a malformed threshold (NaN / 0 / negative / non-integer minObservations)", () => {
    for (const bad of [Number.NaN, 0, -5, 2.5]) {
      const r = evaluateRegistryCutoverReadiness(
        { obo: 10, durable: 10 },
        { minObservations: bad as number },
      );
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/minObservations/i);
    }
  });

  it("a valid threshold met exactly is ready (boundary)", () => {
    const r = evaluateRegistryCutoverReadiness(
      { durable: 10 },
      { minObservations: 10 },
    );
    expect(r.ready).toBe(true);
    expect(r.total).toBe(10);
  });
});

describe("parseServedByLogStream", () => {
  it("tallies well-formed emission lines by channel, one per line", () => {
    const text = [
      line("obo"),
      line("durable", { run: "-" }),
      line("durable"),
      line("registry", { suppressed: true }),
      line("none", { run: "-" }),
    ].join("\n");
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({ obo: 1, durable: 2, registry: 1, none: 1 });
    expect(p.matchedLines).toBe(5);
    expect(p.linesScanned).toBe(5);
    expect(p.malformedMarkerLines).toBe(0);
  });

  it("tolerates real log prefixes (timestamp / level / worker) around the marker", () => {
    const text = [
      `2026-07-13T10:00:00.123Z INFO [worker-2] ${line("obo")}`,
      `{"ts":"...","lvl":"info","msg":"${line("durable")}"}`,
    ].join("\n");
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({ obo: 1, durable: 1 });
    expect(p.malformedMarkerLines).toBe(0);
  });

  it("ignores unrelated lines and blank lines without inflating the scan", () => {
    const text = `\nhello world\n${line("durable")}\n\nGET /api/mcp 200\n`;
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({ durable: 1 });
    // 3 non-empty lines: 'hello world', the emission, 'GET /api/mcp 200'.
    expect(p.linesScanned).toBe(3);
    expect(p.matchedLines).toBe(1);
  });

  it("captures an UNKNOWN channel token verbatim (never drops it — the gate rejects it)", () => {
    const text = line("bogus");
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({ bogus: 1 });
    expect(p.malformedMarkerLines).toBe(0);
  });

  it("counts at most ONE channel per line (a crafted multi-marker line cannot inflate)", () => {
    // Two full-shape markers on one physical line — only the first counts.
    const text = `${line("obo")} ${line("durable")}`;
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({ obo: 1 });
    expect(p.matchedLines).toBe(1);
  });

  it("flags a marker line missing the trailing fields as malformed, not a count", () => {
    const text = [
      `[mcp-run-ctx] served-by=durable`, // truncated: no run=/suppressed=/count=
      `[mcp-run-ctx] served-by=obo run=x`, // partial
      line("durable"),
    ].join("\n");
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({ durable: 1 });
    expect(p.matchedLines).toBe(1);
    expect(p.malformedMarkerLines).toBe(2);
  });

  it("does NOT match an injected/quoted marker that lacks the full emission shape", () => {
    // A hostile line embedding the marker text as data (no valid suffix) must
    // not become a phantom verified-channel count.
    const text = `user said: "[mcp-run-ctx] served-by=durable is fake"`;
    const p = parseServedByLogStream(text);
    expect(p.servedBy).toEqual({});
    expect(p.matchedLines).toBe(0);
    expect(p.malformedMarkerLines).toBe(1);
  });

  it("empty input yields an empty tally", () => {
    const p = parseServedByLogStream("");
    expect(p).toEqual({
      servedBy: {},
      linesScanned: 0,
      matchedLines: 0,
      malformedMarkerLines: 0,
    });
  });
});

describe("judgeCutoverFromLogStream", () => {
  it("READY when the parsed stream is clean, verified-active, and legacy-free", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(line("obo", { run: `r${i}` }));
    for (let i = 0; i < 40; i++) lines.push(line("durable", { run: `d${i}` }));
    const v = judgeCutoverFromLogStream(lines.join("\n"), { minObservations: 100 });
    expect(v.readiness.ready).toBe(true);
    expect(v.readiness.legacyServed).toBe(0);
    expect(v.readiness.verifiedServed).toBe(100);
    expect(v.parse.matchedLines).toBe(100);
  });

  it("NOT READY when any legacy channel served in the stream", () => {
    const lines = [line("durable"), line("registry")];
    const v = judgeCutoverFromLogStream(lines.join("\n"), { minObservations: 1 });
    expect(v.readiness.ready).toBe(false);
    expect(v.readiness.legacyServed).toBe(1);
    expect(v.readiness.reason).toMatch(/legacy channel/i);
  });

  it("FAILS CLOSED when a malformed marker line is present, even if the tally would pass", () => {
    // A clean, would-be-ready tally PLUS one garbled marker line.
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(line("durable", { run: `d${i}` }));
    lines.push(`[mcp-run-ctx] served-by=durable`); // malformed (no suffix)
    const v = judgeCutoverFromLogStream(lines.join("\n"), { minObservations: 50 });
    expect(v.readiness.ready).toBe(false);
    expect(v.readiness.reason).toMatch(/untrustworthy evidence/i);
    expect(v.parse.malformedMarkerLines).toBe(1);
    // Counts it could parse are still reported for the operator.
    expect(v.readiness.verifiedServed).toBe(100);
  });

  it("FAILS CLOSED on an unknown channel surfaced by the parser (schema drift)", () => {
    const lines = [line("durable"), line("bogus")];
    const v = judgeCutoverFromLogStream(lines.join("\n"), { minObservations: 1 });
    expect(v.readiness.ready).toBe(false);
    expect(v.readiness.reason).toMatch(/unrecognized served-by channel.*bogus/i);
  });

  it("NOT READY on an empty/partial stream (no proof)", () => {
    const v = judgeCutoverFromLogStream("", { minObservations: 100 });
    expect(v.readiness.ready).toBe(false);
    expect(v.readiness.total).toBe(0);
    expect(v.readiness.reason).toMatch(/insufficient sample|no verified/i);
  });
});
