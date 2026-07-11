import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approveWidgetStreamMetadataGrant,
  canonicalJsonStringify,
  capturePriorWidgetStreamMetadataGrants,
  computeWidgetStreamBindingHashV2,
  deleteUnapprovedWidgetStreamMetadataGrant,
  parseJsonRejectingDuplicateKeys,
  readWidgetStreamMetadataClaimsFromStore,
  readWidgetStreamMetadataGrant,
  recordRequestedWidgetStreamMetadataGrant,
  reopenRevokedWidgetStreamMetadataGrant,
  resolveApprovedWidgetStreamMetadataGrant,
  restoreWidgetStreamMetadataGrant,
  revokeWidgetStreamMetadataGrant,
  unwindWidgetStreamMetadataGrants,
  validateWidgetStreamMetadataCanon,
  WidgetStreamMetadataApprovalConflictError,
  type WidgetStreamMetadataCanonV2,
  type WidgetStreamMetadataGrantClaim,
  type WidgetStreamMetadataGrantDeps,
  type WidgetStreamMetadataRecordGuards,
} from "@/lib/extension-widget-stream-metadata-grants";
import {
  capturePriorOwnershipGrants,
  recordAndAutoApproveOwnershipGrants,
} from "@/lib/extension-capability-ownership-grants";

const PKG = "@cinatra-ai/wordpress-mcp-connector";
const OTHER = "@cinatra-ai/squatter-connector";
const SLUG = "wordpress-runtime-editor";
const TOKEN_KEY = "wordpress_widget_auth";
const BUILD_SLUG = "wordpress-content-editor"; // simulated build-time map entry

// ---------------------------------------------------------------------------
// Canon / claim fixtures
// ---------------------------------------------------------------------------

function makeCanon(overrides?: Partial<WidgetStreamMetadataCanonV2>): WidgetStreamMetadataCanonV2 {
  return {
    v: 2,
    agentSlug: SLUG,
    packageName: PKG,
    moduleExportKey: "./widget-chat-tool",
    factory: "createWordPressWidgetChatTool",
    relayAgentPackage: "@cinatra-ai/wordpress-agent",
    skillCapability: `widget-chat.${SLUG}`,
    contextFields: [
      { key: "href", maxLength: 500 },
      { key: "instanceId", maxLength: 64 },
      { key: "postId", maxLength: 32 },
    ],
    label: "WordPress",
    subjectNoun: "post",
    auth: {
      tokenConfigKey: TOKEN_KEY,
      instancesConfigKey: "wordpress",
      requiredInstanceFields: ["applicationPassword", "id", "name", "username"],
      requireUserToken: true,
    },
    ...overrides,
  };
}

function makeClaim(overrides?: Partial<WidgetStreamMetadataCanonV2>): WidgetStreamMetadataGrantClaim {
  const canon = makeCanon(overrides);
  return {
    agentSlug: canon.agentSlug,
    packageName: canon.packageName,
    canon,
    canonJson: canonicalJsonStringify(canon),
    bindingHashV2: computeWidgetStreamBindingHashV2(canon),
  };
}

/** Guards with a configurable ownership map (the conjunction axis) and a
 * simulated build-time slug map. Fail-closed defaults: PKG owns TOKEN_KEY. */
