// bench-cold-start.mjs — DEVPERF-01 invariant tests for the trace parser.
//
// Why: `compilePathMsFor(route, floorMs)` is the heart of the secondary
// (dynamic) acceptance metric. Two subtle correctness properties:
//
//   1) Trace lines are JSON-LINES-OF-ARRAYS, not single objects per line.
//      The script handles both shapes; a future "simplify the parser" PR
//      could drop array-flattening and silently miss every span.
//   2) The `floorMs` filter excludes spans with `startTime < floorMs`. In
//      warm-mode runs (.next NOT wiped between runs) a stale compile-path
//      span from a prior cold run would be misreported as a fresh warm
//      compile if the floor wasn't applied. This is the central
//      correctness property that lets warm and cold modes coexist.
//
// The function is not exported (the script is a CLI module with
// `main()` at top level). We re-derive it from the source file — the test
// fails loudly the moment the implementation drifts.

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "bench-cold-start.mjs");

// Surgically re-create the two parser functions in this test process so we can
// exercise them against synthetic trace files. The script reads from a hard-
// coded `TRACE` constant; we override it by injecting a closure when
// reconstructing the function bodies. The function texts are extracted from
// source verbatim so a drift in implementation surfaces as an extraction
// failure in `beforeAll`.
function extractFn(src, header) {
  const re = new RegExp(`function ${header}\\([\\s\\S]*?\\n\\}\\n`);
  const m = src.match(re);
  if (!m) throw new Error(`function ${header} not found in bench-cold-start.mjs`);
  return m[0];
}

let readTraceSpans;
let compilePathMsFor;
let setTracePath;

beforeAll(() => {
  const src = readFileSync(SCRIPT, "utf8");
  const readTraceText = extractFn(src, "readTraceSpans");
  const compileText = extractFn(src, "compilePathMsFor");
  // The function bodies reference `TRACE`, `existsSync`, `readFileSync`. We
  // inject all three through a Function-constructed closure that returns the
  // pair plus a TRACE setter (lets tests swap the file the parser reads).
  const factory = new Function(
    "existsSync",
    "readFileSync",
    `
    let TRACE = "";
    ${readTraceText}
    ${compileText}
    return { readTraceSpans, compilePathMsFor, setTracePath: (p) => { TRACE = p; } };
    `,
  );
  const { existsSync, readFileSync: rfs } = require("node:fs");
  const pair = factory(existsSync, rfs);
  readTraceSpans = pair.readTraceSpans;
  compilePathMsFor = pair.compilePathMsFor;
  setTracePath = pair.setTracePath;
});

// `require` is available in Vitest's default Node env. Mark this explicit.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function writeTrace(tracePath, lines) {
  mkdirSync(path.dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  setTracePath(tracePath);
}

describe("bench-cold-start.mjs — readTraceSpans handles JSON-lines-of-arrays", () => {
  it("flattens lines that are arrays of spans (the documented Next.js trace shape)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "trace-arr-"));
    try {
      const tracePath = path.join(tmp, "trace");
      writeTrace(tracePath, [
        [
          { name: "compile-path", tags: { trigger: "/a" }, duration: 1000, startTime: 100 },
          { name: "compile-path", tags: { trigger: "/b" }, duration: 2000, startTime: 200 },
        ],
        [{ name: "start-dev-server", tags: {}, duration: 50, startTime: 50 }],
      ]);
      const spans = readTraceSpans();
      expect(spans.length).toBe(3);
      expect(spans.filter((s) => s.name === "compile-path").length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts lines that are single span objects (not wrapped in an array)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "trace-obj-"));
    try {
      const tracePath = path.join(tmp, "trace");
      writeTrace(tracePath, [
        { name: "compile-path", tags: { trigger: "/x" }, duration: 333, startTime: 1 },
      ]);
      const spans = readTraceSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].tags.trigger).toBe("/x");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an empty array when the trace file does not exist", () => {
    setTracePath(path.join(tmpdir(), "definitely-not-a-real-trace-" + Date.now()));
    expect(readTraceSpans()).toEqual([]);
  });
});

describe("bench-cold-start.mjs — compilePathMsFor(route, floorMs) excludes stale spans", () => {
  it("returns the duration (µs->ms) for a span matching the route", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "trace-dur-"));
    try {
      writeTrace(path.join(tmp, "trace"), [
        [{ name: "compile-path", tags: { trigger: "/sign-in" }, duration: 9_066_000, startTime: 1000 }],
      ]);
      // floor below the span's startTime → included.
      expect(compilePathMsFor("/sign-in", 500)).toBe(9066);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("EXCLUDES spans whose startTime < floorMs (warm-run stale-span guard)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "trace-floor-"));
    try {
      writeTrace(path.join(tmp, "trace"), [
        // STALE span from a prior cold run, startTime well before the warm floor.
        [{ name: "compile-path", tags: { trigger: "/sign-in" }, duration: 9_066_000, startTime: 100 }],
      ]);
      // Warm run started at floor=10_000 — the stale span MUST be filtered out
      // or warm mode would misreport a cold compile as fresh.
      expect(compilePathMsFor("/sign-in", 10_000)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when no span matches the requested route", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "trace-miss-"));
    try {
      writeTrace(path.join(tmp, "trace"), [
        [{ name: "compile-path", tags: { trigger: "/other" }, duration: 1000, startTime: 100 }],
      ]);
      expect(compilePathMsFor("/sign-in", 0)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns the MAX duration when multiple post-floor spans match the same route", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "trace-max-"));
    try {
      writeTrace(path.join(tmp, "trace"), [
        [
          { name: "compile-path", tags: { trigger: "/sign-in" }, duration: 1_000_000, startTime: 1000 },
          { name: "compile-path", tags: { trigger: "/sign-in" }, duration: 5_000_000, startTime: 2000 },
        ],
      ]);
      expect(compilePathMsFor("/sign-in", 0)).toBe(5000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
