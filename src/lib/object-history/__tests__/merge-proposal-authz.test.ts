// Fixture test asserting the merge-proposal review
// surfaces enforce object.read / object.update on the TARGET object.
//
// Without per-object authz on the target, the org-scoped proposal lookup
// would leak proposal contents and let any active-org user reject
// review work for objects they had no object.update on.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PAGE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "data-safety",
  "merge-proposals",
  "[proposalId]",
  "page.tsx",
);
const ACTIONS_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "data-safety",
  "merge-proposals",
  "[proposalId]",
  "actions.ts",
);

const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");
const ACTIONS_SOURCE = readFileSync(ACTIONS_PATH, "utf8");

describe("merge-proposal review authz", () => {
  describe("detail page", () => {
    it("enforces object.read on the target object before rendering proposal fields", () => {
      expect(PAGE_SOURCE).toMatch(/enforceResourceAccess/);
      expect(PAGE_SOURCE).toMatch(/"object\.read"/);
    });

    it("loads the target object via getObjectById", () => {
      expect(PAGE_SOURCE).toMatch(/getObjectById\(proposal\.objectId/);
    });

    it("notFound()s when AuthzError is thrown", () => {
      expect(PAGE_SOURCE).toMatch(/if \(e instanceof AuthzError\) notFound\(\)/);
    });

    it("uses actorFromSession + resolveOrgRoleForSession for role hints", () => {
      expect(PAGE_SOURCE).toMatch(/actorFromSession\(session\)/);
      expect(PAGE_SOURCE).toMatch(/resolveOrgRoleForSession/);
    });
  });

  describe("reject action", () => {
    it("enforces object.update on the target before rejecting", () => {
      expect(ACTIONS_SOURCE).toMatch(/enforceResourceAccess[\s\S]+"object\.update"/);
      // Reject action runs the same authz pattern as approve.
      expect(ACTIONS_SOURCE).toMatch(/rejectMergeProposalAction/);
    });

    it("loads the target object via getObjectById in the reject action", () => {
      // Reject action must enforce object.update on the target, which
      // requires loading the target row first.
      const rejectSection = ACTIONS_SOURCE.slice(
        ACTIONS_SOURCE.indexOf("rejectMergeProposalAction"),
      );
      expect(rejectSection).toMatch(/getObjectById\(proposal\.objectId/);
    });

    it("rejects orgless callers before reaching authz", () => {
      const rejectSection = ACTIONS_SOURCE.slice(
        ACTIONS_SOURCE.indexOf("rejectMergeProposalAction"),
      );
      expect(rejectSection).toMatch(/no active organization on session/);
    });
  });

  describe("approve action (already had authz; lock in the contract)", () => {
    it("enforces object.update on the target", () => {
      const approveSection = ACTIONS_SOURCE.slice(
        ACTIONS_SOURCE.indexOf("approveMergeProposalAction"),
        ACTIONS_SOURCE.indexOf("rejectMergeProposalAction"),
      );
      expect(approveSection).toMatch(/enforceResourceAccess[\s\S]+"object\.update"/);
    });
  });
});
