import "server-only";

// Dev-only extension fixture seeder.
//
// On a dev boot, applies each installed/dev extension's declared
// `cinatra.devFixtures` into the extension's OWN org-scoped surfaces for a
// host-resolved dev org, so a freshly-installed extension is visible +
// exercisable without the monolithic `scripts/seed.mjs` hardcoding its demo
// rows. Mirrors `dev-auto-setup`: gated on `CINATRA_RUNTIME_MODE==="development"`,
// fire-and-forget, soft-fail (never blocks boot).
//
// SCOPE: reads fixtures from the dev `extensions/` checkout
// (the runtime package store is handled separately) and seeds the `setting`
// surface only. `object` fixtures are VALIDATED by the manifest contract but
// their dev-seeding (host-owned object writer + provenance + reaping) lands with
// the first real consumer — no current connector needs object fixtures, and the
// public `ctx.objects.write` cannot carry the stable id/source provenance an
// idempotent, reapable object fixture needs. Object fixtures are logged + skipped.
//
// IDEMPOTENT + PROVENANCE-TAGGED (settings): each seeded setting carries a
// sidecar provenance row `ext-fixture-prov:<pkg>:<orgId>:<key>` =
// `{pkg,id,rev,checksum}`. Re-running CREATEs missing rows, REPLACEs only rows
// still fixture-owned at an older rev (checksum of the current stored value
// still equals the seeded checksum), and SKIPs anything a user has edited (the
// `ctx.settings.set/delete` path clears the sidecar, so a user write is never
// re-seeded). Writes go through the extension's own grant-enforced `ctx.settings`.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDevFixtures, HOST_PORT_NAMES } from "@cinatra-ai/sdk-extensions";
import type { DevFixtureFile, HostPortName } from "@cinatra-ai/sdk-extensions";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import { devFixtureProvenanceKey } from "@/lib/extension-fixture-provenance";

export type FixtureProvenance = { pkg: string; id: string; rev: number; checksum: string };

export type FixtureAction = "create" | "replace" | "skip";

/**
 * The idempotent create/replace/skip decision for a setting fixture (rev +
 * checksum). Pure — unit-tested in isolation.
 *   - no row yet → CREATE
 *   - row exists but is NOT still-fixture-owned (no sidecar, pkg/id mismatch, or
 *     the stored value's checksum diverged from the seeded checksum = a user
 *     edited it) → SKIP (never clobber a user-owned row)
 *   - still fixture-owned + the fixture-set revision advanced → REPLACE
 *   - still fixture-owned + already at/after this revision → SKIP (converged)
 */
export function decideFixtureAction(input: {
  currentExists: boolean;
  currentChecksum: string | null;
  prov: FixtureProvenance | null;
  pkg: string;
  fixtureId: string;
  rev: number;
}): FixtureAction {
  if (!input.currentExists) return "create";
  const stillFixtureOwned =
    input.prov !== null &&
    input.prov.pkg === input.pkg &&
    input.prov.id === input.fixtureId &&
    input.currentChecksum === input.prov.checksum;
  if (!stillFixtureOwned) return "skip";
  return input.prov!.rev < input.rev ? "replace" : "skip";
}

// Stable, key-sorted stringify so the checksum is insensitive to object key
// order (the seeded value and the round-tripped stored value must hash equally).
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function checksumOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

const tag = "[dev-fixture-seeder]";

export type DevFixtureSeederResult = {
  status: "ok" | "skipped" | "error";
  reason?: string;
  created: number;
  replaced: number;
  skipped: number;
  objectsDeferred: number;
  errors: string[];
};

