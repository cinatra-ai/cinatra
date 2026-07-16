import { NextResponse, type NextRequest } from "next/server";

import type { TransitionOpts } from "@cinatra-ai/extensions/lifecycle-primitive";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

import {
  CONFORMANCE_RUN_ID_RE,
  SEEDED_INSTALLED_EXTENSIONS,
  SEEDED_SOURCE_INTEGRITY,
  SEEDED_SOURCE_REGISTRY_URL,
  seededPackageName,
  seededPackagePrefix,
  seededRowId,
} from "../seed-data";

// ---------------------------------------------------------------------------
// Design-conformance seeded-fixture provisioning endpoint (cinatra#986).
//
// POST   { runId }  → CONVERGE the run namespace to exactly the committed seed
//                     kit (seed-data.ts): missing rows are installed, stale or
//                     extra rows in the namespace are removed, statuses are
//                     transitioned. IDEMPOTENT — re-invocations (Playwright
//                     retries, parallel shards sharing a run id) converge to
//                     the same end state, so exact-count assertions cannot be
//                     cross-contaminated.
// DELETE { runId }  → remove every row in the run namespace (per-run cleanup).
//
// All writes go through the REAL extension lifecycle primitive
// (installExtensionManifest / transitionExtensionLifecycle) against the REAL
// canonical installed_extension store — the same code path a real install
// takes below the registry fetch — never raw SQL.
//
// REACHABILITY CONTRACT (mirrors isDevOnlyPublicPath, src/lib/auth-route-guard.ts):
// enabled in non-production runtimes, and under a production build ONLY when
// the documented browser-e2e switch CINATRA_E2E_SETUP_BYPASS === "true" is set
// (the design-visual-verify CI harness). Never enabled in a real production
// deployment; every write is confined to the @cinatra-e2e/<runId>-- namespace.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

// Store/lifecycle modules are loaded lazily inside the handlers: this route
// is a NEW app-route entry into the extensions package graph, and importing
// the heavy lifecycle modules at module scope would change build-time module
// evaluation order for unrelated routes sharing the chunk graph. The handlers
// still call the REAL primitives.
async function loadStore() {
  const [{ listInstalledExtensions }, { installExtensionManifest, transitionExtensionLifecycle }] =
    await Promise.all([
      import("@cinatra-ai/extensions/canonical-store"),
      import("@cinatra-ai/extensions/lifecycle-primitive"),
    ]);
  return { listInstalledExtensions, installExtensionManifest, transitionExtensionLifecycle };
}
type Store = Awaited<ReturnType<typeof loadStore>>;

const SEED_ACTOR: TransitionOpts = {
  actor: { source: "design-conformance-seed" },
  reason: "cinatra#986 design-conformance seeded-fixture provisioning",
};

// Locked fixture rows (cinatra#1571) reject every destructive op (force_delete /
// archive / …) by the lifecycle matrix. The seed OWNS every @cinatra-e2e/<runId>
// row, so both convergence-teardown and the DELETE cleanup must UNLOCK a locked
// row first — platform-admin + allowUnlock, scoped to the seed's own namespace —
// or a locked seed could never be removed or transitioned out of the kit.
const SEED_UNLOCK: TransitionOpts = {
  actor: { source: "design-conformance-seed", roles: ["platform_admin"] },
  reason: "cinatra#1571 seed teardown — unlock a locked fixture row before removal",
  allowUnlock: true,
};

/**
 * Destructively remove a seeded namespace row, unlocking a locked row first
 * (the lifecycle matrix rejects force_delete on a locked row). Used by both the
 * POST stale-row sweep and the DELETE per-run cleanup so a locked fixture row
 * never wedges convergence or teardown.
 */
async function forceRemoveRow(store: Store, row: InstalledExtension): Promise<void> {
  if (row.status === "locked") {
    await store.transitionExtensionLifecycle(row.id, "unlock", SEED_UNLOCK);
  }
  await store.transitionExtensionLifecycle(row.id, "force_delete", SEED_ACTOR);
}

function seedingEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.CINATRA_E2E_SETUP_BYPASS === "true";
}

async function parseRunId(req: NextRequest): Promise<string | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  const runId = (body as { runId?: unknown } | null)?.runId;
  if (typeof runId !== "string" || !CONFORMANCE_RUN_ID_RE.test(runId)) return null;
  return runId;
}

type TargetRow = {
  id: string;
  packageName: string;
  kind: InstalledExtension["kind"];
  status: "active" | "locked" | "archived";
  version: string;
  /** verdaccio source registryUrl (cinatra#1572); defaults to SEEDED_SOURCE_REGISTRY_URL. */
  registryUrl: string;
};

function targetRows(runId: string): TargetRow[] {
  return SEEDED_INSTALLED_EXTENSIONS.map((seed) => ({
    id: seededRowId(runId, seed.base),
    packageName: seededPackageName(runId, seed.base),
    kind: seed.kind,
    status: seed.status,
    version: seed.version,
    registryUrl: seed.registryUrl ?? SEEDED_SOURCE_REGISTRY_URL,
  }));
}

async function namespaceRows(store: Store, runId: string): Promise<InstalledExtension[]> {
  const prefix = seededPackagePrefix(runId);
  const all = await store.listInstalledExtensions();
  return all.filter((row) => row.packageName.startsWith(prefix));
}

