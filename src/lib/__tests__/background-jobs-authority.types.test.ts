// Compile-time proof of the cinatra#1941 `JobAuthorityMetadata` type fences
// (D1/D6). The real assertions are the `@ts-expect-error` directives below:
// they are checked by the CI Typecheck job (tsc), which is the authority — the
// author box does not run a full-repo type check (OOM discipline). vitest only
// executes the trivial runtime assertion at the bottom (esbuild strips types, so
// `@ts-expect-error` is a no-op at runtime).
//
// Each negative case MUST produce a genuine type error (an unused suppression
// directive would itself fail tsc). Each positive control MUST compile; a real
// fence regression makes one stop compiling and fails CI.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { JobHandler, JobAuthorityMetadata } from "@/lib/background-jobs-registry";

// ---------------------------------------------------------------------------
// NEGATIVE cases — the fences (each line marked `@ts-expect-error` must error).
// ---------------------------------------------------------------------------

// (1) `authority` is REQUIRED on JobHandler — the total registry Record makes an
//     entry without it a compile error.
// @ts-expect-error — missing required property `authority`.
const missingAuthority: JobHandler = {
  payloadSchema: z.object({}).passthrough(),
  handle: async () => {},
};

// (2) `no-org-write` forbids `capabilities` (`?: never`).
const noOrgWriteWithCaps: JobAuthorityMetadata = {
  authorityKind: "no-org-write",
  actorSource: "none",
  // @ts-expect-error — `capabilities` is `never` on the no-org-write arm.
  capabilities: ["content.write"],
};

// (3) `grandfathered-run` REQUIRES `runExtractor`.
// @ts-expect-error — missing required property `runExtractor`.
const grandfatheredNoRun: JobAuthorityMetadata = {
  authorityKind: "grandfathered-run",
  actorSource: "run-row",
  orgExtractor: { source: "run-row" },
  capabilities: ["run.execute", "run.complete"],
  allowedPurposes: ["agent-run-dispatch"],
};

// (4) `originating-actor` `capabilities` is non-empty by construction — an empty
//     tuple makes the whole literal unassignable (object-level error).
// @ts-expect-error — empty capabilities tuple is not assignable to the non-empty tuple.
const originatingEmptyCaps: JobAuthorityMetadata = {
  authorityKind: "originating-actor",
  actorSource: "enqueuer-actor-context",
  orgExtractor: { source: "actor-context" },
  capabilities: [],
};

// (5) `originating-actor` cannot bind its org from a run row (object-level error).
// @ts-expect-error — run-row org binding is illegal for originating-actor.
const originatingRunRowOrg: JobAuthorityMetadata = {
  authorityKind: "originating-actor",
  actorSource: "enqueuer-actor-context",
  orgExtractor: { source: "run-row" },
  capabilities: ["content.write"],
};

// (6) `no-org-write` forbids `runExtractor` (`?: never`).
const noOrgWriteWithRun: JobAuthorityMetadata = {
  authorityKind: "no-org-write",
  actorSource: "none",
  // @ts-expect-error — `runExtractor` is `never` on the no-org-write arm.
  runExtractor: { source: "payload", field: "runId" },
};

// ---------------------------------------------------------------------------
// POSITIVE controls — one valid literal per arm; each MUST compile.
// ---------------------------------------------------------------------------

const validNoOrgWrite: JobAuthorityMetadata = {
  authorityKind: "no-org-write",
  actorSource: "enqueuer-attribution-only",
};
const validOriginating: JobAuthorityMetadata = {
  authorityKind: "originating-actor",
  actorSource: "payload-principal",
  orgExtractor: { source: "payload", field: "orgId" },
  capabilities: ["content.write"],
};
const validGrandfathered: JobAuthorityMetadata = {
  authorityKind: "grandfathered-run",
  actorSource: "run-row",
  orgExtractor: { source: "run-row" },
  runExtractor: { source: "payload", field: "runId" },
  capabilities: ["run.execute", "run.complete"],
  allowedPurposes: ["agent-run-dispatch"],
};
const validMintableMaintenance: JobAuthorityMetadata = {
  authorityKind: "system-maintenance",
  actorSource: "dispatcher-system-identity",
  orgExtractor: { source: "row-sweep", note: "outbox rows' org_id" },
  capabilities: ["content.write"],
};
const validNonMintableMaintenance: JobAuthorityMetadata = {
  authorityKind: "system-maintenance",
  actorSource: "dispatcher-system-identity",
  orgExtractor: { source: "global-org-attributed", note: "global-cutoff delete" },
  capabilities: [],
};

describe("background-jobs authority — type fences (compile-time)", () => {
  it("the @ts-expect-error fixtures are enforced by the CI Typecheck job", () => {
    // References keep the compile-time fixtures 'used' for the linter; the real
    // assertions are the @ts-expect-error directives (checked by tsc, not vitest).
    const fixtures = [
      missingAuthority,
      noOrgWriteWithCaps,
      grandfatheredNoRun,
      originatingEmptyCaps,
      originatingRunRowOrg,
      noOrgWriteWithRun,
      validNoOrgWrite,
      validOriginating,
      validGrandfathered,
      validMintableMaintenance,
      validNonMintableMaintenance,
    ];
    expect(fixtures).toHaveLength(11);
  });
});
