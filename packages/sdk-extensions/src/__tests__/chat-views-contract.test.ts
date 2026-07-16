// cinatra.views v1 leaf schema + tolerant parse (cinatra#1626, epic #1620 S9/M4).
//
// The chat renderable-view declaration surface — the S1 `cinatra.artifact.ui`
// sibling on a SEPARATE channel with its OWN ABI version. Pins the canonical v1
// shape the generator + conformance gate consume: valid v1, the strict entry
// shape, the viewType grammar, entry containment, the one-effective-provider-per-
// viewType duplicate rule, and the sanitized tolerant-parse degradation contract.
import { describe, it, expect } from "vitest";
import {
  CHAT_VIEWS_ABI_VERSION,
  CHAT_VIEW_TYPE_RE,
  isValidChatViewType,
  parseChatViews,
  validateChatViewsForPublish,
} from "../chat-views-contract";
import { isContainedEntryPath } from "../artifact-contract";

const entry = (over: Record<string, unknown> = {}) => ({
  viewType: "chart",
  entry: "./src/views/chart.tsx",
  propsApiVersion: 1,
  ...over,
});
const views = (entries: unknown[]) => ({ abiVersion: CHAT_VIEWS_ABI_VERSION, entries });

describe("cinatra.views v1 — constants + grammar", () => {
  it("the ABI version is 1", () => {
    expect(CHAT_VIEWS_ABI_VERSION).toBe(1);
  });
  it("viewType grammar is strict lowercase snake_case (matches the shipped wire viewTypes)", () => {
    for (const ok of ["chart", "content_change_proposal", "artifact_preview", "citation_group", "change_history", "a1_b2"]) {
      expect(isValidChatViewType(ok), ok).toBe(true);
      expect(CHAT_VIEW_TYPE_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["Chart", "content-change-proposal", "_leading", "trailing_", "double__underscore", "has space", "", "x!"]) {
      expect(isValidChatViewType(bad), bad).toBe(false);
    }
    for (const notString of [undefined, null, 1, {}, []]) {
      expect(isValidChatViewType(notString)).toBe(false);
    }
  });
  it("reuses the S1 entry-containment guard for the renderer subpath", () => {
    expect(isContainedEntryPath("./src/views/chart.tsx")).toBe(true);
    expect(isContainedEntryPath("../escape.tsx")).toBe(false);
  });
});

describe("parseChatViews — valid v1", () => {
  it("accepts a single provider entry", () => {
    const r = parseChatViews(views([entry()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.views.abiVersion).toBe(1);
      expect(r.views.entries).toHaveLength(1);
      expect(r.views.entries[0]?.viewType).toBe("chart");
    }
  });
  it("accepts multiple distinct viewTypes", () => {
    const r = parseChatViews(views([entry(), entry({ viewType: "content_change_proposal", entry: "./src/views/proposal.tsx", propsApiVersion: 2 })]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.views.entries.map((e) => e.viewType).sort()).toEqual(["chart", "content_change_proposal"]);
  });
});

describe("parseChatViews — rejections (fail-closed verdict; degrades at host)", () => {
  it("rejects a wrong abiVersion", () => {
    expect(parseChatViews({ ...views([entry()]), abiVersion: 2 }).ok).toBe(false);
  });
  it("rejects an empty entries array", () => {
    expect(parseChatViews(views([])).ok).toBe(false);
  });
  it("rejects a non-snake_case viewType", () => {
    expect(parseChatViews(views([entry({ viewType: "Chart" })])).ok).toBe(false);
    expect(parseChatViews(views([entry({ viewType: "content-change-proposal" })])).ok).toBe(false);
  });
  it("rejects an uncontained entry path (traversal / absolute / URL)", () => {
    for (const bad of ["../escape.tsx", "/abs/x.tsx", "https://cdn.example.com/x.js", "src/no-dot-slash.tsx"]) {
      expect(parseChatViews(views([entry({ entry: bad })])).ok, bad).toBe(false);
    }
  });
  it("rejects a non-integer / < 1 propsApiVersion", () => {
    expect(parseChatViews(views([entry({ propsApiVersion: 0 })])).ok).toBe(false);
    expect(parseChatViews(views([entry({ propsApiVersion: 1.5 })])).ok).toBe(false);
  });
  it("rejects an extraneous entry key (the closed v1 shape declares no host ports)", () => {
    expect(parseChatViews(views([entry({ ports: ["settings"] })])).ok).toBe(false);
    expect(parseChatViews(views([entry({ propsApiVersion: 1, extra: true })])).ok).toBe(false);
  });
  it("rejects an extraneous TOP-LEVEL key", () => {
    expect(parseChatViews({ ...views([entry()]), extra: true }).ok).toBe(false);
  });
});

describe("parseChatViews — duplicate rule (one effective provider per viewType)", () => {
  it("rejects two entries declaring the same viewType within a manifest", () => {
    const r = parseChatViews(views([entry(), entry({ entry: "./src/views/chart2.tsx" })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic).toMatch(/cinatra\.views is invalid/);
  });
  it("accepts distinct viewTypes (no false-positive)", () => {
    expect(parseChatViews(views([entry(), entry({ viewType: "citation_group", entry: "./src/views/cite.tsx" })])).ok).toBe(true);
  });
});

describe("parseChatViews — sanitized diagnostics + never-throws", () => {
  it("never echoes a received value (only path + zod code)", () => {
    const secret = "SUPER-SECRET-SMUGGLED-STRING";
    const r = parseChatViews(views([entry({ entry: secret })]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic).not.toContain(secret);
      expect(r.diagnostic).toMatch(/cinatra\.views is invalid/);
    }
  });
  it("never throws on arbitrary garbage input", () => {
    for (const garbage of [null, undefined, 42, "str", [], { entries: 1 }, { abiVersion: 1 }]) {
      expect(() => parseChatViews(garbage)).not.toThrow();
      expect(parseChatViews(garbage).ok).toBe(false);
    }
  });
});

describe("validateChatViewsForPublish — fail-closed wrapper", () => {
  it("valid block → { valid: true }", () => {
    expect(validateChatViewsForPublish(views([entry()]))).toEqual({ valid: true, errors: [] });
  });
  it("invalid block → { valid: false } with the sanitized diagnostic as an error", () => {
    const r = validateChatViewsForPublish(views([entry({ viewType: "Bad" })]));
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/cinatra\.views is invalid/);
  });
});
