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
  status: "active" | "archived";
  version: string;
};

function targetRows(runId: string): TargetRow[] {
  return SEEDED_INSTALLED_EXTENSIONS.map((seed) => ({
    id: seededRowId(runId, seed.base),
    packageName: seededPackageName(runId, seed.base),
    kind: seed.kind,
    status: seed.status,
    version: seed.version,
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
    row.source.registryUrl === SEEDED_SOURCE_REGISTRY_URL &&
    row.source.integrity === SEEDED_SOURCE_INTEGRITY
  );
}

async function installTargetRow(store: Store, target: TargetRow): Promise<void> {
  await store.installExtensionManifest(
    {
      id: target.id,
      packageName: target.packageName,
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
      kind: target.kind,
      source: {
        type: "verdaccio",
        registryUrl: SEEDED_SOURCE_REGISTRY_URL,
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
    await store.transitionExtensionLifecycle(row.id, "force_delete", SEED_ACTOR);
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
        await installTargetRow(store, target);
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
      await store.transitionExtensionLifecycle(
        target.id,
        target.status === "archived" ? "archive" : "activate",
        SEED_ACTOR,
      );
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
    await store.transitionExtensionLifecycle(row.id, "force_delete", SEED_ACTOR);
  }
  return NextResponse.json({ runId, removed: existing.length });
}
