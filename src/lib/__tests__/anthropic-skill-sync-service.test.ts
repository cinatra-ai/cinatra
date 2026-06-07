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

vi.mock("@/lib/database", () => ({
  readAnthropicConnectionFromDatabase: () => readAnthropicConnection(),
  readAnthropicSkillSyncEnabledFromDatabase: () => false,
}));

vi.mock("@cinatra-ai/llm", () => ({
  AnthropicSkillSyncEngine: class {},
  TableBackedAnthropicSkillSyncMap: class {},
  FetchAnthropicCustomSkillsClient: class {},
  defaultAnthropicSkillUploadGate: { isUploadAllowed: () => false },
  setAnthropicSkillSyncMap: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  readSkillsCatalog: vi.fn(),
  getSkillAnthropicUploadFlag: vi.fn(),
  // Strict-containment guard on `sourcePath`. The fixture skills live under a
  // temp dir (outside the configured skills root), so the no-op keeps the
  // candidate-pool tests focused on the narrowing-vs-full-pool contract rather
  // than on path containment (covered by the skills-package suite).
  assertSkillFilePathInsideRoot: vi.fn(),
}));

vi.mock("@/lib/anthropic-skill-upload-governance", () => ({
  isAnthropicSkillUploadAllowedFromConfig: () => false,
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
  syncCatalogSkillsToAnthropic,
} = await import("../anthropic-skill-sync-service");

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
    vi.mocked(skillsPkg.readSkillsCatalog).mockReset().mockResolvedValue(catalog as never);
    vi.mocked(skillsPkg.getSkillAnthropicUploadFlag).mockReset().mockReturnValue(true as never);

    const candidates = await buildSyncCandidates();
    const ids = candidates.map((c) => c.catalogSkillId).sort();
    // The full recommendable pool: every sourcePath skill, incl. the arbitrary
    // general one — NOT just the creation-allowlist-shaped ids.
    expect(ids).toEqual([
      "agent-authoring",
      "general-recommendable-skill",
      "security-review",
    ]);
    expect(ids).toContain("general-recommendable-skill");
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
      .mocked(skillsPkg.readSkillsCatalog)
      .mockReset()
      .mockResolvedValue({ skills: [] } as never);
    const result = await syncCatalogSkillsToAnthropic();
    expect(result).toEqual({ ok: true, outcomes: [] });
    // Inert: candidate build never ran (gate short-circuits before it).
    expect(catalogMock).not.toHaveBeenCalled();
  });
});