// Resolve the dev org host-side from trusted bootstrap state (earliest user →
// their first org membership) — the same pattern as `dev-auto-setup`. The
// fixture file MUST NOT name an org; tenancy is host-derived only.
function resolveDevActor(): { userId: string; orgId: string } | null {
  const connectionString = getPostgresConnectionString();
  const userRows = runPostgresQueriesSync({
    connectionString,
    queries: [{ text: `SELECT id FROM public."user" ORDER BY "createdAt" ASC LIMIT 1` }],
  })[0]?.rows as { id: string }[] | undefined;
  const userId = userRows?.[0]?.id;
  if (!userId) return null;
  const orgRows = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT m."organizationId" AS id FROM public."member" m WHERE m."userId" = $1 ORDER BY m."createdAt" ASC LIMIT 1`,
        values: [userId],
      },
    ],
  })[0]?.rows as { id: string }[] | undefined;
  const orgId = orgRows?.[0]?.id;
  if (!orgId) return null;
  return { userId, orgId };
}

type DeclaringExtension = {
  packageName: string;
  grantedPorts: HostPortName[];
  fixtures: DevFixtureFile;
};

// Discover dev-checkout extensions that declare `cinatra.devFixtures`, loading +
// validating each fixture file. A malformed file is collected as an error (the
// static CI gate is the hard fail; dev boot stays unblocked).
async function discoverDeclaringExtensions(errors: string[]): Promise<DeclaringExtension[]> {
  const root = path.join(process.cwd(), "extensions");
  const out: DeclaringExtension[] = [];
  let vendors: string[];
  try {
    vendors = await readdir(root);
  } catch {
    return out; // no extensions checkout (e.g. prod) — nothing to seed from here
  }
  for (const vendor of vendors) {
    let slugs: string[];
    try {
      slugs = await readdir(path.join(root, vendor));
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const pkgPath = path.join(root, vendor, slug, "package.json");
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const name = typeof pkg.name === "string" ? pkg.name : null;
      const cinatra = (pkg.cinatra ?? null) as Record<string, unknown> | null;
      const devFixturesPath = cinatra && typeof cinatra.devFixtures === "string" ? cinatra.devFixtures : null;
      if (!name || !devFixturesPath) continue;
      const grantedPorts = (Array.isArray(cinatra?.requestedHostPorts) ? cinatra!.requestedHostPorts : []).filter(
        (p): p is HostPortName => typeof p === "string" && (HOST_PORT_NAMES as readonly string[]).includes(p),
      );
      try {
        const fileRaw = await readFile(path.join(root, vendor, slug, devFixturesPath), "utf8");
        const fixtures = parseDevFixtures(JSON.parse(fileRaw));
        out.push({ packageName: name, grantedPorts, fixtures });
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return out;
}

async function applySettingFixture(
  ext: DeclaringExtension,
  ctx: ReturnType<typeof createExtensionHostContext>,
  orgId: string,
  fixture: { id: string; key: string; value: unknown },
  rev: number,
  result: DevFixtureSeederResult,
): Promise<void> {
  const sidecarKey = devFixtureProvenanceKey(ext.packageName, orgId, fixture.key);
  const prov = readConnectorConfigFromDatabase<FixtureProvenance | null>(sidecarKey, null);
  const current = await ctx.settings.get<unknown>(fixture.key);
  const seededChecksum = checksumOf(fixture.value);
  const currentExists = current !== null && current !== undefined;

  const action = decideFixtureAction({
    currentExists,
    currentChecksum: currentExists ? checksumOf(current) : null,
    prov,
    pkg: ext.packageName,
    fixtureId: fixture.id,
    rev,
  });

  if (action === "skip") {
    result.skipped += 1;
    return;
  }
  // CREATE or REPLACE — write the raw value through the grant-enforced port,
  // then (re)write the provenance sidecar (ctx.settings.set clears it first).
  await ctx.settings.set(fixture.key, fixture.value);
  writeConnectorConfigToDatabase(sidecarKey, { pkg: ext.packageName, id: fixture.id, rev, checksum: seededChecksum });
  if (action === "create") result.created += 1;
  else result.replaced += 1;
}

/**
 * Apply all declared dev fixtures. Caller gates on dev mode; this is
 * fire-and-forget + soft-fail by contract. Exported for direct invocation
 * from the instrumentation boot hook + for tests.
 */
export async function runDevFixtureSeeder(): Promise<DevFixtureSeederResult> {
  const result: DevFixtureSeederResult = {
    status: "ok",
    created: 0,
    replaced: 0,
    skipped: 0,
    objectsDeferred: 0,
    errors: [],
  };

  const actor = resolveDevActor();
  if (!actor) {
    return { ...result, status: "skipped", reason: "no dev user/org resolvable yet" };
  }

  const declaring = await discoverDeclaringExtensions(result.errors);
  if (declaring.length === 0 && result.errors.length === 0) {
    return { ...result, status: "skipped", reason: "no extension declares cinatra.devFixtures" };
  }

  const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server");

  for (const ext of declaring) {
    const ctx = createExtensionHostContext(ext.packageName, ext.grantedPorts);
    try {
      await mcpRequestContextStorage.run({ userId: actor.userId, orgId: actor.orgId } as never, async () => {
        for (const fixture of ext.fixtures.fixtures) {
          if (fixture.surface === "object") {
            // Object dev-fixture seeding is deferred (no consumer; the public
            // objects client cannot carry stable-id/source provenance for an
            // idempotent, reapable fixture). Validated by the contract, skipped here.
            console.info(`${tag} ${ext.packageName}: object fixture "${fixture.id}" declared but object seeding is deferred — skipped.`);
            result.objectsDeferred += 1;
            continue;
          }
          await applySettingFixture(ext, ctx, actor.orgId, fixture, ext.fixtures.version, result);
        }
      });
    } catch (err) {
      // A fixture targeting an ungranted port fails loud (least-privilege) — caught
      // per-extension so one bad declaration doesn't block the others.
      result.errors.push(`${ext.packageName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.errors.length > 0) result.status = "error";
  const summary = `${tag} created=${result.created} replaced=${result.replaced} skipped=${result.skipped} objectsDeferred=${result.objectsDeferred} errors=${result.errors.length}`;
  if (result.errors.length > 0) console.warn(summary, result.errors);
  else console.info(summary);
  return result;
}
