// cinatra#1941 Stage S1 — runtime proof that every background job is classified
// and that the unclassified case fails closed. Complements the compile-time
// fences in background-jobs-authority.types.test.ts:
//   - completeness: all 34 entries carry authority passing the runtime validator;
//   - kind distribution + non-mintable count match the design;
//   - a literal per-row snapshot so any reclassification is a visible diff;
//   - the runtime fail-closed guard in dispatchRegisteredJob (D6);
//   - isValidJobAuthorityMetadata unit coverage;
//   - two classification invariants: EXTENSION_AUTO_UPDATE is
//     NULL-org-bounded, and the auto-update + vendor local modules do no
//     org-axis raw-SQL writes.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Job } from "bullmq";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import {
  BACKGROUND_JOB_REGISTRY,
  dispatchRegisteredJob,
  UnclassifiedBackgroundJobError,
  isValidJobAuthorityMetadata,
  type JobHandler,
  type JobAuthorityMetadata,
} from "@/lib/background-jobs-registry";
import { BACKGROUND_JOB_NAMES, type BackgroundJobName } from "@/lib/background-jobs-names";
import {
  selectAutoUpdateCandidates,
  newExtensionAutoUpdateRunSummary,
  type AutoUpdateInstalledRow,
  type ExtensionAutoUpdateDeps,
} from "@/lib/extension-auto-update";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AuthoritySummary = {
  kind: JobAuthorityMetadata["authorityKind"];
  actorSource: string;
  orgSource: string | null;
  caps: readonly string[] | null;
  runField: string | null;
  purposes: readonly string[] | null;
};

function summarize(a: JobAuthorityMetadata): AuthoritySummary {
  const m = a as {
    authorityKind: JobAuthorityMetadata["authorityKind"];
    actorSource: string;
    orgExtractor?: { source: string };
    runExtractor?: { field: string };
    capabilities?: readonly string[];
    allowedPurposes?: readonly string[];
  };
  return {
    kind: m.authorityKind,
    actorSource: m.actorSource,
    orgSource: m.orgExtractor?.source ?? null,
    caps: m.capabilities ? [...m.capabilities] : null,
    runField: m.runExtractor?.field ?? null,
    purposes: m.allowedPurposes ? [...m.allowedPurposes] : null,
  };
}

const NAME_BY_VALUE = Object.fromEntries(
  Object.entries(BACKGROUND_JOB_NAMES).map(([constName, value]) => [value, constName]),
) as Record<string, string>;

const registryEntries = Object.entries(BACKGROUND_JOB_REGISTRY) as [
  BackgroundJobName,
  JobHandler,
][];

// ---------------------------------------------------------------------------
// Completeness + distribution
// ---------------------------------------------------------------------------

