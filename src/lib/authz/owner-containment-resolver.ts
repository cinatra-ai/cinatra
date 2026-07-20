import "server-only";

// ---------------------------------------------------------------------------
// Owner-axis containment resolver — LIVE membership implementation (#1885 C1;
// C4 #1884 handoff). Publishes the `@cinatra-ai/agents/owner-containment-port`
// resolver so `deriveRunOboCeilingJson` can collapse a mixed-owner-tier child
// OBO ceiling chain to its verified-narrowest tier at dispatch.
//
// The owner axis is a VISIBILITY LATTICE (private `user` ⊂ `team` ⊂ `workspace`
// public — core__0033). We emit a containment fact `Sat(narrower) ⊆ Sat(wider)`
// ONLY when we can PROVE it server-side against the LIVE better-auth store; the
// pure composer fails a mixed composition closed for any pair we leave unproven
// (a wrong fact would collapse to a narrower tier the parent never admitted — a
// widening — so we are deliberately conservative: prove or omit).
//
// Proven relations (both endpoints must be present owner-axis elements of the
// composed chain; every element shares the chain's single org floor, so a
// present workspace/team element is in `orgId`):
//   - user U ⊆ team T      : U is a LIVE member of team T (org-scoped join).
//   - user U ⊆ workspace W : U is a LIVE member of the org (workspace = org-local
//                            public ⊇ any org-member's private).
//   - team T ⊆ workspace W : team T belongs to the org (team-visible ⊂ org-public).
// Transitive closure (U ⊆ T ⊆ W) is completed by the composer's reduction, so we
// emit the direct edges only.
//
// SNAPSHOT-vs-REVOCATION: these reads are the freshest membership at DISPATCH;
// the collapsed chain is persisted and a later revocation is the accepted
// read-time staleness class (see the port module's policy note; cinatra#1131).
// ---------------------------------------------------------------------------
import type { OwnerContainmentResolver } from "@cinatra-ai/agents/owner-containment-port";
import { publishOwnerContainmentResolver } from "@cinatra-ai/agents/owner-containment-port";
import type { OboCeiling, OboOwnerContainment } from "@cinatra-ai/mcp-server/obo-ceiling";
import {
  readTeamsForUser,
  readUserIsOrgMember,
  readTeamsByIdsForOrg,
} from "@/lib/better-auth-db";

export const resolveOwnerContainments: OwnerContainmentResolver = async ({
  orgId,
  ownerElements,
}) => {
  const users = ownerElements.filter((e): e is OboCeiling => e.tier === "user");
  const teams = ownerElements.filter((e): e is OboCeiling => e.tier === "team");
  const workspaces = ownerElements.filter(
    (e): e is OboCeiling => e.tier === "workspace",
  );
  const facts: OboOwnerContainment[] = [];

  // user ⊆ team — a live org-scoped team membership.
  for (const u of users) {
    if (teams.length === 0 && workspaces.length === 0) continue;
    const userTeamIds = new Set(
      (await readTeamsForUser(u.id, orgId)).map((t) => t.id),
    );
    for (const t of teams) {
      if (userTeamIds.has(t.id)) facts.push({ narrower: u, wider: t });
    }
    // user ⊆ workspace — a live org member is contained in org-local-public.
    if (workspaces.length > 0 && (await readUserIsOrgMember(u.id, orgId))) {
      for (const w of workspaces) facts.push({ narrower: u, wider: w });
    }
  }

  // team ⊆ workspace — the team belongs to this org (team-visible ⊂ org-public).
  if (workspaces.length > 0 && teams.length > 0) {
    const teamsInOrg = new Set(
      (await readTeamsByIdsForOrg(teams.map((t) => t.id), orgId)).map((t) => t.id),
    );
    for (const t of teams) {
      if (teamsInOrg.has(t.id)) {
        for (const w of workspaces) facts.push({ narrower: t, wider: w });
      }
    }
  }

  return facts;
};

// Self-publish on module load (mirrors the sibling serve-port publisher in
// `extension-version-keyed-serving.ts`). A side-effect import from the runtime
// entry (`@/lib/mcp-server`) guarantees this loads before any child dispatch.
publishOwnerContainmentResolver(resolveOwnerContainments);
