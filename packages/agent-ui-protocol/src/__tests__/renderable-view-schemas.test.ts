import { describe, expect, it } from "vitest";

import {
  KNOWN_RENDERABLE_VIEW_TYPES,
  RENDERABLE_VIEW_SCHEMAS,
  isKnownRenderableViewType,
  parseRenderableView,
  renderableViewDataPart,
  isRenderableViewOfType,
} from "../renderable-views/index";

// ---------------------------------------------------------------------------
// S4 (#1220) schema round-trip + hostile-payload suite. Proves every registered
// view schema (a) validates a canonical payload, (b) round-trips through the
// DATA_PART wrapper unchanged, (c) rejects malformed/hostile/forward-incompatible
// payloads to `null` (never throws), and (d) sanitizes URL-bearing fields.
// ---------------------------------------------------------------------------

const VALID: Record<string, Record<string, unknown>> = {
  content_change_proposal: {
    viewType: "content_change_proposal",
    schemaVersion: 1,
    surface: "wordpress",
    postId: "42",
    proposalId: "wp-42-prop-1",
    changeSetId: "rev-311",
    rich: false,
    fields: [
      { field: "title", before: "Old", after: "New" },
      { field: "excerpt", after: "Added" },
    ],
  },
  artifact_preview: {
    viewType: "artifact_preview",
    schemaVersion: 1,
    name: "report.pdf",
    kind: "document",
    mimeType: "application/pdf",
    href: "https://example.com/report.pdf",
    sizeBytes: 1024,
  },
  citation_group: {
    viewType: "citation_group",
    schemaVersion: 1,
    sources: [{ title: "Docs", url: "https://example.com", snippet: "hello" }],
  },
  change_history: {
    viewType: "change_history",
    schemaVersion: 1,
    entries: [{ runId: "run_1", label: "Edited title", undoable: true }],
  },
};

describe("registry integrity", () => {
  it("every schema key equals its viewType literal and has a coherent version", () => {
    for (const key of KNOWN_RENDERABLE_VIEW_TYPES) {
      const parsed = parseRenderableView(VALID[key]);
      expect(parsed, key).not.toBeNull();
      expect(parsed?.viewType).toBe(key);
      expect(RENDERABLE_VIEW_SCHEMAS[key].version).toBe(
        (VALID[key] as { schemaVersion: number }).schemaVersion,
      );
    }
  });

  it("covers exactly the four S4 views", () => {
    expect([...KNOWN_RENDERABLE_VIEW_TYPES].sort()).toEqual([
      "artifact_preview",
      "change_history",
      "citation_group",
      "content_change_proposal",
    ]);
  });
});

describe("round-trip through the DATA_PART wrapper", () => {
  it("wraps and re-parses each view unchanged", () => {
    for (const key of KNOWN_RENDERABLE_VIEW_TYPES) {
      const ev = renderableViewDataPart(
        VALID[key] as Parameters<typeof renderableViewDataPart>[0],
      );
      expect(ev.type).toBe("DATA_PART");
      expect(isRenderableViewOfType(ev.data, key)).toBe(true);
      const parsed = parseRenderableView(ev.data);
      expect(parsed).toMatchObject({ viewType: key });
    }
  });
});