function makeGuards(owners?: Map<string, string>): WidgetStreamMetadataRecordGuards {
  const ownership = owners ?? new Map([[TOKEN_KEY, PKG]]);
  return {
    isBuildTimeWidgetSlug: (slug) => slug === BUILD_SLUG,
    resolveCredentialStoreOwner: async (tokenConfigKey) => ownership.get(tokenConfigKey) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fake in-memory metadata-grant store driven by the module's raw SQL. Keyed by
// (package_name, org_id, agent_slug) to mirror the UNIQUE constraint, and it
// ENFORCES the anti-squat partial unique indexes (at most one APPROVED grant
// per (agent slug, org scope) — regardless of package) so a squatting approval
// throws exactly as the DB would. Statement dispatch is by SQL verb +
// distinguishing feature. `orgParam` resolves the org_id at the EXACT `$N`
// position the SQL names, so a param-index bug reads wrong/zero rows instead
// of being silently masked (same harness discipline as the sibling
// ownership-grant suite).
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  package_name: string;
  org_id: string | null;
  agent_slug: string;
  binding_hash_v2: string;
  canon_json: string;
  status: string;
  approved_by: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  row_version: number;
};

function keyOf(pkg: string, orgId: string | null, slug: string): string {
  return `${pkg}::${orgId ?? "<global>"}::${slug}`;
}

function orgParam(text: string, v: readonly unknown[]): string | null {
  if (/org_id IS NULL/.test(text)) return null;
  const m = text.match(/org_id = \$(\d+)/);
  if (!m) throw new Error(`orgParam: no org_id clause in: ${text.slice(0, 80)}`);
  const idx = Number(m[1]) - 1;
  const val = v[idx];
  return val === null || val === undefined ? null : String(val);
}

/** Mirror the approved partial unique indexes: at most one APPROVED row per
 * (agent slug, org scope) — ANY package. */
function assertNoOtherApproved(rows: Map<string, Row>, self: Row): void {
  const other = [...rows.values()].find(
    (r) =>
      r.agent_slug === self.agent_slug &&
      (r.org_id ?? null) === (self.org_id ?? null) &&
      r.status === "approved" &&
      r.id !== self.id,
  );
  if (other) {
    throw new Error(
      `duplicate key value violates unique constraint "extension_widget_stream_metadata_grant_approved_slug_global_uniq"`,
    );
  }
}

function fakeDb() {
  const rows = new Map<string, Row>();
  let idSeq = 0;

  const query = async <T,>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    const v = values ?? [];
    const t = text.trimStart();

    if (t.startsWith("SELECT")) {
      if (/WHERE agent_slug = \$1/.test(text)) {
        // resolveApproved: agent_slug = $1 [AND org_id = $2 | AND org_id IS NULL] AND status = 'approved'
        const slug = String(v[0]);
        const orgId = orgParam(text, v);
        return [...rows.values()].filter(
          (r) => r.agent_slug === slug && (r.org_id ?? null) === orgId && r.status === "approved",
        ) as T[];
      }
      // readGrantRow: package_name = $1 AND agent_slug = $2 [AND org...]
      const pkg = String(v[0]);
      const slug = String(v[1]);
      const orgId = orgParam(text, v);
      const row = rows.get(keyOf(pkg, orgId, slug));
      return (row ? [row] : []) as T[];
    }

    if (t.startsWith("INSERT")) {
      // record: (…, canon_json, status) VALUES 5 params + literal 'pending';
      // restore: (…, status, approved_by, revoked_by, revoked_at) VALUES 9
      // params. Inspect only the COLUMN LIST (before VALUES) — the RETURNING
      // clause carries every column name in both statements.
      const isRestore = /revoked_at/.test(text.slice(0, text.indexOf("VALUES")));
      const pkg = String(v[0]);
      const orgId = v[1] === null || v[1] === undefined ? null : String(v[1]);
      const slug = String(v[2]);
      const row: Row = {
        id: `wsm-${++idSeq}`,
        package_name: pkg,
        org_id: orgId,
        agent_slug: slug,
        binding_hash_v2: String(v[3]),
        canon_json: String(v[4]),
        status: isRestore ? String(v[5]) : "pending",
        approved_by: isRestore ? ((v[6] ?? null) as string | null) : null,
        revoked_by: isRestore ? ((v[7] ?? null) as string | null) : null,
        revoked_at: isRestore ? ((v[8] ?? null) as string | null) : null,
        row_version: 1,
      };
      if (rows.has(keyOf(pkg, orgId, slug))) {
        throw new Error(
          `duplicate key value violates unique constraint "extension_widget_stream_metadata_grant_pkg_slug_global_uniq"`,
        );
      }
      if (row.status === "approved") assertNoOtherApproved(rows, row);
      rows.set(keyOf(pkg, orgId, slug), row);
      return [row] as T[];
    }

    if (t.startsWith("UPDATE")) {
      if (/SET status = 'approved'/.test(text)) {
        // approve CAS: approved_by=$1 WHERE pkg=$2 slug=$3 hash=$4 AND status='pending' [org]
        const approvedBy = String(v[0]);
        const pkg = String(v[1]);
        const slug = String(v[2]);
        const hash = String(v[3]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, slug));
        if (!row || row.status !== "pending" || row.binding_hash_v2 !== hash) return [] as T[];
        assertNoOtherApproved(rows, row);
        row.status = "approved";
        row.approved_by = approvedBy;
        row.row_version += 1;
        return [row] as T[];
      }
      if (/SET status = 'revoked'/.test(text)) {
        // revoke: revoked_by=$1 WHERE pkg=$2 slug=$3 [org]
        const revokedBy = String(v[0]);
        const pkg = String(v[1]);
        const slug = String(v[2]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, slug));
        if (!row) return [] as T[];
        row.status = "revoked";
        row.approved_by = null;
        row.revoked_by = revokedBy;
        row.revoked_at = "2026-07-11T00:00:00Z";
        row.row_version += 1;
        return [row] as T[];
      }
      if (/AND status = 'revoked'/.test(text)) {
        // reopen: SET status='pending', hash=$1, canon=$2 WHERE pkg=$3 slug=$4 [org] AND status='revoked'
        const pkg = String(v[2]);
        const slug = String(v[3]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, slug));
        if (!row || row.status !== "revoked") return [] as T[];
        row.status = "pending";
        row.binding_hash_v2 = String(v[0]);
        row.canon_json = String(v[1]);
        row.approved_by = null;
        row.revoked_by = null;
        row.revoked_at = null;
        row.row_version += 1;
        return [row] as T[];
      }
      if (/SET status = \$1/.test(text)) {
        // restore: status=$1 hash=$2 canon=$3 approvedBy=$4 revokedBy=$5 revokedAt=$6 WHERE pkg=$7 slug=$8 [org][sticky]
        const status = String(v[0]);
        const pkg = String(v[6]);
        const slug = String(v[7]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, slug));
        if (!row) return [] as T[];
        const sticky = /status <> 'revoked'/.test(text);
        if (sticky && row.status === "revoked") return [] as T[];
        if (status === "approved") assertNoOtherApproved(rows, row);
        row.status = status;
        row.binding_hash_v2 = String(v[1]);
        row.canon_json = String(v[2]);
        row.approved_by = (v[3] ?? null) as string | null;
        row.revoked_by = (v[4] ?? null) as string | null;
        row.revoked_at = (v[5] ?? null) as string | null;
        row.row_version += 1;
        return [row] as T[];
      }
      // re-pend: SET hash=$1, canon=$2, status='pending' WHERE pkg=$3 slug=$4 [org] AND status <> 'revoked'
      const pkg = String(v[2]);
      const slug = String(v[3]);
      const orgId = orgParam(text, v);
      const row = rows.get(keyOf(pkg, orgId, slug));
      if (!row || row.status === "revoked") return [] as T[];
      row.binding_hash_v2 = String(v[0]);
      row.canon_json = String(v[1]);
      row.status = "pending";
      row.approved_by = null;
      row.row_version += 1;
      return [row] as T[];
    }

    if (t.startsWith("DELETE")) {
      // WHERE pkg=$1 slug=$2 hash=$3 [org] AND status='pending' AND approved_by IS NULL
      const pkg = String(v[0]);
      const slug = String(v[1]);
      const hash = String(v[2]);
      const orgId = orgParam(text, v);
      const key = keyOf(pkg, orgId, slug);
      const row = rows.get(key);
      if (!row || row.status !== "pending" || row.approved_by !== null || row.binding_hash_v2 !== hash) {
        return [] as T[];
      }
      rows.delete(key);
      return [{ id: row.id }] as T[];
    }

    throw new Error(`fakeDb: unhandled statement: ${text.slice(0, 60)}`);
  };

  return { query, rows };
}

