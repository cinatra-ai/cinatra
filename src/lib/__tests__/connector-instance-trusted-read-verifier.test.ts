import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { isKnownDestructiveToolName } from "@cinatra-ai/mcp-server/known-destructive-floor";
import type {
  CatalogServerSnapshot,
  CatalogToolEntry,
} from "@/lib/connector-instance-catalog-cache";
import type { TrustedReadDescriptorEntry } from "@/lib/connector-instance-trusted-read-descriptors";
import {
  SCHEMA_CANONICALIZATION_MAX_DEPTH,
  TRUSTED_READ_FINGERPRINT_ALGORITHM,
  canonicalizeSchemaForFingerprint,
  computeTrustedReadFingerprint,
  verifyTrustedReadSet,
} from "@/lib/connector-instance-trusted-read-verifier";

// cinatra#2019 S4 — the PURE trust-algorithm core. These tests pin (a) the
// strict `tsr1` canonicalization/fingerprint spec (design D7) and (b) the
// eligibility CONJUNCTION: every unproven conjunct ejects with its typed
// reason, uncertainty never adds a name, and the empty set is the degenerate
// safe outcome. The impure builder around this core is pinned in
// wordpress-native-read-injection.test.ts.

// ---------------------------------------------------------------------------
// canonicalizeSchemaForFingerprint — the strict D7 spec.
// ---------------------------------------------------------------------------

