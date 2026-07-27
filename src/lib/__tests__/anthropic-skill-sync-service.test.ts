// App-layer sync service: namespace-key derivation safety.
//
// Focuses on the two security-critical pure helpers:
//  - deriveApiKeyFingerprint: non-reversible, stable, never the raw key.
//  - deriveEnvironmentNamespace: collision-safe across worktree/clone/
//    staging/prod under one shared Anthropic API key; fail-closed when the
//    deployment namespace is undeterminable.
//
// The root vitest config aliases @cinatra-ai/llm to a narrow
// actor-context stub, so we mock the heavy package + skills + database alias.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

const readAnthropicConnection = vi.fn<(...a: never[]) => unknown>();

// A3 (cinatra#1363): the lifecycle-gate reader buildSyncCandidates now calls.
// Default = ok:true with an EMPTY map ⇒ every id is "missing" ⇒ KEPT (never
// over-reclaimed), so the existing full-pool test is unchanged. Tests reassign
// this to inject an archived state or a reader error.
type SyncLifecycleResult =
  | { ok: true; states: Map<string, string | null> }
  | { ok: false };
let syncLifecycleReader: (ids: string[]) => SyncLifecycleResult = () => ({
  ok: true,
  states: new Map(),
});

vi.mock("@/lib/database", () => ({
  readAnthropicConnectionFromDatabase: () => readAnthropicConnection(),
  readAnthropicSkillSyncEnabledFromDatabase: () => false,
  readSkillLifecycleStates: (ids: string[]) => syncLifecycleReader(ids),
}));

vi.mock("@cinatra-ai/llm", () => ({
  AnthropicSkillSyncEngine: class {},
  TableBackedAnthropicSkillSyncMap: class {},
  FetchAnthropicCustomSkillsClient: class {},
  defaultAnthropicSkillUploadGate: { isUploadAllowed: () => false },
  setAnthropicSkillSyncMap: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  readSkillsCatalogSnapshot: vi.fn(),
  getSkillAnthropicUploadFlag: vi.fn(),
  // Strict-containment guard on `sourcePath`. The fixture skills live under a
  // temp dir (outside the configured skills root), so the no-op keeps the
  // candidate-pool tests focused on the narrowing-vs-full-pool contract rather
  // than on path containment (covered by the skills-package suite).
  assertSkillFilePathInsideRoot: vi.fn(),
  // A3 (cinatra#1363): faithful copy of the real runtime-delivery predicate
  // (the real one — and its drift guard — is pinned by the skills-package
  // lifecycle-consumer-matrix test).
  isRuntimeDeliverableLifecycleState: (s: string | null | undefined) =>
    s === null ? true : s === undefined ? false : s === "active" || s === "deprecated",
}));

vi.mock("@/lib/anthropic-skill-upload-governance", () => ({
  isAnthropicSkillUploadAllowedFromConfig: () => false,
}));