function depsFor(db: ReturnType<typeof fakeDb>): WidgetStreamMetadataGrantDeps {
  return { query: db.query, schema: "cinatra" };
}

async function recordOk(
  db: ReturnType<typeof fakeDb>,
  claim: WidgetStreamMetadataGrantClaim,
  guards = makeGuards(),
) {
  const result = await recordRequestedWidgetStreamMetadataGrant(
    { packageName: claim.packageName, orgId: null, claim },
    guards,
    depsFor(db),
  );
  if (result.outcome !== "recorded") throw new Error(`expected recorded, got: ${JSON.stringify(result)}`);
  return result.grant;
}

// ---------------------------------------------------------------------------
// Canonicalization + binding hash
// ---------------------------------------------------------------------------

describe("canonical JSON + bindingHashV2", () => {
  it("is deterministic across object key insertion order", () => {
    const a = canonicalJsonStringify({ b: 1, a: [{ y: 2, x: 1 }] });
    const b = canonicalJsonStringify({ a: [{ x: 1, y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });

  it("hashes are stable for equal canons and differ on ANY bound field (nothing is cosmetic)", () => {
    const base = computeWidgetStreamBindingHashV2(makeCanon());
    expect(computeWidgetStreamBindingHashV2(makeCanon())).toBe(base);
    // label and subjectNoun are BOUND — they can reach the widget UI / tool description.
    expect(computeWidgetStreamBindingHashV2(makeCanon({ label: "WordPress2" }))).not.toBe(base);
    expect(computeWidgetStreamBindingHashV2(makeCanon({ subjectNoun: "page" }))).not.toBe(base);
    expect(
      computeWidgetStreamBindingHashV2(
        makeCanon({
          contextFields: [
            { key: "href", maxLength: 501 },
            { key: "instanceId", maxLength: 64 },
            { key: "postId", maxLength: 32 },
          ],
        }),
      ),
    ).not.toBe(base);
    expect(
      computeWidgetStreamBindingHashV2(makeCanon({ relayAgentPackage: "@cinatra-ai/wordpress-agent-2" })),
    ).not.toBe(base);
    expect(computeWidgetStreamBindingHashV2(makeCanon({ factory: "createOtherFactory" }))).not.toBe(base);
  });

  it("refuses to hash an invalid canon (a refused claim can never pend)", () => {
    expect(() => computeWidgetStreamBindingHashV2(makeCanon({ agentSlug: "Bad_Slug" }))).toThrow(/invalid canon/);
  });

  it("validator refuses non-NFC strings (hashes are only computed over the normalized form)", () => {
    const decomposed = "Wordpréss"; // e + combining acute, NOT NFC
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
    const errors = validateWidgetStreamMetadataCanon(makeCanon({ label: decomposed }));
    expect(errors.some((e) => e.includes("NFC"))).toBe(true);
  });
});

describe("validateWidgetStreamMetadataCanon — dangerous-value refusals", () => {
  it.each([
    ["requireUserToken false", { auth: { ...makeCanon().auth, requireUserToken: false as unknown as true } }, /requireUserToken/],
    ["skillCapability outside widget-chat.<slug>", { skillCapability: "widget-chat.other-agent" }, /widget-chat/],
    ["cross-scope relay package", { relayAgentPackage: "@evil/agent" }, /own scope/],
    ["host-reserved relay package", { relayAgentPackage: "@cinatra-ai/mcp-server" }, /host\/core/],
    ["self as relay package", { relayAgentPackage: PKG }, /companion agent/],
    ["foreign instances namespace", { auth: { ...makeCanon().auth, instancesConfigKey: "drupal" } }, /OWN instances namespace/],
    ["secret-shaped context key", { contextFields: [{ key: "apiToken", maxLength: 32 }] }, /credential\/secret/],
    ["camelCase secret context key (normalized matching)", { contextFields: [{ key: "privateKey", maxLength: 32 }] }, /credential\/secret/],
    ["module export key traversal", { moduleExportKey: "./../escape" }, /moduleExportKey/],
    ["module export key pattern", { moduleExportKey: "./widget-*" }, /moduleExportKey/],
    ["module export key dot segment", { moduleExportKey: "././widget" }, /moduleExportKey/],
    ["module export key node_modules segment", { moduleExportKey: "./node_modules/x" }, /moduleExportKey/],
    ["unanchored tokenConfigKey", { auth: { ...makeCanon().auth, tokenConfigKey: "wordpress_auth" } }, /_widget_auth/],
    ["surrounding whitespace", { label: " WordPress " }, /surrounding whitespace/],
  ] as const)("refuses %s", (_name, overrides, re) => {
    const errors = validateWidgetStreamMetadataCanon(makeCanon(overrides as Partial<WidgetStreamMetadataCanonV2>));
    expect(errors.join("\n")).toMatch(re);
  });

  it("bounds contextFields (count and per-field maxLength)", () => {
    const tooMany = Array.from({ length: 17 }, (_, i) => ({
      key: `k${String(i).padStart(2, "0")}`,
      maxLength: 10,
    }));
    expect(validateWidgetStreamMetadataCanon(makeCanon({ contextFields: tooMany })).join("\n")).toMatch(/at most 16/);
    expect(
      validateWidgetStreamMetadataCanon(
        makeCanon({ contextFields: [{ key: "href", maxLength: 5000 }] }),
      ).join("\n"),
    ).toMatch(/1\.\.2000/);
  });

  it("requires canonical ordering (contextFields by key, requiredInstanceFields sorted)", () => {
    expect(
      validateWidgetStreamMetadataCanon(
        makeCanon({
          contextFields: [
            { key: "postId", maxLength: 32 },
            { key: "href", maxLength: 500 },
          ],
        }),
      ).join("\n"),
    ).toMatch(/sorted by key/);
    expect(
      validateWidgetStreamMetadataCanon(
        makeCanon({ auth: { ...makeCanon().auth, requiredInstanceFields: ["name", "id"] } }),
      ).join("\n"),
    ).toMatch(/sorted/);
  });
});

describe("parseJsonRejectingDuplicateKeys", () => {
  it("parses ordinary JSON (escapes, nesting, numbers, literals)", () => {
    const text = '{"a": "x\\"y\\u00e9", "b": [1, -2.5e3, true, false, null], "c": {"d": {}}}';
    expect(parseJsonRejectingDuplicateKeys(text)).toEqual(JSON.parse(text));
  });

  it.each([
    ["top level", '{"a": 1, "a": 2}'],
    ["nested object", '{"a": {"b": 1, "b": 2}}'],
    ["object inside array", '{"a": [{"k": 1, "k": 2}]}'],
    ["escaped-equal keys", '{"\\u0061": 1, "a": 2}'],
  ])("throws on duplicate keys (%s)", (_name, text) => {
    expect(() => parseJsonRejectingDuplicateKeys(text)).toThrow(/duplicate object key/);
  });

  it("throws on trailing content", () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"a": 1} x')).toThrow(/trailing content/);
  });

  it("refuses __proto__ keys outright and never pollutes prototypes", () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"__proto__": {"x": 1}}')).toThrow(/__proto__/);
    expect(() => parseJsonRejectingDuplicateKeys('{"a": {"\\u005f_proto__": 1}}')).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // Ordinary keys land as OWN data properties (JSON.parse-equivalent).
    const parsed = parseJsonRejectingDuplicateKeys('{"constructor": 1, "hasOwnProperty": 2}') as Record<string, unknown>;
    expect(parsed.constructor).toBe(1);
    expect(parsed.hasOwnProperty).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Reading claims from a materialized store dir (fail closed, never partial)
// ---------------------------------------------------------------------------

describe("readWidgetStreamMetadataClaimsFromStore", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  function declaration(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      agentSlug: SLUG,
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: `widget-chat.${SLUG}`,
      relayAgentPackage: "@cinatra-ai/wordpress-agent",
      factory: "createWordPressWidgetChatTool",
      contextFields: [
        { key: "instanceId", maxLength: 64 },
        { key: "postId", maxLength: 32 },
        { key: "href", maxLength: 500 },
      ],
      auth: {
        tokenConfigKey: TOKEN_KEY,
        instancesConfigKey: "wordpress",
        requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
        requireUserToken: true,
      },
      ...overrides,
    };
  }

  async function writeStore(manifest: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "wsm-grant-test-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
    return dir;
  }

  function manifest(ws: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      name: PKG,
      version: "1.0.0",
      exports: {
        ".": "./dist/index.js",
        "./widget-chat-tool": "./dist/widget-chat-tool.js",
      },
      cinatra: { widgetStream: ws },
      ...extra,
    };
  }

  it("builds a claim from a valid declaration — canon sorted/normalized, hash authoritative", async () => {
    const dir = await writeStore(manifest(declaration()));
    const claims = await readWidgetStreamMetadataClaimsFromStore(dir);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.agentSlug).toBe(SLUG);
    expect(claim.packageName).toBe(PKG);
    // Sorted into canonical order regardless of the declared order.
    expect(claim.canon.contextFields.map((f) => f.key)).toEqual(["href", "instanceId", "postId"]);
    expect(claim.canon.auth.requiredInstanceFields).toEqual(["applicationPassword", "id", "name", "username"]);
    expect(claim.bindingHashV2).toBe(computeWidgetStreamBindingHashV2(claim.canon));
    expect(claim.canonJson).toBe(canonicalJsonStringify(claim.canon));
    // The fixture canon above is the same claim — one canon, one hash.
    expect(claim.bindingHashV2).toBe(makeClaim().bindingHashV2);
  });

  it("accepts the single-object declaration form and defaults requireUserToken to the ENFORCING value", async () => {
    const decl = declaration();
    delete (decl.auth as Record<string, unknown>).requireUserToken;
    const dir = await writeStore(manifest(decl));
    const claims = await readWidgetStreamMetadataClaimsFromStore(dir);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.canon.auth.requireUserToken).toBe(true);
  });

  it("NFC-normalizes declared strings so one definition has one hash", async () => {
    const decomposed = "Café"; // NOT NFC
    const dirA = await writeStore(manifest([declaration({ label: decomposed })]));
    const dirB = await writeStore(manifest([declaration({ label: decomposed.normalize("NFC") })]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [a] = await readWidgetStreamMetadataClaimsFromStore(dirA);
    const [b] = await readWidgetStreamMetadataClaimsFromStore(dirB);
    expect(a).toBeDefined();
    expect(a!.bindingHashV2).toBe(b!.bindingHashV2);
  });

  it.each([
    ["requireUserToken:false (flat prohibition)", (d: Record<string, unknown>) => ({ ...d, auth: { ...(d.auth as object), requireUserToken: false } })],
    ["missing factory", (d: Record<string, unknown>) => { const rest = { ...d }; delete rest.factory; return rest; }],
    ["secret-shaped context key", (d: Record<string, unknown>) => ({ ...d, contextFields: [{ key: "accessToken", maxLength: 32 }] })],
    ["skillCapability outside own namespace", (d: Record<string, unknown>) => ({ ...d, skillCapability: "widget-chat.someone-else" })],
    ["foreign instancesConfigKey", (d: Record<string, unknown>) => ({ ...d, auth: { ...(d.auth as object), instancesConfigKey: "drupal" } })],
    ["cross-scope relayAgentPackage", (d: Record<string, unknown>) => ({ ...d, relayAgentPackage: "@evil/agent" })],
    ["unknown declaration key (strict schema)", (d: Record<string, unknown>) => ({ ...d, extraField: true })],
    ["unknown auth key (strict schema)", (d: Record<string, unknown>) => ({ ...d, auth: { ...(d.auth as object), debugBypass: true } })],
    ["token key not anchored to the instances namespace", (d: Record<string, unknown>) => ({ ...d, auth: { ...(d.auth as object), tokenConfigKey: "wordpress_other" } })],
  ])("refuses the WHOLE connector on %s (fail closed, never partial)", async (_name, mutate) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await writeStore(manifest([mutate(declaration())]));
    expect(await readWidgetStreamMetadataClaimsFromStore(dir)).toEqual([]);
  });

  it("one malformed entry of two refuses BOTH (never a partial declaration)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = declaration({ agentSlug: "second-widget", skillCapability: "widget-chat.wrong" });
    const dir = await writeStore(manifest([declaration(), bad]));
    expect(await readWidgetStreamMetadataClaimsFromStore(dir)).toEqual([]);
  });

  it("refuses a duplicate agentSlug across entries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await writeStore(manifest([declaration(), declaration()]));
    expect(await readWidgetStreamMetadataClaimsFromStore(dir)).toEqual([]);
  });

  it("refuses a manifest carrying a duplicate JSON key (differential-parsing defense)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await writeStore(
      `{"name": "${PKG}", "exports": {"./widget-chat-tool": "./dist/w.js"}, "cinatra": {"widgetStream": {"agentSlug": "${SLUG}", "agentSlug": "${SLUG}"}}}`,
    );
    expect(await readWidgetStreamMetadataClaimsFromStore(dir)).toEqual([]);
  });

  it.each([
    ["missing exports key", { exports: { ".": "./dist/index.js" } }],
    ["conditional exports object", { exports: { "./widget-chat-tool": { import: "./dist/w.mjs" } } }],
    ["array exports target", { exports: { "./widget-chat-tool": ["./dist/a.js", "./dist/b.js"] } }],
    ["null exports target", { exports: { "./widget-chat-tool": null } }],
    ["escaping exports target", { exports: { "./widget-chat-tool": "./../outside.js" } }],
    ["pattern exports target", { exports: { "./widget-chat-tool": "./dist/*.js" } }],
    ["no exports field at all", { exports: undefined }],
  ])("refuses when moduleExportKey cannot resolve to a single string target (%s)", async (_name, extra) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = manifest([declaration()]);
    if ((extra as Record<string, unknown>).exports === undefined) delete m.exports;
    else m.exports = (extra as Record<string, unknown>).exports;
    const dir = await writeStore(m);
    expect(await readWidgetStreamMetadataClaimsFromStore(dir)).toEqual([]);
  });

  it("returns [] for an absent manifest / absent declaration (nothing to record)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wsm-grant-empty-"));
    dirs.push(dir);
    expect(await readWidgetStreamMetadataClaimsFromStore(dir)).toEqual([]);
    const noWidget = await writeStore({ name: PKG, exports: {} });
    expect(await readWidgetStreamMetadataClaimsFromStore(noWidget)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Record — pending only, guard refusals, re-pend on change, sticky tombstone
// ---------------------------------------------------------------------------

describe("recordRequestedWidgetStreamMetadataGrant", () => {
  it("records `pending` and resolves NOTHING until approved (fail closed)", async () => {
    const db = fakeDb();
    const grant = await recordOk(db, makeClaim());
    expect(grant.status).toBe("pending");
    expect(await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db))).toBeNull();
  });

  it("refuses a slug that collides with a BUILD-TIME widget agent (build wins absolutely — never a row)", async () => {
    const db = fakeDb();
    const claim = makeClaim({ agentSlug: BUILD_SLUG, skillCapability: `widget-chat.${BUILD_SLUG}` });
    const result = await recordRequestedWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, claim },
      makeGuards(),
      depsFor(db),
    );
    expect(result).toEqual({ outcome: "refused", reason: expect.stringMatching(/build-time/) });
    expect(db.rows.size).toBe(0);
  });

  it("CONFUSED DEPUTY: refuses when the package is not the approved credential-store owner of the token key", async () => {
    const db = fakeDb();
    // Owned by ANOTHER package → refuse (cross-package credential borrow).
    const otherOwner = await recordRequestedWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, claim: makeClaim() },
      makeGuards(new Map([[TOKEN_KEY, OTHER]])),
      depsFor(db),
    );
    expect(otherOwner).toEqual({ outcome: "refused", reason: expect.stringMatching(/credential-store owner/) });
    // Owned by NOBODY (ownership grant still pending / absent) → refuse too.
    const noOwner = await recordRequestedWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, claim: makeClaim() },
      makeGuards(new Map()),
      depsFor(db),
    );
    expect(noOwner).toEqual({ outcome: "refused", reason: expect.stringMatching(/credential-store owner/) });
    expect(db.rows.size).toBe(0);
  });

  it("refuses a claim whose package does not match the installing package", async () => {
    const db = fakeDb();
    const result = await recordRequestedWidgetStreamMetadataGrant(
      { packageName: OTHER, orgId: null, claim: makeClaim() },
      makeGuards(),
      depsFor(db),
    );
    expect(result.outcome).toBe("refused");
    expect(db.rows.size).toBe(0);
  });

  it("refuses a tampered claim whose hash does not match its canon", async () => {
    const db = fakeDb();
    const claim = { ...makeClaim(), bindingHashV2: "0".repeat(64) };
    const result = await recordRequestedWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, claim },
      makeGuards(),
      depsFor(db),
    );
    expect(result).toEqual({ outcome: "refused", reason: expect.stringMatching(/stale\/forged/) });
  });

  it("refuses an internally-inconsistent claim (slug or canonJson detached from the canon)", async () => {
    const db = fakeDb();
    const slugMismatch = { ...makeClaim(), agentSlug: "some-other-slug" };
    expect(
      await recordRequestedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, claim: slugMismatch },
        makeGuards(),
        depsFor(db),
      ),
    ).toEqual({ outcome: "refused", reason: expect.stringMatching(/does not match its canon/) });
    const jsonMismatch = { ...makeClaim(), canonJson: canonicalJsonStringify(makeCanon({ label: "Other" })) };
    expect(
      await recordRequestedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, claim: jsonMismatch },
        makeGuards(),
        depsFor(db),
      ),
    ).toEqual({ outcome: "refused", reason: expect.stringMatching(/canonical serialization/) });
    expect(db.rows.size).toBe(0);
  });

  it("same-hash re-record leaves an APPROVED row untouched (a signed code-only patch does not re-pend)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    const again = await recordOk(db, claim);
    expect(again.status).toBe("approved");
    expect(again.approvedBy).toBe("admin-1");
  });

  it("a CANON change re-pends an approved grant (hash mismatch → pending at the new hash)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    const changed = makeClaim({ label: "WordPress Pro" });
    const rePended = await recordOk(db, changed);
    expect(rePended.status).toBe("pending");
    expect(rePended.approvedBy).toBeNull();
    expect(rePended.bindingHashV2).toBe(changed.bindingHashV2);
    expect(await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db))).toBeNull();
  });

  it("STICKY REVOCATION: a same-hash reinstall after revoke stays tombstoned", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "admin-1" }, depsFor(db));
    const after = await recordOk(db, claim);
    expect(after.status).toBe("revoked");
    expect(await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db))).toBeNull();
  });

  it("STICKY REVOCATION: a CHANGED-canon reinstall does not silently re-pend a tombstone", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "admin-1" }, depsFor(db));
    const changed = makeClaim({ label: "Totally Different" });
    const after = await recordOk(db, changed);
    expect(after.status).toBe("revoked");
    // The tombstone keeps ITS state — the install did not overwrite the hash.
    expect(after.bindingHashV2).toBe(claim.bindingHashV2);
  });
});

