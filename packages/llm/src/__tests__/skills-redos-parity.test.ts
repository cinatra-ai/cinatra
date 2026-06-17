import { describe, it, expect, vi } from "vitest";

// The three helpers under test are PURE string parsers, but `../tools/skills`
// transitively pulls the skills SDK + the LLM provider-surface registry. Stub
// those module boundaries (mirrors skill-delivery.test.ts / skills-build.test.ts)
// so this suite can import the helpers in isolation without resolving the full
// host workspace dependency graph.
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({ installed: { get: vi.fn() } }),
}));
vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: async () => "",
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(() => {
    throw new Error("not installed");
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

import {
  stripCdPrefix,
  splitOnAmpAmp,
  parseSedReadCommand,
} from "../tools/skills";

// ---------------------------------------------------------------------------
// ReDoS-PARITY for the local skill-shell command parser. The three helpers
// replaced anchored quadratic regexes (CodeQL js/polynomial-redos) with linear
// scanners. These tests prove each rewrite is behaviour-equivalent to the
// retired regex (same accept/reject + same captures), including on the
// tab-heavy / slash-heavy inputs CodeQL highlighted.
// ---------------------------------------------------------------------------

// --- legacy oracles: the EXACT pre-fix regexes ----------------------------

// Old: effectiveCommand.match(/^cd\s+"?([^"&]+)"?\s*&&\s*/); then slice(m[0].length).
// stripCdPrefix returns the remainder (NOT yet .trim()'d) or null.
function legacyStripCdPrefix(command: string): string | null {
  const m = command.match(/^cd\s+"?([^"&]+)"?\s*&&\s*/);
  return m ? command.slice(m[0].length) : null;
}

function legacySplit(value: string): string[] {
  return value.split(/\s*&&\s*/);
}

function legacyParseSed(
  seg: string,
): { lineCount: string; path: string } | null {
  const m = seg.match(/^sed\s+-n\s+['"]?(?:\d+,)?(\d+)p['"]?\s+(.+)$/);
  return m ? { lineCount: m[1]!, path: m[2]! } : null;
}

describe("stripCdPrefix ReDoS-parity", () => {
  const cases = [
    'cd "/skills/foo" && cat file',
    "cd /skills/foo && cat file",
    "cd skills && head -n 5 x",
    "cd   skills/bar   &&   cat y",
    'cd "a b c" && tail z',
    "cd foo&&bar", // no whitespace around &&
    `cd ${"\t".repeat(50)}x${"\t".repeat(50)}&& cat z`, // tab flood
    `cd x${"\t".repeat(2000)}`, // no && at all
    'cd "', // open quote, no dir
    "cdx && y", // not `cd` + whitespace
    "cd && y", // empty dir
    "notcd",
    'cd a"&&b', // lone " then && — old [^"&]+ cannot cross
    "cd a&&b&&c",
    "cd   ", // whitespace only after cd
  ];
  it("matches the retired /^cd\\s+\"?([^\"&]+)\"?\\s*&&\\s*/ remainder/null", () => {
    for (const c of cases) {
      expect(stripCdPrefix(c)).toBe(legacyStripCdPrefix(c));
    }
  });
  it("stays linear on a pathological tab flood with no &&", () => {
    const started = Date.now();
    expect(stripCdPrefix(`cd ${"\t".repeat(200_000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("splitOnAmpAmp ReDoS-parity", () => {
  const cases = [
    "a && b && c",
    "cat x",
    "cd a &&cat b",
    "  a  &&  b  ",
    "a&&b&&c",
    "\t&&\t",
    `a && ${"\t".repeat(2000)}`,
    "&&",
    "",
    "a &&&& b",
    "x && y && ",
    "printf '%s\\n' path && sed -n '1,220p' path",
  ];
  it("matches the retired value.split(/\\s*&&\\s*/) output", () => {
    for (const c of cases) {
      expect(splitOnAmpAmp(c)).toEqual(legacySplit(c));
    }
  });
  it("stays linear on whitespace flood after &&", () => {
    const started = Date.now();
    expect(splitOnAmpAmp(`a &&${"\t".repeat(200_000)}b`)).toEqual(["a", "b"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("parseSedReadCommand ReDoS-parity", () => {
  const cases = [
    "sed -n '1,220p' /skills/x",
    "sed -n 5p file.txt",
    'sed -n "10,40p" path/to/file',
    "sed -n 0p file",
    "sed   -n   '1,9p'   a b c",
    "sed -n 1,2,3p x", // only one optional "<digits>," group
    "sed -n p file", // no number -> reject
    "cat x", // not sed
    `sed -n '5p' ${"\t".repeat(2000)}path`,
    "sed -n 12p", // no trailing path
    "sed -n 12p ", // trailing whitespace only -> (.+) needs >=1
    "sed -n 7p a\nb", // newline inside path -> (.+) stops at \n, $ fails
    "sed-n 5p x", // missing whitespace after sed
    "sed -n5p x", // missing whitespace after -n
    "sed -n '5p x", // open quote, no close
    "sed -n 5p\tx", // tab as the \s+ before the path
  ];
  it("matches the retired /^sed\\s+-n\\s+['\"]?(?:\\d+,)?(\\d+)p['\"]?\\s+(.+)$/ captures", () => {
    for (const c of cases) {
      expect(parseSedReadCommand(c)).toEqual(legacyParseSed(c));
    }
  });
  it("stays linear on a tab flood between -n and the number", () => {
    const started = Date.now();
    expect(parseSedReadCommand(`sed -n ${"\t".repeat(200_000)}x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
