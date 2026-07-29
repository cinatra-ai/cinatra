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
  type VerifyTrustedReadSetInput,
} from "@/lib/connector-instance-trusted-read-verifier";

// cinatra#2019 S4 — the PURE trust-algorithm core. These tests pin (a) the
// strict `tsr1` canonicalization/fingerprint spec and (b) the
// eligibility CONJUNCTION: every unproven conjunct ejects with its typed
// reason, uncertainty never adds a name, and the empty set is the degenerate
// safe outcome. The impure builder around this core is pinned in
// connector-instance-native-read-injection.test.ts.

// ---------------------------------------------------------------------------
// canonicalizeSchemaForFingerprint — the strict canonicalization spec.
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

  it.each([
    ["invalid escape ~2", "#/definitions/a~2b"],
    ["trailing bare ~", "#/definitions/x~"],
  ])(
    "rejects an invalid RFC 6901 escape instead of resolving it literally: %s",
    (_label, ref) => {
      // A property literally named like the raw segment must NOT be reachable
      // through an invalid pointer — spec-conforming resolvers reject it, so
      // resolving it literally would fingerprint a different document than
      // other consumers see.
      expect(
        canonicalizeSchemaForFingerprint({
          properties: { x: { $ref: ref } },
          definitions: { "a~2b": { type: "null" }, "x~": { type: "null" } },
        }),
      ).toEqual({ ok: false, reason: "unresolvable_ref" });
    },
  );

  it("rejects percent-escapes in a ref instead of resolving them as literal key text", () => {
    // `$ref` is a URI reference: a spec-conforming consumer percent-decodes
    // the fragment BEFORE pointer evaluation, so `a%2Fb` means the two
    // segments `a`/`b` to it. Fingerprinting the literal `"a%2Fb"` property
    // here would bind a different document view than that consumer executes —
    // any `%` in an accepted `#/` ref is ineligible, even when a literal
    // property of that exact name exists.
    expect(
      canonicalizeSchemaForFingerprint({
        properties: { x: { $ref: "#/definitions/a%2Fb" } },
        definitions: { "a%2Fb": { type: "null" }, a: { b: { type: "null" } } },
      }),
    ).toEqual({ ok: false, reason: "unresolvable_ref" });
  });

  it("decodes ~01 to the literal ~1 (escape order pinned)", () => {
    const result = canonicalizeSchemaForFingerprint({
      properties: { x: { $ref: "#/definitions/~01" } },
      definitions: { "~1": { type: "null" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canonical).toContain('"x":{"type":"null"}');
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

  it("rejects a sibling-$ref expansion bomb via the total node budget (never hangs)", () => {
    // Two refs per level to the NEXT def: ~2^48 resolutions live inside the
    // depth cap (each level costs one depth), so only a TOTAL work budget can
    // bound it. Without the budget this test would not return in this epoch.
    const defs: Record<string, unknown> = { d48: { type: "null" } };
    for (let i = 47; i >= 0; i--) {
      defs[`d${i}`] = {
        a: { $ref: `#/$defs/d${i + 1}` },
        b: { $ref: `#/$defs/d${i + 1}` },
      };
    }
    const started = Date.now();
    expect(
      canonicalizeSchemaForFingerprint({
        properties: { x: { $ref: "#/$defs/d0" } },
        $defs: defs,
      }),
    ).toEqual({ ok: false, reason: "work_budget_exceeded" });
    // Typed and FAST — the budget trips after a bounded number of node
    // visits, orders of magnitude before any meaningful CPU burn.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps ordinary large schemas well inside the node budget", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      properties[`field${i}`] = { type: "string", description: `field ${i}` };
    }
    expect(canonicalizeSchemaForFingerprint({ type: "object", properties }).ok).toBe(true);
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

/** The floor is a REQUIRED input (an optional excluder would be a fail-open
 * seam). Tests that are not about the floor pass a silent one explicitly. */
const SILENT_FLOOR = (): boolean => false;
function verify(
  input: Omit<VerifyTrustedReadSetInput, "isKnownDestructiveToolName"> &
    Partial<Pick<VerifyTrustedReadSetInput, "isKnownDestructiveToolName">>,
) {
  return verifyTrustedReadSet({ isKnownDestructiveToolName: SILENT_FLOOR, ...input });
}

describe("verifyTrustedReadSet", () => {
  const ENTRY = entryFor("ewpa-get-post");
  const DEFAULT_OK = snapshot({
    serverId: "mcp-adapter-default",
    tools: [tool({ name: "ewpa-get-post" })],
  });

  it("verifies the exact descriptor∩advertised intersection (sorted) and nothing else", () => {
    const other = entryFor("core-get-site-info");
    const result = verify({
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
      verify({
        descriptor: DESCRIPTOR(),
        defaultServerSnapshot: DEFAULT_OK,
        otherServerSnapshots: [],
        enrollmentComplete: true,
      }),
    ).toEqual({ allowedTools: [], ejected: [] });
  });

  it("a triad-only default snapshot ejects EVERYTHING (the pinned-stack case)", () => {
    const result = verify({
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
    const result = verify({
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
    const result = verify({
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
    const result = verify({
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
    const gained = verify({
      descriptor: DESCRIPTOR({ ...ENTRY, hasOutputSchema: false }),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    expect(gained.ejected).toEqual([
      { name: "ewpa-get-post", reason: "output_schema_presence_mismatch" },
    ]);
    const lost = verify({
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
    const result = verify({
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
    const result = verify({
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
    const result = verify({
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
    const result = verify({
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

  it("a silent floor leaves the annotation conjunct deciding (the floor can only subtract)", () => {
    const result = verify({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: true,
      isKnownDestructiveToolName: SILENT_FLOOR,
    });
    expect(result.allowedTools).toEqual(["ewpa-get-post"]);
  });

  it("an incomplete enrollment enumeration ejects everything (duplicate rule unprovable)", () => {
    const result = verify({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [],
      enrollmentComplete: false,
    });
    expect(result.allowedTools).toEqual([]);
    expect(result.ejected).toEqual([{ name: "ewpa-get-post", reason: "enrollment_incomplete" }]);
  });

  it("a trusted name present on ANY other enrolled server is ejected (spoof containment)", () => {
    const result = verify({
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

  it("an `other` snapshot claiming the default server's id ejects EVERYTHING (ambiguity is never resolved by ignoring a claimant)", () => {
    const result = verify({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      // a default-id-spoofed / double-passed snapshot set is an inconsistent
      // acquire — no name can be proven against an ambiguous world
      otherServerSnapshots: [DEFAULT_OK],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual([]);
    expect(result.ejected).toEqual([
      {
        name: "ewpa-get-post",
        reason: "snapshot_set_inconsistent",
        detail: "mcp-adapter-default",
      },
    ]);
  });

  it("two `other` snapshots sharing a server id eject EVERYTHING (duplicate claimants)", () => {
    const dedicated = snapshot({
      serverId: "wps-cccccccccccccccc",
      tools: [tool({ name: "ewpa-list-posts" })],
    });
    const result = verify({
      descriptor: DESCRIPTOR(ENTRY),
      defaultServerSnapshot: DEFAULT_OK,
      otherServerSnapshots: [dedicated, { ...dedicated, catalogRevision: "rev-x" }],
      enrollmentComplete: true,
    });
    expect(result.allowedTools).toEqual([]);
    expect(result.ejected).toEqual([
      {
        name: "ewpa-get-post",
        reason: "snapshot_set_inconsistent",
        detail: "wps-cccccccccccccccc",
      },
    ]);
  });

  it("duplicate names WITHIN the descriptor set eject (the pin is ambiguous), unique names unaffected", () => {
    const other = entryFor("core-get-site-info");
    const result = verify({
      descriptor: DESCRIPTOR(ENTRY, { ...ENTRY, fingerprint: "0".repeat(64) }, other),
      defaultServerSnapshot: snapshot({
        serverId: "mcp-adapter-default",
        tools: [tool({ name: "ewpa-get-post" }), tool({ name: "core-get-site-info" })],
      }),
      otherServerSnapshots: [],
      enrollmentComplete: true,
    });
    // Neither duplicate claimant verifies — and the name can never appear
    // (once or twice) in the allowlist while its pin is ambiguous.
    expect(result.allowedTools).toEqual(["core-get-site-info"]);
    expect(result.ejected).toEqual([
      { name: "ewpa-get-post", reason: "descriptor_set_inconsistent" },
      { name: "ewpa-get-post", reason: "descriptor_set_inconsistent" },
    ]);
  });

  it("an unknown fingerprint algorithm ejects the whole set, typed", () => {
    const result = verify({
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