// ---------------------------------------------------------------------------
// Approve — compare-and-swap on the displayed hash; anti-squat
// ---------------------------------------------------------------------------

describe("approveWidgetStreamMetadataGrant (CAS)", () => {
  it("approves only with the exact displayed hash; the grant then resolves", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    const approved = await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    expect(approved.status).toBe("approved");
    const resolved = await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db));
    expect(resolved?.packageName).toBe(PKG);
    expect(resolved?.bindingHashV2).toBe(claim.bindingHashV2);
  });

  it("CAS MISMATCH refuses: a stale displayed hash cannot be blind-approved", async () => {
    const db = fakeDb();
    await recordOk(db, makeClaim());
    await expect(
      approveWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: "f".repeat(64) },
        depsFor(db),
      ),
    ).rejects.toMatchObject({ code: "binding-hash-changed" });
    expect((await readWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG }, depsFor(db)))!.status).toBe("pending");
  });

  it("TOCTOU: an install that rewrites the canon between display and approval yields a conflict", async () => {
    const db = fakeDb();
    const displayed = makeClaim();
    await recordOk(db, displayed);
    // The connector re-publishes with a changed canon before the admin clicks.
    await recordOk(db, makeClaim({ label: "Changed Between Display And Approve" }));
    await expect(
      approveWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: displayed.bindingHashV2 },
        depsFor(db),
      ),
    ).rejects.toBeInstanceOf(WidgetStreamMetadataApprovalConflictError);
  });

  it("refuses to approve a revoked grant (explicit reopen required) and an absent grant", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "admin-1" }, depsFor(db));
    await expect(
      approveWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-2", expectedBindingHashV2: claim.bindingHashV2 },
        depsFor(db),
      ),
    ).rejects.toMatchObject({ code: "not-pending-revoked" });
    await expect(
      approveWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: "absent-slug", approvedBy: "admin-2", expectedBindingHashV2: claim.bindingHashV2 },
        depsFor(db),
      ),
    ).rejects.toMatchObject({ code: "no-grant" });
  });

  it("ANTI-SQUAT: a second package cannot be approved for an already-served slug", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    // The squatter owns ITS OWN token key (so the conjunction passes) but
    // claims the SAME slug.
    const squat = makeClaim({
      packageName: OTHER,
      auth: { ...makeCanon().auth, tokenConfigKey: "squatter_widget_auth", instancesConfigKey: "squatter" },
    });
    const owners = new Map([
      [TOKEN_KEY, PKG],
      ["squatter_widget_auth", OTHER],
    ]);
    const recorded = await recordRequestedWidgetStreamMetadataGrant(
      { packageName: OTHER, orgId: null, claim: squat },
      makeGuards(owners),
      depsFor(db),
    );
    expect(recorded.outcome).toBe("recorded");
    await expect(
      approveWidgetStreamMetadataGrant(
        { packageName: OTHER, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: squat.bindingHashV2 },
        depsFor(db),
      ),
    ).rejects.toThrow(/unique constraint/);
    // The real grant is unchanged — the squat did not flip the served package.
    expect(
      (await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db)))?.packageName,
    ).toBe(PKG);
  });
});