describe("canonicalizeSchemaForFingerprint", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const a = canonicalizeSchemaForFingerprint({
      type: "object",
      properties: { b: { type: "string" }, a: { enum: [2, 1] } },
      required: ["b", "a"],
    });
    const b = canonicalizeSchemaForFingerprint({
      required: ["b", "a"],
      properties: { a: { enum: [2, 1] }, b: { type: "string" } },
      type: "object",
    });
    expect(a).toEqual(b);
    if (!a.ok) throw new Error("expected ok");
    // Arrays keep their order (a reordered `required` IS a content change) …
    expect(a.canonical).toContain('"required":["b","a"]');
    expect(a.canonical).toContain('"enum":[2,1]');
    // … while object keys are sorted.
    expect(a.canonical.indexOf('"properties"')).toBeLessThan(a.canonical.indexOf('"required"'));
  });

  it("inlines same-document `#/` refs (a ref and its pre-inlined twin canonicalize identically)", () => {
    const defs = { note: { type: "object", properties: { id: { type: "integer" } } } };
    const viaRef = canonicalizeSchemaForFingerprint({
      type: "object",
      properties: { note: { $ref: "#/$defs/note" } },
      $defs: defs,
    });
    const inlined = canonicalizeSchemaForFingerprint({
      type: "object",
      properties: { note: defs.note },
      $defs: defs,
    });
    expect(viaRef).toEqual(inlined);
  });

  it("unescapes RFC 6901 pointer segments (~1 → /, ~0 → ~)", () => {
    const result = canonicalizeSchemaForFingerprint({
      properties: { x: { $ref: "#/definitions/a~1b~0c" } },
      definitions: { "a/b~c": { type: "null" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canonical).toContain('"x":{"type":"null"}');
  });

  it.each([
    ["boolean schema (true)", true],
    ["boolean schema (false)", false],
    ["null", null],
    ["array root", [{ type: "object" }]],
    ["string root", "object"],
  ])("rejects a non-object root: %s", (_label, schema) => {
    expect(canonicalizeSchemaForFingerprint(schema)).toEqual({
      ok: false,
      reason: "not_an_object",
    });
  });

  it.each(["$id", "$anchor", "$dynamicRef", "$dynamicAnchor"])(
    "rejects %s anywhere in the document",
    (keyword) => {
      expect(
        canonicalizeSchemaForFingerprint({
          type: "object",
          properties: { deep: { nested: { [keyword]: "x" } } },
        }),
      ).toEqual({ ok: false, reason: "reserved_keyword" });
    },
  );

  it.each([
    ["absolute URI", "https://example.com/schema.json#/a"],
    ["relative document", "other.json#/a"],
    ["bare fragment", "#"],
    ["plain anchor fragment", "#anchor"],
  ])("rejects a non-`#/` $ref as external: %s", (_label, ref) => {
    expect(canonicalizeSchemaForFingerprint({ properties: { x: { $ref: ref } } })).toEqual({
      ok: false,
      reason: "external_ref",
    });
  });

  it("rejects a $ref with sibling keys (draft-ambiguous)", () => {
    expect(
      canonicalizeSchemaForFingerprint({
        $defs: { a: { type: "string" } },
        properties: { x: { $ref: "#/$defs/a", description: "sibling" } },
      }),
    ).toEqual({ ok: false, reason: "ref_sibling_keys" });
  });

  it("rejects an unresolvable pointer", () => {
    expect(
      canonicalizeSchemaForFingerprint({ properties: { x: { $ref: "#/$defs/missing" } } }),
    ).toEqual({ ok: false, reason: "unresolvable_ref" });
  });

  it("rejects a reference cycle", () => {
    expect(
      canonicalizeSchemaForFingerprint({
        $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
        properties: { x: { $ref: "#/$defs/a" } },
      }),
    ).toEqual({ ok: false, reason: "ref_cycle" });
  });

  it("allows the same ref on SIBLING paths (a diamond is not a cycle)", () => {
    const result = canonicalizeSchemaForFingerprint({
      $defs: { id: { type: "integer" } },
      properties: { a: { $ref: "#/$defs/id" }, b: { $ref: "#/$defs/id" } },
    });
    expect(result.ok).toBe(true);
  });

  it(`rejects nesting deeper than ${SCHEMA_CANONICALIZATION_MAX_DEPTH}`, () => {
    let deep: Record<string, unknown> = { type: "null" };
    for (let i = 0; i < SCHEMA_CANONICALIZATION_MAX_DEPTH + 4; i++) deep = { nested: deep };
    expect(canonicalizeSchemaForFingerprint(deep)).toEqual({
      ok: false,
      reason: "depth_exceeded",
    });
  });
});

// ---------------------------------------------------------------------------
// computeTrustedReadFingerprint — the versioned `tsr1` pin.
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = { type: "object", properties: { id: { type: "integer" } } };
const OUTPUT_SCHEMA = { type: "object", properties: { note: { type: "string" } } };

function expectOk(result: ReturnType<typeof computeTrustedReadFingerprint>): {
  fingerprint: string;
  hasOutputSchema: boolean;
} {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

describe("computeTrustedReadFingerprint", () => {
  it("is a deterministic sha256 hex over the tsr1-framed canonical schemas", () => {
    const a = expectOk(
      computeTrustedReadFingerprint({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
    );
    const b = expectOk(
      computeTrustedReadFingerprint({
        // key order shuffled — same content, same fingerprint
        inputSchema: { properties: { id: { type: "integer" } }, type: "object" },
        outputSchema: { properties: { note: { type: "string" } }, type: "object" },
      }),
    );
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hasOutputSchema).toBe(true);
    expect(TRUSTED_READ_FINGERPRINT_ALGORITHM).toBe("tsr1");
    // The framing is pinned byte-exact: "tsr1|in:<canon>|out:<canon|ABSENT>".
    const canonicalIn = canonicalizeSchemaForFingerprint(INPUT_SCHEMA);
    const canonicalOut = canonicalizeSchemaForFingerprint(OUTPUT_SCHEMA);
    if (!canonicalIn.ok || !canonicalOut.ok) throw new Error("unexpected canon failure");
    expect(a.fingerprint).toBe(
      createHash("sha256")
        .update(`tsr1|in:${canonicalIn.canonical}|out:${canonicalOut.canonical}`, "utf8")
        .digest("hex"),
    );
  });

  it("records output-schema ABSENCE and fingerprints it as the literal ABSENT", () => {
    const absent = expectOk(computeTrustedReadFingerprint({ inputSchema: INPUT_SCHEMA }));
    const present = expectOk(
      computeTrustedReadFingerprint({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
    );
    expect(absent.hasOutputSchema).toBe(false);
    expect(absent.fingerprint).not.toBe(present.fingerprint);
    const canonicalIn = canonicalizeSchemaForFingerprint(INPUT_SCHEMA);
    if (!canonicalIn.ok) throw new Error("unexpected canon failure");
    expect(absent.fingerprint).toBe(
      createHash("sha256")
        .update(`tsr1|in:${canonicalIn.canonical}|out:ABSENT`, "utf8")
        .digest("hex"),
    );
  });

  it("fails typed on the offending schema side", () => {
    expect(computeTrustedReadFingerprint({ inputSchema: true })).toEqual({
      ok: false,
      schema: "input",
      reason: "not_an_object",
    });
    expect(
      computeTrustedReadFingerprint({ inputSchema: INPUT_SCHEMA, outputSchema: null }),
    ).toEqual({ ok: false, schema: "output", reason: "not_an_object" });
    expect(
      computeTrustedReadFingerprint({
        inputSchema: { properties: { x: { $ref: "#/nope" } } },
      }),
    ).toEqual({ ok: false, schema: "input", reason: "unresolvable_ref" });
  });
});

// ---------------------------------------------------------------------------
// verifyTrustedReadSet — the eligibility conjunction.
// ---------------------------------------------------------------------------

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false };

function tool(overrides: Partial<CatalogToolEntry> & { name: string }): CatalogToolEntry {
  return {
    serverId: "mcp-adapter-default",
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    rawAnnotations: { ...READ_ANNOTATIONS },
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<CatalogServerSnapshot> & { serverId: string },
): CatalogServerSnapshot {
  return {
    exposureMode: "first-class",
    tools: [],
    catalogRevision: "rev-test-1",
    fetchedAtMs: 1_000,
    ...overrides,
  };
}

function entryFor(name: string): TrustedReadDescriptorEntry {
  const computed = expectOk(
    computeTrustedReadFingerprint({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
  );
  return { name, fingerprint: computed.fingerprint, hasOutputSchema: true };
}

const DESCRIPTOR = (...entries: TrustedReadDescriptorEntry[]) => ({
  fingerprintAlgorithm: "tsr1" as const,
  entries,
});

describe("verifyTrustedReadSet", () => {
  const ENTRY = entryFor("ewpa-get-post");
  const DEFAULT_OK = snapshot({
    serverId: "mcp-adapter-default",
    tools: [tool({ name: "ewpa-get-post" })],
  });

  it("verifies the exact descriptor∩advertised intersection (sorted) and nothing else", () => {
    const other = entryFor("core-get-site-info");
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(other, ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [
          tool({ name: "ewpa-get-post" }),
          tool({ name: "core-get-site-info" }),
          // advertised but NOT descriptor-named ⇒ never placed
          tool({ name: "ewpa-unlisted-read" }),
        ],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual(["core-get-site-info", "ewpa-get-post"]);
    expect(result.ejected).toEqual([]);
  });

  it("an empty descriptor set verifies to the empty result (the shipped v1 posture)", () => {
    expect(
      verifyTrustedReadSet({
        descriptor: DESCRIPTOR(),
        defaultServerSnapshot: DEFAULT_OK,
        otherServerSnapshots: [],
        enrollmentComplete: true,
      }),
    ).toEqual({ allowedTools: [], ejected: [] });
  });

  it("a triad-only default snapshot ejects EVERYTHING (the pinned-stack case)", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        exposureMode: "triad-only",
        // even a perfectly matching expanded row cannot place a name here
        tools: [tool({ name: "ewpa-get-post" })],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual([]);
    expect(result.ejected).toEqual([
      { name: "ewpa-get-post", reason: "exposure_not_first_class" },
    ]);
  });

  it("a name not advertised on the default server is ejected — including one advertised ONLY elsewhere", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({ serverId: "mcp-adapter-default", tools: [] }),
      otherServerSnapshots: [
        snapshot({ serverId: "wps-1234567890abcdef", tools: [tool({ name: "ewpa-get-post" })] }),
      ],
      enrollmentComplete: true,
    });
    expect(result.ejected).toEqual([{ name: "ewpa-get-post", reason: "not_advertised" }]);
  });

  it("an ambiguously-advertised name (two default-server rows) is ejected", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [tool({ name: "ewpa-get-post" }), tool({ name: "ewpa-get-post" })],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.ejected).toEqual([
      { name: "ewpa-get-post", reason: "ambiguous_on_default_server" },
    ]);
  });

  it("a mutated input schema ejects on fingerprint mismatch", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [
          tool({
            name: "ewpa-get-post",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          }),
        ],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.ejected).toEqual([{ name: "ewpa-get-post", reason: "fingerprint_mismatch" }]);
  });

  it("an output-schema presence flip reports its own typed reason (both directions)", () => {
    const gained = verifyTrustedReadSet({
      descriptor: DESCRIPTOR({ ...ENTRY, hasOutputSchema: false }),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(gained.ejected).toEqual([
      { name: "ewpa-get-post", reason: "output_schema_presence_mismatch" },
    ]);
    const lost = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [tool({ name: "ewpa-get-post", outputSchema: undefined })],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(lost.ejected).toEqual([
      { name: "ewpa-get-post", reason: "output_schema_presence_mismatch" },
    ]);
  });

  it("an uncanonicalizable advertised schema is ineligible with the failure as detail", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [
          tool({
            name: "ewpa-get-post",
            inputSchema: { properties: { x: { $ref: "https://evil.example/schema#/x" } } },
          }),
        ],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.ejected).toEqual([
      { name: "ewpa-get-post", reason: "schema_ineligible", detail: "input:external_ref" },
    ]);
  });

  it.each([
    ["unannotated (defaults to write-class)", {}],
    ["explicit write", { readOnlyHint: false }],
    ["destructive-hinted", { destructiveHint: true }],
    ["contradictory hints (destructive wins)", { readOnlyHint: true, destructiveHint: true }],
    ["uninterpretable hint values (dropped ⇒ write)", { readOnlyHint: "yes-please" }],
  ])("a row whose annotations do not classify read is ejected: %s", (_label, rawAnnotations) => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [tool({ name: "ewpa-get-post", rawAnnotations })],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.ejected).toEqual([{ name: "ewpa-get-post", reason: "not_read_classified" }]);
  });

  it("annotations can only SUBTRACT: readOnlyHint on a non-descriptor tool places nothing", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [tool({ name: "ewpa-i-say-i-am-read" })],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual([]);
  });

  it("the known-destructive floor (the REAL S5 predicate) ejects even a read-annotated match", () => {
    const deleteEntry = entryFor("ewpa-delete-post");
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(deleteEntry),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [tool({ name: "ewpa-delete-post" })], // read-annotated, lying
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
      isKnownDestructiveToolName,
    });
    expect(result.ejected).toEqual([{ name: "ewpa-delete-post", reason: "destructive_floor" }]);
  });

  it("the floor is optional: absent ⇒ the annotation conjunct alone decides", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual(["ewpa-get-post"]);
  });

  it("an incomplete enrollment enumeration ejects everything (duplicate rule unprovable)", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: false,
    });
    expect(result.allowedTools).toEqual([]);
    expect(result.ejected).toEqual([{ name: "ewpa-get-post", reason: "enrollment_incomplete" }]);
  });

  it("a trusted name present on ANY other enrolled server is ejected (spoof containment)", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [
        snapshot({ serverId: "wps-aaaaaaaaaaaaaaaa", tools: [tool({ name: "ewpa-list-posts" })] }),
        snapshot({ serverId: "wps-bbbbbbbbbbbbbbbb", tools: [tool({ name: "ewpa-get-post" })] }),
      ],
      enrollmentComplete: true,
    });
    expect(result.ejected).toEqual([
      {
        name: "ewpa-get-post",
        reason: "duplicate_on_other_server",
        detail: "wps-bbbbbbbbbbbbbbbb",
      },
    ]);
  });

  it("a snapshot sharing the default server's id is never treated as a duplicate source", () => {
    const result = verifyTrustedReadSet({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      // defensive: the same snapshot accidentally passed on both sides
      otherServerSnapshots: [DEFAULT_OK],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual(["ewpa-get-post"]);
  });

  it("an unknown fingerprint algorithm ejects the whole set, typed", () => {
    const result = verifyTrustedReadSet({
      descriptor: {
        fingerprintAlgorithm: "tsr9" as unknown as "tsr1",
        entries: [ENTRY],
      },
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual([]);
    expect(result.ejected).toEqual([
      {
        name: "ewpa-get-post",
        reason: "fingerprint_algorithm_unsupported",
        detail: "tsr9",
      },
    ]);
  });
});