function matchesTarget(row: InstalledExtension, target: TargetRow): boolean {
  // FULL identity + provenance match (codex-caught): a stale namespace row
  // that only shares id/kind/version but differs in packageName or source
  // provenance must be removed and re-installed, or the namespace would not
  // converge EXACTLY to the committed kit.
  return (
    row.id === target.id &&
    row.packageName === target.packageName &&
    row.kind === target.kind &&
    row.source.type === "verdaccio" &&
    row.source.version === target.version &&
    row.source.packageName === target.packageName &&
    row.source.registryUrl === target.registryUrl &&
    row.source.integrity === SEEDED_SOURCE_INTEGRITY
  );
}

// Per-run fixture organization id for connector-kind seed rows. The connector
// org-anchor invariant (cinatra#1125, enforced in installExtensionManifest)
// rejects a connector install that is neither a static-bundle platform/
// workspace anchor NOR organization-anchored (owner_level='organization' with
// owner_id = organization_id). The seeded kit carries a connector row
// (seed-data.ts `ledger-link`) whose verdaccio provenance is not a static-
// bundle anchor, so it must be org-anchored — which also mirrors production,
// where every real connector install is org-anchored. Namespaced per run to
// stay inside the run's isolation boundary; organization_id is a free-text
// column (no FK), so no organization row needs to pre-exist.
function seededOrgAnchorId(runId: string): string {
  return `design-conformance--${runId}--org`;
}

async function installTargetRow(store: Store, target: TargetRow, runId: string): Promise<void> {
  // Connectors are organization-anchored to satisfy the org-anchor invariant;
  // every other kind keeps the platform anchor (ownerId/organizationId null).
  const orgId = target.kind === "connector" ? seededOrgAnchorId(runId) : null;
  await store.installExtensionManifest(
    {
      id: target.id,
      packageName: target.packageName,
      ownerLevel: orgId ? "organization" : "platform",
      ownerId: orgId,
      organizationId: orgId,
      kind: target.kind,
      source: {
        type: "verdaccio",
        registryUrl: target.registryUrl,
        packageName: target.packageName,
        version: target.version,
        integrity: SEEDED_SOURCE_INTEGRITY,
      },
      requiredInProd: false,
      dependencies: [],
      manifestHash: null,
      accessDeclaration: null,
    },
    SEED_ACTOR,
  );
  if (target.status === "archived") {
    await store.transitionExtensionLifecycle(target.id, "archive", SEED_ACTOR);
  } else if (target.status === "locked") {
    // The REAL `lock` lifecycle transition (admin/required-in-prod semantics) —
    // the only way to seed a status === 'locked' row so the Locked view
    // (cinatra#1571) and the All view have a genuine locked card to render.
    await store.transitionExtensionLifecycle(target.id, "lock", SEED_ACTOR);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!seedingEnabled()) return new NextResponse(null, { status: 404 });
  const runId = await parseRunId(req);
  if (!runId) {
    return NextResponse.json({ error: "body must be { runId } matching " + String(CONFORMANCE_RUN_ID_RE) }, { status: 400 });
  }

  const store = await loadStore();
  const targets = targetRows(runId);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const existing = await namespaceRows(store, runId);

  let removed = 0;
  let installed = 0;
  let transitioned = 0;

  // 1. Remove namespace rows that are not (or no longer match) a target row.
  for (const row of existing) {
    const target = targetById.get(row.id);
    if (target && matchesTarget(row, target)) continue;
    await forceRemoveRow(store, row);
    removed += 1;
  }

  // 2. Install missing targets; converge status on matching survivors.
  const survivors = new Map(
    existing
      .filter((row) => {
        const target = targetById.get(row.id);
        return target !== undefined && matchesTarget(row, target);
      })
      .map((row) => [row.id, row]),
  );
  for (const target of targets) {
    const row = survivors.get(target.id);
    if (!row) {
      // Concurrency-tolerant (codex-caught): two shards sharing a run id can
      // both see the row missing and race the insert. The loser's
      // duplicate-key error means the row now exists with the SAME
      // deterministic content — that IS the converged state, not a failure.
      try {
        await installTargetRow(store, target, runId);
        installed += 1;
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        if (code !== "23505" && !/duplicate key|already exists/i.test(message)) {
          throw err;
        }
      }
      continue;
    }
    if (row.status !== target.status) {
      // Converge a survivor's status to its committed target. A fresh locked
      // base is locked at install time (installTargetRow); this path runs only
      // for a base whose committed status CHANGED across commits. A LOCKED
      // survivor rejects 'archive' and stays locked through 'activate' (only an
      // admin unlock demotes locked→active), so a locked survivor moving to any
      // non-locked target must be UNLOCKED first (seed-owned, platform-admin);
      // it is then active and the target op applies cleanly.
      if (row.status === "locked" && target.status !== "locked") {
        await store.transitionExtensionLifecycle(target.id, "unlock", SEED_UNLOCK);
      }
      const op =
        target.status === "archived"
          ? "archive"
          : target.status === "locked"
            ? "lock"
            : "activate";
      await store.transitionExtensionLifecycle(target.id, op, SEED_ACTOR);
      transitioned += 1;
    }
  }

  return NextResponse.json({ runId, installed, removed, transitioned, total: targets.length });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!seedingEnabled()) return new NextResponse(null, { status: 404 });
  const runId = await parseRunId(req);
  if (!runId) {
    return NextResponse.json({ error: "body must be { runId } matching " + String(CONFORMANCE_RUN_ID_RE) }, { status: 400 });
  }
  const store = await loadStore();
  const existing = await namespaceRows(store, runId);
  for (const row of existing) {
    await forceRemoveRow(store, row);
  }
  return NextResponse.json({ runId, removed: existing.length });
}