// ---------------------------------------------------------------------------
// Revoke / reopen — the tombstone lifecycle
// ---------------------------------------------------------------------------

describe("revoke + reopen", () => {
  it("revoke drops resolution (fail closed) and records the revoker", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    const revoked = await revokeWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "admin-2" },
      depsFor(db),
    );
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedBy).toBe("admin-2");
    expect(await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db))).toBeNull();
  });

  it("REOPEN is the only path out of a tombstone: revoked → pending at the CURRENT claim, then CAS-approvable", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "admin-1" }, depsFor(db));
    const current = makeClaim({ label: "WordPress vNext" });
    const reopened = await reopenRevokedWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, claim: current },
      makeGuards(),
      depsFor(db),
    );
    expect(reopened.status).toBe("pending");
    expect(reopened.bindingHashV2).toBe(current.bindingHashV2);
    expect(reopened.revokedBy).toBeNull();
    const approved = await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: current.bindingHashV2 },
      depsFor(db),
    );
    expect(approved.status).toBe("approved");
  });

  it("reopen refuses a non-revoked grant and runs the record-time guards", async () => {
    const db = fakeDb();
    await recordOk(db, makeClaim());
    await expect(
      reopenRevokedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, claim: makeClaim() },
        makeGuards(),
        depsFor(db),
      ),
    ).rejects.toThrow(/no revoked grant/);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "a" }, depsFor(db));
    await expect(
      reopenRevokedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, claim: makeClaim() },
        makeGuards(new Map([[TOKEN_KEY, OTHER]])), // conjunction now fails
        depsFor(db),
      ),
    ).rejects.toThrow(/credential-store owner/);
  });
});