describe("background-jobs authority — classification completeness", () => {
  it("classifies exactly 35 registered jobs (total record)", () => {
    expect(registryEntries).toHaveLength(35);
  });

  it("every entry has authority that passes the runtime validator (fail-closed backstop)", () => {
    for (const [jobName, handler] of registryEntries) {
      const label = NAME_BY_VALUE[jobName] ?? jobName;
      expect(handler.authority, `${label}: authority missing`).toBeDefined();
      expect(
        isValidJobAuthorityMetadata(handler.authority),
        `${label}: authority failed the validator`,
      ).toBe(true);
    }
  });

  it("kind distribution matches the design (17 / 4 / 2 / 12)", () => {
    const counts: Record<string, number> = {
      "no-org-write": 0,
      "originating-actor": 0,
      "grandfathered-run": 0,
      "system-maintenance": 0,
    };
    for (const [, handler] of registryEntries) counts[handler.authority.authorityKind]++;
    expect(counts).toEqual({
      "no-org-write": 17,
      "originating-actor": 4,
      "grandfathered-run": 2,
      // cinatra#1940 P4 adds LEASE_EXPIRY_FINALIZE (mintable system-maintenance).
      "system-maintenance": 12,
    });
  });

  it("exactly 4 non-mintable (empty-capabilities) system-maintenance jobs", () => {
    const nonMintable = registryEntries
      .filter(([, h]) => {
        const caps = (h.authority as { capabilities?: readonly unknown[] }).capabilities;
        return h.authority.authorityKind === "system-maintenance" && Array.isArray(caps) && caps.length === 0;
      })
      .map(([jobName]) => NAME_BY_VALUE[jobName] ?? jobName)
      .sort();
    expect(nonMintable).toEqual(
      [
        "AUDIT_RETENTION_ENFORCE",
        "ARTIFACT_PROVIDER_CACHE_EVICT",
        "ENVIRONMENT_LAYER_GC_REAP",
        "PM_SCHEDULE_RECONCILE",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Per-row snapshot — reclassifying any job becomes a visible diff + review event.
// ---------------------------------------------------------------------------

describe("background-jobs authority — per-row classification snapshot", () => {
  it("pins the exact classification of all 35 jobs", () => {
    const actual = Object.fromEntries(
      registryEntries.map(([jobName, handler]) => [
        NAME_BY_VALUE[jobName] ?? jobName,
        summarize(handler.authority),
      ]),
    );

    const expected: Record<string, AuthoritySummary> = {
      // originating-actor (4)
      BLOG_POST_IMAGE_REGENERATION: { kind: "originating-actor", actorSource: "enqueuer-actor-context", orgSource: "actor-context", caps: ["content.write"], runField: null, purposes: null },
      BLOG_POST_WORDPRESS_DRAFT_CREATION: { kind: "originating-actor", actorSource: "enqueuer-actor-context", orgSource: "actor-context", caps: ["content.write"], runField: null, purposes: null },
      BLOG_POST_LINKEDIN_DRAFT_PUBLISH: { kind: "originating-actor", actorSource: "enqueuer-actor-context", orgSource: "actor-context", caps: ["content.write"], runField: null, purposes: null },
      TWENTY_POINTER_REPAIR: { kind: "originating-actor", actorSource: "payload-principal", orgSource: "payload", caps: ["content.write"], runField: null, purposes: null },
      // grandfathered-run (2)
      AGENT_BUILDER_EXECUTION: { kind: "grandfathered-run", actorSource: "run-row", orgSource: "run-row", caps: ["run.execute", "run.complete"], runField: "runId", purposes: ["agent-run-dispatch"] },
      AGENT_RUN_TRIGGER_RELEASE: { kind: "grandfathered-run", actorSource: "run-row", orgSource: "run-row", caps: ["run.execute", "run.complete"], runField: "runId", purposes: ["agent-run-dispatch"] },
      // system-maintenance — mintable (7)
      GRAPHITI_PROJECTION_REPAIR: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: ["content.write"], runField: null, purposes: null },
      ARTIFACT_MATCH_RUN: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "payload", caps: ["content.write"], runField: null, purposes: null },
      UNBOUND_OUTPUT_DERIVE: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "payload", caps: ["content.write"], runField: "runId", purposes: null },
      UNBOUND_OUTPUT_DERIVE_SWEEP: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: ["content.write"], runField: null, purposes: null },
      ARTIFACT_REVIEW_RESUME_DELIVERY: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: ["run.execute", "run.complete"], runField: null, purposes: ["agent-run-dispatch"] },
      LIFECYCLE_REVIEW_ORCHESTRATION: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: ["content.write"], runField: null, purposes: null },
      LIFECYCLE_GATE_MAINTENANCE: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: ["content.write"], runField: null, purposes: null },
      // system-maintenance — non-mintable (4)
      AUDIT_RETENTION_ENFORCE: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "global-org-attributed", caps: [], runField: null, purposes: null },
      ARTIFACT_PROVIDER_CACHE_EVICT: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: [], runField: null, purposes: null },
      ENVIRONMENT_LAYER_GC_REAP: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "global-org-attributed", caps: [], runField: null, purposes: null },
      PM_SCHEDULE_RECONCILE: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "parent-ref", caps: [], runField: null, purposes: null },
      // no-org-write (17)
      LITELLM_PRICING_SYNC: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      REGISTRY_POLL: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_PREFILL_GENERATION: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      CHAT_CAPTURE_DETECTION: { kind: "no-org-write", actorSource: "enqueuer-attribution-only", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_MATCH_INLINE_FOR_SKILL: { kind: "no-org-write", actorSource: "enqueuer-attribution-only", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_MATCH_INLINE_FOR_AGENT: { kind: "no-org-write", actorSource: "enqueuer-attribution-only", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_MATCH_BATCH_SUBMIT: { kind: "no-org-write", actorSource: "enqueuer-attribution-only", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_MATCH_BATCH_POLL: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_MATCH_DRIFT_SAMPLE: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      SKILL_MATCH_MAINTENANCE_TICK: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      EXTENSION_STORE_GC_REAP: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      EXTENSION_AUTO_UPDATE: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      MARKETPLACE_CATALOG_SYNC: { kind: "no-org-write", actorSource: "enqueuer-attribution-only", orgSource: null, caps: null, runField: null, purposes: null },
      VENDOR_APPLICATION_STATE_RECONCILE: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      WEBHOOK_OUTBOUND_DELIVERY: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      // cinatra#2092 (epic #2086 S5) — the upload-on-install reconcile drain
      // (one-shot commit kick) and its safety-net sweep. Both write only
      // instance-scoped, org-column-free tables (the reconcile outbox, the
      // anthropic_skill_sync/lease mirror state, one metadata key) and call the
      // Anthropic Skills API; the workspace skills catalog is READ only.
      ANTHROPIC_SKILL_UPLOAD_RECONCILE: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      ANTHROPIC_SKILL_UPLOAD_RECONCILE_SWEEP: { kind: "no-org-write", actorSource: "none", orgSource: null, caps: null, runField: null, purposes: null },
      // cinatra#1940 P4 — the lease-expiry finalizer sweep: mintable
      // system-maintenance holding ONLY `run.lease-expire` through the
      // dedicated `"lease-expiry-finalizer"` purpose (least privilege).
      LEASE_EXPIRY_FINALIZE: { kind: "system-maintenance", actorSource: "dispatcher-system-identity", orgSource: "row-sweep", caps: ["run.lease-expire"], runField: null, purposes: ["lease-expiry-finalizer"] },
    };

    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Runtime fail-closed guard (D6)
// ---------------------------------------------------------------------------

describe("background-jobs authority — runtime fail-closed guard", () => {
  const FAKE = "__unclassified_test_job__";

  afterEach(() => {
    delete (BACKGROUND_JOB_REGISTRY as unknown as Record<string, unknown>)[FAKE];
    vi.restoreAllMocks();
  });

  it("refuses a handler whose authority is ABSENT (as-cast / drift hole) and never runs it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    (BACKGROUND_JOB_REGISTRY as unknown as Record<string, unknown>)[FAKE] = {
      payloadSchema: z.object({}).passthrough(),
      handle,
      // authority intentionally omitted (simulates a hole smuggled past tsc).
    };
    const job = { name: FAKE, data: {}, id: "job-1" } as unknown as Job;

    await expect(dispatchRegisteredJob(job, "job-1")).rejects.toBeInstanceOf(
      UnclassifiedBackgroundJobError,
    );
    expect(handle).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it("refuses a handler whose authority is PRESENT but structurally invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn(async () => {});
    (BACKGROUND_JOB_REGISTRY as unknown as Record<string, unknown>)[FAKE] = {
      payloadSchema: z.object({}).passthrough(),
      authority: { authorityKind: "bogus-kind" },
      handle,
    };
    const job = { name: FAKE, data: {}, id: "job-2" } as unknown as Job;

    await expect(dispatchRegisteredJob(job, "job-2")).rejects.toBeInstanceOf(
      UnclassifiedBackgroundJobError,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("still throws the unknown-name error for a name with no registry entry", async () => {
    const job = { name: "totally-unknown-job", data: {}, id: "job-3" } as unknown as Job;
    await expect(dispatchRegisteredJob(job, "job-3")).rejects.toThrow(
      /Unsupported background job/,
    );
  });
});

// ---------------------------------------------------------------------------
// isValidJobAuthorityMetadata unit coverage
// ---------------------------------------------------------------------------

describe("isValidJobAuthorityMetadata", () => {
  it("rejects non-objects, empties, and unknown kinds", () => {
    expect(isValidJobAuthorityMetadata(null)).toBe(false);
    expect(isValidJobAuthorityMetadata(undefined)).toBe(false);
    expect(isValidJobAuthorityMetadata("nope")).toBe(false);
    expect(isValidJobAuthorityMetadata({})).toBe(false);
    expect(isValidJobAuthorityMetadata({ authorityKind: "mystery" })).toBe(false);
  });

  it("rejects fence violations", () => {
    // no-org-write with capabilities
    expect(
      isValidJobAuthorityMetadata({ authorityKind: "no-org-write", actorSource: "none", capabilities: ["content.write"] }),
    ).toBe(false);
    // grandfathered-run without runExtractor
    expect(
      isValidJobAuthorityMetadata({ authorityKind: "grandfathered-run", actorSource: "run-row", orgExtractor: { source: "run-row" }, capabilities: ["run.execute"], allowedPurposes: [] }),
    ).toBe(false);
    // originating-actor with empty capabilities
    expect(
      isValidJobAuthorityMetadata({ authorityKind: "originating-actor", actorSource: "payload-principal", orgExtractor: { source: "payload", field: "orgId" }, capabilities: [] }),
    ).toBe(false);
    // originating-actor bound to a run row
    expect(
      isValidJobAuthorityMetadata({ authorityKind: "originating-actor", actorSource: "payload-principal", orgExtractor: { source: "run-row" }, capabilities: ["content.write"] }),
    ).toBe(false);
    // non-mintable arm may not carry global-org-attributed WITH capabilities
    expect(
      isValidJobAuthorityMetadata({ authorityKind: "system-maintenance", actorSource: "dispatcher-system-identity", orgExtractor: { source: "global-org-attributed", note: "x" }, capabilities: ["content.write"] }),
    ).toBe(false);
  });

  it("accepts a valid literal of each arm", () => {
    expect(isValidJobAuthorityMetadata({ authorityKind: "no-org-write", actorSource: "enqueuer-attribution-only" })).toBe(true);
    expect(isValidJobAuthorityMetadata({ authorityKind: "originating-actor", actorSource: "payload-principal", orgExtractor: { source: "payload", field: "orgId" }, capabilities: ["content.write"] })).toBe(true);
    expect(isValidJobAuthorityMetadata({ authorityKind: "grandfathered-run", actorSource: "run-row", orgExtractor: { source: "run-row" }, runExtractor: { source: "payload", field: "runId" }, capabilities: ["run.execute", "run.complete"], allowedPurposes: ["agent-run-dispatch"] })).toBe(true);
    expect(isValidJobAuthorityMetadata({ authorityKind: "system-maintenance", actorSource: "dispatcher-system-identity", orgExtractor: { source: "row-sweep", note: "x" }, capabilities: ["content.write"] })).toBe(true);
    expect(isValidJobAuthorityMetadata({ authorityKind: "system-maintenance", actorSource: "dispatcher-system-identity", orgExtractor: { source: "parent-ref", via: "x" }, capabilities: [] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classification invariant (a) — EXTENSION_AUTO_UPDATE is NULL-org-bounded (F2).
// If candidate selection ever admits an org-scoped row, the no-org-write row is
// stale and must be reclassified.
// ---------------------------------------------------------------------------

describe("classification invariant — EXTENSION_AUTO_UPDATE is NULL-org-bounded", () => {
  const NOW = new Date("2026-07-27T12:00:00.000Z");

  function makeRow(overrides: Partial<AutoUpdateInstalledRow> = {}): AutoUpdateInstalledRow {
    return {
      id: "row-1",
      packageName: "@acme/foo",
      kind: "connector",
      organizationId: null,
      status: "active",
      source: { type: "verdaccio", version: "1.0.0" },
      ...overrides,
    };
  }

  function makeDeps(rows: AutoUpdateInstalledRow[]): ExtensionAutoUpdateDeps {
    return {
      isEnabled: () => true,
      isWithinMaintenanceWindow: () => true,
      isDenied: () => false,
      listInstalledRows: async () => rows,
      isRequiredInProd: () => false,
      resolveUpdateReadModelStore: async () => ({
        read: async (names: string[]) =>
          new Map(
            names.map((n) => [
              n,
              { packageName: n, latestVersion: "1.1.0", latestSdkAbiRange: "^2", refreshedAt: NOW.toISOString() },
            ]),
          ),
        upsert: async () => {},
      }),
      evaluateAbiCompat: () => ({ compatible: true }),
      isSignatureReady: async () => true,
      executeUpdate: async () => {},
      writeAuditEvent: async () => {},
      now: () => NOW,
    };
  }

  it("candidate selection excludes organizationId != null rows", async () => {
    const deps = makeDeps([
      makeRow({ id: "null-org", packageName: "@acme/nullorg", organizationId: null }),
      makeRow({ id: "org-scoped", packageName: "@acme/orgscoped", organizationId: "org-123" }),
    ]);
    const candidates = await selectAutoUpdateCandidates(deps, newExtensionAutoUpdateRunSummary());

    // No org-scoped row can ever become a candidate.
    expect(candidates.some((c) => c.row.organizationId !== null)).toBe(false);
    // And the NULL-org eligible row IS selected — proves selection is real, not
    // vacuously empty (which would pass this invariant for the wrong reason).
    expect(candidates.map((c) => c.row.packageName)).toContain("@acme/nullorg");
    expect(candidates.map((c) => c.row.packageName)).not.toContain("@acme/orgscoped");
  });
});

// ---------------------------------------------------------------------------
// Classification invariant (b) — the auto-update + vendor reconcile LOCAL
// modules perform no org-axis raw-SQL DML (their no-org-write / caps-[] rows rest
// on this). Self-contained minimal matcher; S3's system-writer-manifest gate
// owns the canonical shared scanSource, and a lockstep unification is an S3
// follow-up. A positive control guards against a green-for-the-wrong-reason.
// ---------------------------------------------------------------------------

describe("classification invariant — auto-update + vendor local modules do no org-axis DML", () => {
  // Representative kernel org-axis tables (the quote-anchored subset relevant to
  // these paths). S3's gate carries the canonical ORG_AXIS_TABLES list.
  const ORG_AXIS_TABLES = [
    "objects",
    "agent_runs",
    "dashboards",
    "artifacts",
    "semantic_assertion",
    "artifact_review_gates",
    "memberships",
    "organizations",
  ];

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  function hasOrgAxisRawDml(src: string): boolean {
    const clean = stripComments(src);
    const tables = ORG_AXIS_TABLES.join("|");
    // DML verb → optional `"${schema}".` qualifier → QUOTED org-axis table id
    // (the org-write-table-sweep quote-anchor lesson: anchor on the quoted
    // identifier, over comment-stripped source).
    const re = new RegExp(
      `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+(?:"\\$\\{schema\\}"\\.)?"(?:${tables})"`,
      "i",
    );
    return re.test(clean);
  }

  const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

  it("positive control: the matcher DOES flag org-axis raw DML", () => {
    expect(hasOrgAxisRawDml('await db.execute(`UPDATE "objects" SET x = 1 WHERE org_id = $1`)')).toBe(true);
    expect(hasOrgAxisRawDml('sql`INSERT INTO "${schema}"."agent_runs" (id) VALUES ($1)`')).toBe(true);
    // and does NOT flag a prose comment or an FK REFERENCES clause.
    expect(hasOrgAxisRawDml('// UPDATE "objects" someday')).toBe(false);
    expect(hasOrgAxisRawDml('REFERENCES "objects"(id) ON DELETE CASCADE')).toBe(false);
  });

  it("extension-auto-update local runner performs no org-axis raw DML", () => {
    expect(hasOrgAxisRawDml(read("extension-auto-update.ts"))).toBe(false);
  });

  it("vendor-application reconcile local deps perform no org-axis raw DML", () => {
    expect(hasOrgAxisRawDml(read("marketplace-application-reconcile-deps.ts"))).toBe(false);
  });
});
