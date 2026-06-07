// App-layer GC service wiring and governance gating.
//
// The root vitest config aliases @cinatra-ai/llm to a narrow
// stub, so we mock the heavy package + database + sync-service derive helpers
// + both DAOs. Focus:
//  - opt-in OFF ⇒ fully inert: no namespace derivation, no list, no engine.
//  - namespace undeterminable ⇒ fail-closed (ok:false + namespaceError),
//    never any remote/state work.
//  - opt-in ON + derivable namespace ⇒ engine runs under the namespace lock
//    with the derived (fp, env); expired leases pruned first.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let globalEnabled = false;
const deriveFp = vi.fn<() => string | null>();
const deriveEnv = vi.fn<() => string>();
const collect = vi.fn(async (_r: () => boolean) => ({
  ok: true,
  reclaimed: [],
  skipped: [],
  errors: [],
}));
const listAllSyncRows = vi.fn<(fp: string, env: string) => unknown>();
const deleteSyncRowsForAnthropicSkill =
  vi.fn<(fp: string, env: string, id: string) => unknown>();
const countActiveLeasesForSkill =
  vi.fn<(fp: string, env: string, id: string) => unknown>();
const pruneExpiredLeases = vi.fn<(fp: string, env: string) => Promise<void>>(
  async () => {},
);
const withNamespaceSyncLock = vi.fn(
  async (_fp: string, _env: string, fn: () => Promise<unknown>) => fn(),
);

vi.mock("@/lib/database", () => ({
  readAnthropicConnectionFromDatabase: () => ({ apiKey: "sk-test" }),
  readAnthropicSkillSyncEnabledFromDatabase: () => globalEnabled,
}));

vi.mock("@cinatra-ai/llm", () => ({
  AnthropicSkillGcEngine: class {
    constructor(
      public state: unknown,
      public client: unknown,
      public grace: number,
    ) {}
    collect = collect;
  },
  FetchAnthropicCustomSkillsGcClient: class {
    constructor(public apiKey: string) {}
  },
}));

vi.mock("@/lib/anthropic-skill-sync-service", () => ({
  deriveApiKeyFingerprint: () => deriveFp(),
  deriveEnvironmentNamespace: () => deriveEnv(),
  // The GC service asserts GRACE > lease TTL at module load — the mock must
  // export the lease TTL constant or the import-time invariant check throws.
  ANTHROPIC_SKILL_LEASE_TTL_MS: 10 * 60 * 1000,
}));

vi.mock("@/lib/anthropic-skill-sync-dao", () => ({
  listAllSyncRows: (fp: string, env: string) => listAllSyncRows(fp, env),
  deleteSyncRowsForAnthropicSkill: (fp: string, env: string, id: string) =>
    deleteSyncRowsForAnthropicSkill(fp, env, id),
  withNamespaceSyncLock: (
    fp: string,
    env: string,
    fn: () => Promise<unknown>,
  ) => withNamespaceSyncLock(fp, env, fn),
}));

vi.mock("@/lib/anthropic-skill-lease-dao", () => ({
  countActiveLeasesForSkill: (fp: string, env: string, id: string) =>
    countActiveLeasesForSkill(fp, env, id),
  pruneExpiredLeases: (fp: string, env: string) => pruneExpiredLeases(fp, env),
}));

const { reclaimStaleAnthropicSkills } = await import(
  "../anthropic-skill-gc-service"
);

beforeEach(() => {
  globalEnabled = false;
  deriveFp.mockReset();
  deriveEnv.mockReset();
  collect.mockClear();
  pruneExpiredLeases.mockClear();
  withNamespaceSyncLock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("reclaimStaleAnthropicSkills — governance gating", () => {
  it("opt-in OFF ⇒ fully inert (no namespace derivation, no engine)", async () => {
    globalEnabled = false;
    const res = await reclaimStaleAnthropicSkills();
    expect(res).toEqual({ ok: true, reclaimed: [], skipped: [], errors: [] });
    expect(deriveFp).not.toHaveBeenCalled();
    expect(deriveEnv).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(withNamespaceSyncLock).not.toHaveBeenCalled();
  });

  it("no Anthropic key ⇒ nothing remote to reclaim (no engine)", async () => {
    globalEnabled = true;
    deriveFp.mockReturnValue(null);
    const res = await reclaimStaleAnthropicSkills();
    expect(res).toEqual({ ok: true, reclaimed: [], skipped: [], errors: [] });
    expect(collect).not.toHaveBeenCalled();
  });

  it("undeterminable namespace ⇒ fail-closed (ok:false, no remote work)", async () => {
    globalEnabled = true;
    deriveFp.mockReturnValue("fp1");
    deriveEnv.mockImplementation(() => {
      throw new Error("SUPABASE_DB_URL is unset");
    });
    const res = await reclaimStaleAnthropicSkills();
    expect(res.ok).toBe(false);
    expect(res.namespaceError).toMatch(/SUPABASE_DB_URL/);
    expect(collect).not.toHaveBeenCalled();
    expect(withNamespaceSyncLock).not.toHaveBeenCalled();
  });

  it("opt-in ON + derivable ns ⇒ engine runs under lock; leases pruned first", async () => {
    globalEnabled = true;
    deriveFp.mockReturnValue("fp1");
    deriveEnv.mockReturnValue("env1");
    const res = await reclaimStaleAnthropicSkills();
    expect(res.ok).toBe(true);
    expect(withNamespaceSyncLock).toHaveBeenCalledWith(
      "fp1",
      "env1",
      expect.any(Function),
    );
    expect(pruneExpiredLeases).toHaveBeenCalledWith("fp1", "env1");
    expect(collect).toHaveBeenCalledTimes(1);
    // The engine is passed a LIVE fail-closed reader (a function, not a bool).
    expect(typeof collect.mock.calls[0][0]).toBe("function");
  });
});
