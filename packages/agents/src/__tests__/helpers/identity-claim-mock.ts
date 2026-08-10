import { vi } from "vitest";
// cinatra#2616 — the collaborator mock for `../agent-template-identity`.
//
// These unit suites already mock `../store` wholesale so they stay
// Postgres-free. The install / import paths now resolve a package name through
// the identity-claim module instead of a bare `readAgentTemplateByPackageName`,
// so that module needs the same treatment. Built from whatever
// package-name lookup the suite already stubs, so a suite keeps ONE source of
// truth for "what row does this name resolve to".
//
// The RULE itself stays REAL (only the two DB-touching operations are stubbed):
// these suites assert install-path plumbing (edges, projections, gates), and the
// rule's own behaviour is proven against a real database in
// `agent-template-identity.integration.test.ts`.

type ClaimRow = { id: string; status?: string; orgId?: string | null } | null;

export async function identityClaimMockFrom(
  readTemplateByPackageName: (packageName: string) => Promise<ClaimRow> | ClaimRow,
) {
  // Keep the module's PURE surface (the rule, the derivations, the error class)
  // real — only the two DB-touching operations are stubbed. Importing the actual
  // module is Postgres-free: its `./db` pool is created lazily on first query.
  const actual = await vi.importActual<Record<string, unknown>>("../../agent-template-identity");
  return {
    ...actual,
    resolveAgentTemplateIdentityClaim: async ({ packageName }: { packageName: string }) => {
      const row = await readTemplateByPackageName(packageName);
      return row ? { outcome: "owned" as const, row } : { outcome: "unclaimed" as const };
    },
    claimAgentTemplateIdentity: async (
      { packageName }: { packageName: string },
      ops: { insert: () => Promise<unknown> },
    ) => {
      const row = await readTemplateByPackageName(packageName);
      if (row) return { mode: "adopted" as const, row };
      try {
        return { mode: "created" as const, created: await ops.insert() };
      } catch (err) {
        // Mirror the production 23505 race classification: re-resolve against
        // the committed winner and adopt it.
        if ((err as { code?: string })?.code !== "23505") throw err;
        const afterRace = await readTemplateByPackageName(packageName);
        if (!afterRace) throw err;
        return { mode: "adopted" as const, row: afterRace };
      }
    },
  };
}