// ---------------------------------------------------------------------------
// Resolution — unique-or-null, org precedence
// ---------------------------------------------------------------------------

describe("resolveApprovedWidgetStreamMetadataGrant", () => {
  it("prefers an org-scoped approved grant over a global one", async () => {
    const db = fakeDb();
    const globalClaim = makeClaim();
    await recordOk(db, globalClaim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "a", expectedBindingHashV2: globalClaim.bindingHashV2 },
      depsFor(db),
    );
    const orgClaim = makeClaim();
    await recordRequestedWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: "org-1", claim: orgClaim },
      makeGuards(),
      depsFor(db),
    );
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: "org-1", agentSlug: SLUG, approvedBy: "a", expectedBindingHashV2: orgClaim.bindingHashV2 },
      depsFor(db),
    );
    const resolved = await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: "org-1" }, depsFor(db));
    expect(resolved?.orgId).toBe("org-1");
    // Global callers still resolve the global row.
    expect((await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db)))?.orgId).toBeNull();
  });

  it("AMBIGUOUS runtime grants resolve to NULL (defensive fail-closed backstop)", async () => {
    const db = fakeDb();
    // Force two approved rows past the harness constraint to prove the READ
    // side fails closed even if the write-time impossibility were bypassed.
    db.rows.set(keyOf(PKG, null, SLUG), {
      id: "a", package_name: PKG, org_id: null, agent_slug: SLUG, binding_hash_v2: "h1",
      canon_json: "{}", status: "approved", approved_by: "x", revoked_by: null, revoked_at: null, row_version: 1,
    });
    db.rows.set(keyOf(OTHER, null, SLUG), {
      id: "b", package_name: OTHER, org_id: null, agent_slug: SLUG, binding_hash_v2: "h2",
      canon_json: "{}", status: "approved", approved_by: "x", revoked_by: null, revoked_at: null, row_version: 1,
    });
    expect(await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Durable rollback: restore (revocation-sticky) + fresh-install delete
// ---------------------------------------------------------------------------

describe("restore + delete-unapproved (install unwind primitives)", () => {
  it("restore re-pins a captured APPROVED state over a re-pended row (failed update rollback)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    // The failed update re-pended the row against its new canon…
    await recordOk(db, makeClaim({ label: "Failed Update" }));
    // …the unwind restores the OLD approved state.
    const restored = await restoreWidgetStreamMetadataGrant(
      {
        packageName: PKG, orgId: null, agentSlug: SLUG, status: "approved",
        bindingHashV2: claim.bindingHashV2, canonJson: claim.canonJson,
        approvedBy: "admin-1", revokedBy: null, revokedAt: null,
      },
      depsFor(db),
    );
    expect(restored.status).toBe("approved");
    expect(restored.bindingHashV2).toBe(claim.bindingHashV2);
  });

  it("restore NEVER un-revokes: a mid-install admin revocation survives the rollback (tombstone wins)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "admin-1" }, depsFor(db));
    const after = await restoreWidgetStreamMetadataGrant(
      {
        packageName: PKG, orgId: null, agentSlug: SLUG, status: "approved",
        bindingHashV2: claim.bindingHashV2, canonJson: claim.canonJson,
        approvedBy: "admin-0", revokedBy: null, revokedAt: null,
      },
      depsFor(db),
    );
    expect(after.status).toBe("revoked");
  });

  it("restore inserts the captured state when the row is gone", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    const restored = await restoreWidgetStreamMetadataGrant(
      {
        packageName: PKG, orgId: null, agentSlug: SLUG, status: "pending",
        bindingHashV2: claim.bindingHashV2, canonJson: claim.canonJson,
        approvedBy: null, revokedBy: null, revokedAt: null,
      },
      depsFor(db),
    );
    expect(restored.status).toBe("pending");
    expect(db.rows.size).toBe(1);
  });

  it("delete-unapproved removes ONLY the still-pending row this attempt wrote (hash-pinned)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    // Wrong hash → refused.
    expect(
      await deleteUnapprovedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, bindingHashV2: "0".repeat(64) },
        depsFor(db),
      ),
    ).toBe(false);
    // Right hash + still pending → deleted.
    expect(
      await deleteUnapprovedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, bindingHashV2: claim.bindingHashV2 },
        depsFor(db),
      ),
    ).toBe(true);
    expect(db.rows.size).toBe(0);
  });

  it("delete-unapproved refuses approved and revoked rows (history cannot be recreated to launder)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    expect(
      await deleteUnapprovedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, bindingHashV2: claim.bindingHashV2 },
        depsFor(db),
      ),
    ).toBe(false);
    await revokeWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG, revokedBy: "a" }, depsFor(db));
    expect(
      await deleteUnapprovedWidgetStreamMetadataGrant(
        { packageName: PKG, orgId: null, agentSlug: SLUG, bindingHashV2: claim.bindingHashV2 },
        depsFor(db),
      ),
    ).toBe(false);
    expect(db.rows.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Install-step orchestrators (the pipeline seam) — incl. the NO-auto-approve
// proof through the SAME call the pipeline makes for ports/ownership.
// ---------------------------------------------------------------------------

describe("install-step orchestrators", () => {
  function hooksFor(db: ReturnType<typeof fakeDb>, guards = makeGuards()) {
    return {
      recordWidgetStreamMetadataGrant: async (input: {
        packageName: string;
        orgId: string | null;
        claim: WidgetStreamMetadataGrantClaim;
      }) => {
        await recordRequestedWidgetStreamMetadataGrant(input, guards, depsFor(db));
      },
      readWidgetStreamMetadataGrant: async (packageName: string, orgId: string | null, agentSlug: string) => {
        const g = await readWidgetStreamMetadataGrant({ packageName, orgId, agentSlug }, depsFor(db));
        return g
          ? {
              agentSlug: g.agentSlug, status: g.status, bindingHashV2: g.bindingHashV2,
              canonJson: g.canonJson, approvedBy: g.approvedBy, revokedBy: g.revokedBy, revokedAt: g.revokedAt,
            }
          : null;
      },
      restoreWidgetStreamMetadataGrant: async (i: Parameters<typeof restoreWidgetStreamMetadataGrant>[0]) => {
        await restoreWidgetStreamMetadataGrant(i, depsFor(db));
      },
      deleteUnapprovedWidgetStreamMetadataGrant: async (
        i: Parameters<typeof deleteUnapprovedWidgetStreamMetadataGrant>[0],
      ) => {
        await deleteUnapprovedWidgetStreamMetadataGrant(i, depsFor(db));
      },
    };
  }

  it("NEVER AUTO-APPROVES: a trusted-signed install (autoGrantPrivileged) leaves the metadata grant PENDING", async () => {
    const db = fakeDb();
    // The EXACT pipeline call: ownership keys auto-approve for trusted-signed;
    // the metadata claim must NOT.
    await recordAndAutoApproveOwnershipGrants(
      { ...hooksFor(db) },
      {
        declaredTokenKeys: [],
        autoGrantPrivileged: true,
        packageName: PKG,
        orgId: null,
        approvedBy: "system:auto-trusted-signed",
        widgetMetadataClaims: [makeClaim()],
      },
    );
    const grant = await readWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG }, depsFor(db));
    expect(grant?.status).toBe("pending");
    expect(grant?.approvedBy).toBeNull();
    expect(await resolveApprovedWidgetStreamMetadataGrant({ agentSlug: SLUG, orgId: null }, depsFor(db))).toBeNull();
  });

  it("capturePriorOwnershipGrants captures BOTH axes for the unwind", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    await recordOk(db, claim);
    const captured = await capturePriorOwnershipGrants(hooksFor(db), {
      isUpdate: false, // metadata capture is NOT update-gated (durable row identity)
      packageName: PKG,
      orgId: null,
      declaredTokenKeys: [],
      widgetMetadataClaims: [claim],
    });
    expect(captured.ownership).toEqual([]);
    expect(captured.widgetMetadata).toHaveLength(1);
    expect(captured.widgetMetadata[0]).toMatchObject({ agentSlug: SLUG, status: "pending" });
  });

  it("unwind on a FAILED UPDATE re-pins the captured prior state; on a FRESH install deletes the pending row", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    // Update path: approved prior state captured, then re-pended by the failed attempt.
    await recordOk(db, claim);
    await approveWidgetStreamMetadataGrant(
      { packageName: PKG, orgId: null, agentSlug: SLUG, approvedBy: "admin-1", expectedBindingHashV2: claim.bindingHashV2 },
      depsFor(db),
    );
    const prior = await capturePriorWidgetStreamMetadataGrants(hooksFor(db), {
      packageName: PKG, orgId: null, claims: [claim],
    });
    const failed = makeClaim({ label: "Failed Attempt" });
    await recordOk(db, failed);
    const failures: unknown[] = [];
    await unwindWidgetStreamMetadataGrants({
      hooks: hooksFor(db), packageName: PKG, orgId: null,
      claims: [failed], priorGrants: prior, onFailure: (e) => failures.push(e),
    });
    expect(failures).toEqual([]);
    const restored = await readWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG }, depsFor(db));
    expect(restored).toMatchObject({ status: "approved", bindingHashV2: claim.bindingHashV2, approvedBy: "admin-1" });

    // Fresh path: no prior → the pending row this attempt wrote is deleted.
    const freshDb = fakeDb();
    const freshClaim = makeClaim();
    await recordOk(freshDb, freshClaim);
    await unwindWidgetStreamMetadataGrants({
      hooks: hooksFor(freshDb), packageName: PKG, orgId: null,
      claims: [freshClaim], priorGrants: [], onFailure: (e) => failures.push(e),
    });
    expect(failures).toEqual([]);
    expect(freshDb.rows.size).toBe(0);
  });

  it("a 'fresh' install that meets a PRE-EXISTING row restores it instead of deleting it (capture is not update-gated)", async () => {
    const db = fakeDb();
    const claim = makeClaim();
    // A previous install (since uninstalled) left a pending row on the durable
    // (package, slug) identity.
    await recordOk(db, claim);
    // The new install captures BEFORE recording — even though it is fresh.
    const prior = await capturePriorWidgetStreamMetadataGrants(hooksFor(db), {
      packageName: PKG, orgId: null, claims: [claim],
    });
    expect(prior).toHaveLength(1);
    await recordOk(db, claim); // same hash: untouched
    const failures: unknown[] = [];
    await unwindWidgetStreamMetadataGrants({
      hooks: hooksFor(db), packageName: PKG, orgId: null,
      claims: [claim], priorGrants: prior, onFailure: (e) => failures.push(e),
    });
    expect(failures).toEqual([]);
    // The pre-existing row SURVIVES the failed fresh install.
    expect(db.rows.size).toBe(1);
    expect((await readWidgetStreamMetadataGrant({ packageName: PKG, orgId: null, agentSlug: SLUG }, depsFor(db)))?.status).toBe("pending");
  });

  it("unwired hooks are a pure no-op (older pipeline tests keep passing)", async () => {
    await expect(
      capturePriorWidgetStreamMetadataGrants({}, { packageName: PKG, orgId: null, claims: [makeClaim()] }),
    ).resolves.toEqual([]);
    await expect(
      unwindWidgetStreamMetadataGrants({
        hooks: {}, packageName: PKG, orgId: null, claims: [makeClaim()], priorGrants: [], onFailure: () => {},
      }),
    ).resolves.toBeUndefined();
    await expect(
      recordAndAutoApproveOwnershipGrants({}, {
        declaredTokenKeys: [], autoGrantPrivileged: true, packageName: PKG, orgId: null,
        approvedBy: "x", widgetMetadataClaims: [makeClaim()],
      }),
    ).resolves.toBeUndefined();
  });
});