describe("hostile / malformed payloads → null (never throws)", () => {
  it("rejects an unknown viewType", () => {
    expect(parseRenderableView({ viewType: "totally_unknown", schemaVersion: 1 })).toBeNull();
    expect(isKnownRenderableViewType("totally_unknown")).toBe(false);
  });

  it("rejects a forward-incompatible schemaVersion", () => {
    expect(
      parseRenderableView({ ...VALID.content_change_proposal, schemaVersion: 2 }),
    ).toBeNull();
  });

  it("rejects a missing required field", () => {
    const noRich = { ...VALID.content_change_proposal };
    delete (noRich as { rich?: boolean }).rich;
    expect(parseRenderableView(noRich)).toBeNull();
  });

  it("rejects an over-long field value (bounds enforced)", () => {
    expect(
      parseRenderableView({
        ...VALID.content_change_proposal,
        fields: [{ field: "x", after: "y".repeat(20_001) }],
      }),
    ).toBeNull();
  });

  it("rejects too many entries (array bound)", () => {
    expect(
      parseRenderableView({
        viewType: "change_history",
        schemaVersion: 1,
        entries: Array.from({ length: 201 }, (_, i) => ({
          runId: `r${i}`,
          label: "x",
          undoable: false,
        })),
      }),
    ).toBeNull();
  });

  it("does not throw on non-object / array / null / primitive payloads", () => {
    for (const bad of [null, undefined, 5, "str", [], [{ viewType: "x" }], true]) {
      expect(() => parseRenderableView(bad)).not.toThrow();
      expect(parseRenderableView(bad)).toBeNull();
    }
  });

  it("does not throw on an object whose `viewType` getter throws", () => {
    const hostile = {
      get viewType(): string {
        throw new Error("boom");
      },
    };
    expect(() => parseRenderableView(hostile)).not.toThrow();
    expect(parseRenderableView(hostile)).toBeNull();
  });

  it("does not throw on a Proxy with a throwing get trap", () => {
    const trap = new Proxy(
      { viewType: "content_change_proposal" },
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(() => parseRenderableView(trap)).not.toThrow();
    expect(parseRenderableView(trap)).toBeNull();
  });

  it("preserves a script-bearing field value as inert data (no throw, kept as text)", () => {
    const parsed = parseRenderableView({
      ...VALID.content_change_proposal,
      fields: [{ field: "body", before: "clean", after: "<script>alert(1)</script>" }],
    });
    // The schema does not strip the text — XSS is prevented at RENDER time by
    // emitting it as a text node. But the value must survive validation intact.
    expect(parsed).not.toBeNull();
    if (parsed && parsed.viewType === "content_change_proposal") {
      expect(parsed.fields[0].after).toBe("<script>alert(1)</script>");
    }
  });
});

describe("content_change_proposal correlation ids (Option A: refresh of the already-written draft)", () => {
  it("preserves proposalId / changeSetId through validation (the S5 refresh consumer keys on them)", () => {
    const parsed = parseRenderableView(VALID.content_change_proposal);
    expect(parsed).not.toBeNull();
    if (parsed && parsed.viewType === "content_change_proposal") {
      expect(parsed.proposalId).toBe("wp-42-prop-1");
      expect(parsed.changeSetId).toBe("rev-311");
    }
  });

  it("both ids stay optional — a proposal without them still parses (no draft correlation)", () => {
    const bare = { ...VALID.content_change_proposal };
    delete (bare as { proposalId?: string }).proposalId;
    delete (bare as { changeSetId?: string }).changeSetId;
    const parsed = parseRenderableView(bare);
    expect(parsed).not.toBeNull();
    if (parsed && parsed.viewType === "content_change_proposal") {
      expect(parsed.proposalId).toBeUndefined();
      expect(parsed.changeSetId).toBeUndefined();
    }
  });

  it("rejects an over-long correlation id (bounds enforced)", () => {
    expect(
      parseRenderableView({
        ...VALID.content_change_proposal,
        proposalId: "p".repeat(201),
      }),
    ).toBeNull();
    expect(
      parseRenderableView({
        ...VALID.content_change_proposal,
        changeSetId: "c".repeat(201),
      }),
    ).toBeNull();
  });

  it("rejects an empty-string correlation id (present means non-empty)", () => {
    expect(
      parseRenderableView({ ...VALID.content_change_proposal, proposalId: "" }),
    ).toBeNull();
    expect(
      parseRenderableView({ ...VALID.content_change_proposal, changeSetId: "" }),
    ).toBeNull();
  });

  it("rejects a non-string correlation id (opaque STRING, never an object)", () => {
    expect(
      parseRenderableView({
        ...VALID.content_change_proposal,
        proposalId: { $oid: "x" },
      }),
    ).toBeNull();
  });
});

describe("URL sanitization at the schema layer", () => {
  it("drops a javascript: artifact href to undefined", () => {
    const parsed = parseRenderableView({
      viewType: "artifact_preview",
      schemaVersion: 1,
      name: "evil",
      href: "javascript:alert(1)",
    });
    expect(parsed).not.toBeNull();
    if (parsed && parsed.viewType === "artifact_preview") {
      expect(parsed.href).toBeUndefined();
    }
  });

  it("drops a protocol-relative and data: citation url, keeps https", () => {
    const parsed = parseRenderableView({
      viewType: "citation_group",
      schemaVersion: 1,
      sources: [
        { title: "a", url: "//evil.example/x" },
        { title: "b", url: "data:text/html,<script>1</script>" },
        { title: "c", url: "https://ok.example" },
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed && parsed.viewType === "citation_group") {
      expect(parsed.sources[0].url).toBeUndefined();
      expect(parsed.sources[1].url).toBeUndefined();
      expect(parsed.sources[2].url).toBe("https://ok.example");
    }
  });

  it("drops backslash / mixed-slash protocol-relative bypasses", () => {
    for (const href of ["\\\\evil.example/x", "/\\evil.example", "\\/evil.example"]) {
      const parsed = parseRenderableView({
        viewType: "artifact_preview",
        schemaVersion: 1,
        name: "evil",
        href,
      });
      if (parsed && parsed.viewType === "artifact_preview") {
        expect(parsed.href, href).toBeUndefined();
      }
    }
  });

  it("strips control chars used to mask a scheme", () => {
    const parsed = parseRenderableView({
      viewType: "artifact_preview",
      schemaVersion: 1,
      name: "evil",
      href: "java" + String.fromCharCode(0) + "script:alert(1)", // NUL splits the scheme to dodge a naive check
    });
    if (parsed && parsed.viewType === "artifact_preview") {
      expect(parsed.href).toBeUndefined();
    }
  });
});