// Byte-bound sync (cinatra#2088): the disk→authority CAPTURE phase and the
// authority-only CANDIDATES phase are separate. Stand in for the DB authority
// with an in-memory one that behaves like the real store: capture
// content-addresses the router bytes and advances a head; the candidate read
// resolves ONLY from that head (never from disk). The real DB round-trip
// (DB → dir → zip, identical bundle digest, binary byte-exact) is proven by
// skill-bundle-store.integration.test.ts.
type FakeBundle = {
  revisionId: string;
  bundleDigest: string;
  files: { path: string; digest: string; byteLength: number; mode: number; isRouter: boolean; bytes: Buffer }[];
};
const bundleHeads = new Map<string, FakeBundle>();
const { lintRouterOneHopReferences } = await import(
  "../../../scripts/audit/_lib/skill-packaging-verdict.mjs"
);
vi.mock("@/lib/skill-bundle-store", () => ({
  captureSkillBundleFromDisk: async (skillId: string, skillMdPath: string) => {
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(skillMdPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const bundleDigest = `bundle-${digest.slice(0, 16)}`;
    const prev = bundleHeads.get(skillId);
    const changed = !prev || prev.bundleDigest !== bundleDigest;
    if (changed) {
      bundleHeads.set(skillId, {
        revisionId: `bundle:${bundleDigest}`,
        bundleDigest,
        files: [
          { path: "SKILL.md", digest, byteLength: bytes.length, mode: 420, isRouter: true, bytes },
        ],
      });
    }
    return {
      skillId,
      revisionId: bundleHeads.get(skillId)!.revisionId,
      bundleDigest,
      changed,
      authorityOwnedDivergence: false,
      lint: { ok: true, missing: [] },
    };
  },
  readCurrentSkillBundleFromDatabase: (skillId: string) => {
    const head = bundleHeads.get(skillId);
    if (!head) return null;
    return { revisionId: head.revisionId, skillId, bundleDigest: head.bundleDigest, files: head.files };
  },
  // The REAL one-hop lint (cinatra#2089): the shared verdict's
  // `lintRouterOneHopReferences` is pinned byte-for-behaviour to the store's
  // `lintBundleRouterReferences` by the agreement test in
  // scripts/audit/__tests__/skill-packaging-gate.test.mjs, so the fail-closed
  // candidate refusal below is exercised against the actual rules — not a stub.
  lintBundleRouterReferences: lintRouterOneHopReferences,
}));

vi.mock("@/lib/anthropic-skill-sync-dao", () => ({
  readSyncRow: vi.fn(),
  upsertSyncRow: vi.fn(),
  markSyncRowStale: vi.fn(),
  markStaleForRemovedCatalogSkills: vi.fn(),
  withNamespaceSyncLock: vi.fn(),
}));

const {
  deriveApiKeyFingerprint,
  deriveEnvironmentNamespace,
  buildSyncCandidates,
  buildSyncCandidatesWithRefusals,
  captureSkillBundlesFromDisk,
  syncCatalogSkillsToAnthropic,
} = await import("../anthropic-skill-sync-service");

/** Run the two byte-bound phases the sync entry point runs, in order. */
async function captureThenBuildCandidates() {
  await captureSkillBundlesFromDisk();
  return buildSyncCandidates();
}

const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const nodePath = await import("node:path");
const skillsPkg = await import("@cinatra-ai/skills");

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  readAnthropicConnection.mockReset();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("deriveApiKeyFingerprint", () => {
  it("returns null when no Anthropic key configured", () => {
    readAnthropicConnection.mockReturnValue(null);
    expect(deriveApiKeyFingerprint()).toBeNull();
    readAnthropicConnection.mockReturnValue({ apiKey: "   " });
    expect(deriveApiKeyFingerprint()).toBeNull();
  });

  it("is non-reversible (no substring of the raw key) and stable", () => {
    const apiKey = "sk-ant-SUPER-SECRET-12345";
    readAnthropicConnection.mockReturnValue({ apiKey });
    delete process.env.BETTER_AUTH_SECRET;
    const fp1 = deriveApiKeyFingerprint()!;
    const fp2 = deriveApiKeyFingerprint()!;
    expect(fp1).toBe(fp2); // stable
    expect(fp1).not.toContain("SECRET");
    expect(fp1).not.toContain(apiKey);
    expect(fp1).toBe(createHash("sha256").update(apiKey).digest("hex"));
  });

  it("uses HMAC keyed by BETTER_AUTH_SECRET when present", () => {
    const apiKey = "sk-ant-abc";
    readAnthropicConnection.mockReturnValue({ apiKey });
    process.env.BETTER_AUTH_SECRET = "app-secret";
    expect(deriveApiKeyFingerprint()).toBe(
      createHmac("sha256", "app-secret").update(apiKey).digest("hex"),
    );
  });

  it("different keys ⇒ different fingerprints (no collision)", () => {
    delete process.env.BETTER_AUTH_SECRET;
    readAnthropicConnection.mockReturnValue({ apiKey: "key-A" });
    const a = deriveApiKeyFingerprint();
    readAnthropicConnection.mockReturnValue({ apiKey: "key-B" });
    const b = deriveApiKeyFingerprint();
    expect(a).not.toBe(b);
  });
});

describe("deriveEnvironmentNamespace collision safety", () => {
  it("fails closed when SUPABASE_DB_URL is unset", () => {
    delete process.env.SUPABASE_DB_URL;
    expect(() => deriveEnvironmentNamespace()).toThrow(/SUPABASE_DB_URL/);
  });

  it("two clones sharing schema 'cinatra' but different DBs get distinct namespaces", () => {
    process.env.SUPABASE_SCHEMA = "cinatra";
    delete process.env.CINATRA_DEPLOYMENT_ENV;
    process.env.SUPABASE_DB_URL = "postgres://h:5432/cinatra_clone_a";
    const a = deriveEnvironmentNamespace();
    process.env.SUPABASE_DB_URL = "postgres://h:5432/cinatra_clone_b";
    const b = deriveEnvironmentNamespace();
    expect(a).not.toBe(b);
    expect(a).toContain("schema=cinatra");
  });

  it("staging vs prod (different host, same schema) get distinct namespaces", () => {
    process.env.SUPABASE_SCHEMA = "cinatra";
    process.env.SUPABASE_DB_URL = "postgres://staging-db:5432/app";
    const staging = deriveEnvironmentNamespace();
    process.env.SUPABASE_DB_URL = "postgres://prod-db:5432/app";
    const prod = deriveEnvironmentNamespace();
    expect(staging).not.toBe(prod);
  });

  it("explicit CINATRA_DEPLOYMENT_ENV further disambiguates", () => {
    process.env.SUPABASE_SCHEMA = "cinatra";
    process.env.SUPABASE_DB_URL = "postgres://h:5432/app";
    delete process.env.CINATRA_DEPLOYMENT_ENV;
    const base = deriveEnvironmentNamespace();
    process.env.CINATRA_DEPLOYMENT_ENV = "prod";
    const tagged = deriveEnvironmentNamespace();
    expect(base).not.toBe(tagged);
    expect(tagged).toContain("dep=prod");
  });

  it("is deterministic for the same inputs", () => {
    process.env.SUPABASE_SCHEMA = "cinatra";
    process.env.SUPABASE_DB_URL = "postgres://h:5432/app";
    process.env.CINATRA_DEPLOYMENT_ENV = "x";
    expect(deriveEnvironmentNamespace()).toBe(deriveEnvironmentNamespace());
  });

  it("worktree schema cinatra_<slug> is distinct from main even on same DB url", () => {
    process.env.SUPABASE_DB_URL = "postgres://h:5432/app";
    delete process.env.CINATRA_DEPLOYMENT_ENV;
    process.env.SUPABASE_SCHEMA = "cinatra";
    const main = deriveEnvironmentNamespace();
    process.env.SUPABASE_SCHEMA = "cinatra_anthropic_provider_skill_adapter";
    const worktree = deriveEnvironmentNamespace();
    expect(main).not.toBe(worktree);
  });
});

// ---------------------------------------------------------------------------
// Broad recommendable-pool sync coverage.
//
// The catalog→Anthropic sync must cover the FULL recommendable
// skill pool (every catalog skill the recommendation agent could dynamically
// pick for a general Anthropic agent), NOT a narrowed per-agent creation
// allowlist — so a dynamically-recommended skill is always already pre-synced.
// These tests pin: (a) the candidate set == every catalog skill with an
// on-disk sourcePath (not narrowed), and (b) the governance gate is
// still authoritative — opt-in OFF ⇒ the sync entrypoint is fully inert (no
// engine, no client, no namespace work).
// ---------------------------------------------------------------------------
describe("broad recommendable-pool sync", () => {
  let tmpRoot: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("buildSyncCandidates covers EVERY catalog skill with a sourcePath (full pool, not a creation allowlist)", async () => {
    tmpRoot = mkdtempSync(nodePath.join(tmpdir(), "recommendable-pool-"));
    // Three skills: two creation-allowlist-style + one arbitrary general
    // recommendable skill. All three have an on-disk sourcePath ⇒ all three
    // MUST become candidates (the loop is not narrowed to the creation set).
    const mk = (id: string) => {
      const dir = nodePath.join(tmpRoot, id);
      mkdirSync(dir, { recursive: true });
      const p = nodePath.join(dir, "SKILL.md");
      writeFileSync(p, `# ${id}\nbody`);
      return p;
    };
    const catalog = {
      skills: [
        { id: "security-review", name: "Security Review", sourcePath: mk("security-review") },
        { id: "agent-authoring", name: "Agent Authoring", sourcePath: mk("agent-authoring") },
        { id: "general-recommendable-skill", name: "General Skill", sourcePath: mk("general-recommendable-skill") },
        // No sourcePath ⇒ legitimately non-syncable (cannot upload a body that
        // does not exist on disk). Excluded — but NOT because it is non-creation.
        { id: "no-disk-body", name: "No Disk Body" },
      ],
    };
    vi.mocked(skillsPkg.readSkillsCatalogSnapshot).mockReset().mockResolvedValue(catalog as never);
    vi.mocked(skillsPkg.getSkillAnthropicUploadFlag).mockReset().mockReturnValue(true as never);

    const candidates = await captureThenBuildCandidates();
    const ids = candidates.map((c) => c.catalogSkillId).sort();
    // The full recommendable pool: every sourcePath skill, incl. the arbitrary
    // general one — NOT just the creation-allowlist-shaped ids.
    expect(ids).toEqual([
      "agent-authoring",
      "general-recommendable-skill",
      "security-review",
    ]);
    expect(ids).toContain("general-recommendable-skill");
    // Byte-bound: every candidate carries the stored revision + bundle identity.
    for (const c of candidates) {
      expect(typeof c.revisionId).toBe("string");
      expect(c.revisionId.length).toBeGreaterThan(0);
      expect(typeof c.bundleDigest).toBe("string");
      expect(c.bundleDigest.length).toBeGreaterThan(0);
    }
  });

  it("cinatra#2089 (S2): a stored bundle whose router DEAD-ENDS is REFUSED as an upload candidate, by name", async () => {
    // S1 (#2088) computed the one-hop router lint as a DIAGNOSTIC and assigned
    // its fail-closed enforcement to S2. The lint runs over the STORED bytes —
    // the exact bytes the canonical zip is built from — so a router that points
    // at a file the bundle does not ship never reaches the provider. The
    // refusal is per-skill and NAMED: every other skill still syncs.
    tmpRoot = mkdtempSync(nodePath.join(tmpdir(), "dangling-router-"));
    const mk = (id: string, body: string) => {
      const dir = nodePath.join(tmpRoot, id);
      mkdirSync(dir, { recursive: true });
      const p = nodePath.join(dir, "SKILL.md");
      writeFileSync(p, body);
      return p;
    };
    vi.mocked(skillsPkg.readSkillsCatalogSnapshot)
      .mockReset()
      .mockResolvedValue({
        skills: [
          { id: "broken", name: "Broken", sourcePath: mk("broken", "# broken\nRead [more](references/missing.md).") },
          { id: "sound", name: "Sound", sourcePath: mk("sound", "# sound\nNo references at all.") },
        ],
      } as never);
    vi.mocked(skillsPkg.getSkillAnthropicUploadFlag).mockReset().mockReturnValue(true as never);

    await captureSkillBundlesFromDisk();
    const { candidates, refusedForDanglingReferences } = await buildSyncCandidatesWithRefusals();

    expect(candidates.map((c) => c.catalogSkillId)).toEqual(["sound"]);
    expect(refusedForDanglingReferences).toEqual([
      { catalogSkillId: "broken", missing: ["references/missing.md"] },
    ]);
  });

  it("cinatra#2088: a DERIVED (extension) skill — which never gets a lifecycle revision — is still a byte-bound candidate", async () => {
    // Regression guard: the lifecycle revision layer (core__0029) covers
    // custom/personal skills ONLY, so an extension skill's
    // `skills.active_revision_id` is NULL forever. Binding candidates to that
    // pointer would silently drop the extension skills that ARE the mirror —
    // and, worse, let markStaleForRemovedCatalogSkills reclaim their remote
    // copies. The bundle authority's OWN head is what makes them candidates.
    tmpRoot = mkdtempSync(nodePath.join(tmpdir(), "derived-skill-"));
    const dir = nodePath.join(tmpRoot, "extension-skill");
    mkdirSync(dir, { recursive: true });
    const p = nodePath.join(dir, "SKILL.md");
    writeFileSync(p, "# extension skill\nbody");
    vi.mocked(skillsPkg.readSkillsCatalogSnapshot)
      .mockReset()
      .mockResolvedValue({ skills: [{ id: "extension-skill", name: "Extension Skill", sourcePath: p }] } as never);
    vi.mocked(skillsPkg.getSkillAnthropicUploadFlag).mockReset().mockReturnValue(true as never);
    // Lifecycle state NULL = derived — exactly the extension-skill shape.
    syncLifecycleReader = (ids) => ({ ok: true, states: new Map(ids.map((id) => [id, null])) });
    try {
      const candidates = await captureThenBuildCandidates();
      expect(candidates.map((c) => c.catalogSkillId)).toEqual(["extension-skill"]);
      expect(candidates[0].bundleDigest).toMatch(/^bundle-/);
    } finally {
      syncLifecycleReader = () => ({ ok: true, states: new Map() });
    }
  });

  it("cinatra#2088: candidate construction reads ZERO disk — the bytes come from the authority", async () => {
    tmpRoot = mkdtempSync(nodePath.join(tmpdir(), "no-disk-candidates-"));
    const dir = nodePath.join(tmpRoot, "authority-only");
    mkdirSync(dir, { recursive: true });
    const p = nodePath.join(dir, "SKILL.md");
    writeFileSync(p, "# authority-only\nstored body");
    vi.mocked(skillsPkg.readSkillsCatalogSnapshot)
      .mockReset()
      .mockResolvedValue({ skills: [{ id: "authority-only", name: "Authority Only", sourcePath: p }] } as never);
    vi.mocked(skillsPkg.getSkillAnthropicUploadFlag).mockReset().mockReturnValue(true as never);

    // Phase 1: capture (the only disk boundary).
    await captureSkillBundlesFromDisk();
    // Now DELETE the on-disk skill entirely. A candidate builder that touched
    // disk would throw or drop the skill; the authority-backed one still yields
    // the stored bytes.
    rmSync(dir, { recursive: true, force: true });

    const candidates = await buildSyncCandidates();
    expect(candidates.map((c) => c.catalogSkillId)).toEqual(["authority-only"]);
    expect(candidates[0].skillMd.toString("utf8")).toBe("# authority-only\nstored body");
  });

  it("A3 (cinatra#1363): EXCLUDES an archived skill (⇒ stale ⇒ GC reclaims mirror); keeps active + derived NULL", async () => {
    tmpRoot = mkdtempSync(nodePath.join(tmpdir(), "lifecycle-exclude-"));
    const mk = (id: string) => {
      const dir = nodePath.join(tmpRoot, id);
      mkdirSync(dir, { recursive: true });
      const p = nodePath.join(dir, "SKILL.md");
      writeFileSync(p, `# ${id}\nbody`);
      return p;
    };
    const catalog = {
      skills: [
        { id: "keep-active", name: "Keep", sourcePath: mk("keep-active") },
        { id: "archived-one", name: "Archived", sourcePath: mk("archived-one") },
        { id: "derived-null", name: "Derived", sourcePath: mk("derived-null") },
      ],
    };
    vi.mocked(skillsPkg.readSkillsCatalogSnapshot).mockReset().mockResolvedValue(catalog as never);
    vi.mocked(skillsPkg.getSkillAnthropicUploadFlag).mockReset().mockReturnValue(true as never);
    syncLifecycleReader = (ids) => ({
      ok: true,
      states: new Map(
        ids.map((id) => [id, id === "archived-one" ? "archived" : id === "derived-null" ? null : "active"]),
      ),
    });
    try {
      const ids = (await captureThenBuildCandidates()).map((c) => c.catalogSkillId).sort();
      // archived-one is EXCLUDED (its existing mirror row is then marked stale by
      // markStaleForRemovedCatalogSkills → GC reclaims). Derived (NULL) is kept.
      expect(ids).toEqual(["derived-null", "keep-active"]);
      expect(ids).not.toContain("archived-one");
    } finally {
      syncLifecycleReader = () => ({ ok: true, states: new Map() });
    }
  });

  it("A3 (cinatra#1363): ABORTS the whole sync on a lifecycle READER ERROR (fail-safe — never over-reclaim on an ambiguous read)", async () => {
    tmpRoot = mkdtempSync(nodePath.join(tmpdir(), "lifecycle-abort-"));
    const dir = nodePath.join(tmpRoot, "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, "SKILL.md"), "# s1\nbody");
    const catalog = { skills: [{ id: "s1", name: "S1", sourcePath: nodePath.join(dir, "SKILL.md") }] };
    vi.mocked(skillsPkg.readSkillsCatalogSnapshot).mockReset().mockResolvedValue(catalog as never);
    syncLifecycleReader = () => ({ ok: false });
    try {
      await expect(buildSyncCandidates()).rejects.toThrow(/lifecycle_state read failed|over-reclaim/i);
    } finally {
      syncLifecycleReader = () => ({ ok: true, states: new Map() });
    }
  });

  it("opt-in OFF ⇒ syncCatalogSkillsToAnthropic is fully inert (governance gate authoritative; no engine/client/namespace work)", async () => {
    // The module-level @/lib/database mock pins
    // readAnthropicSkillSyncEnabledFromDatabase ⇒ false (opt-in OFF). The
    // entrypoint must return the inert result BEFORE deriving the namespace,
    // constructing the client, or building candidates.
    // Clear the module-mock fn's accumulated call history (the prior
    // test invoked buildSyncCandidates ⇒ readSkillsCatalog; vi.fn() retains
    // history across tests, so assert on a freshly-cleared mock).
    const catalogMock = vi
      .mocked(skillsPkg.readSkillsCatalogSnapshot)
      .mockReset()
      .mockResolvedValue({ skills: [] } as never);
    const result = await syncCatalogSkillsToAnthropic();
    expect(result).toEqual({ ok: true, outcomes: [] });
    // Inert: candidate build never ran (gate short-circuits before it).
    expect(catalogMock).not.toHaveBeenCalled();
  });
});
