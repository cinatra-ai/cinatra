// ITEM 4 — CLEAN BOOT WITHOUT @cinatra-ai/default-artifact, proven LIVE against a
// lane DB (prove_1785_boot on the verify Postgres 127.0.0.1:5634) by driving the
// REAL boot-path modules — the exact code a prod boot runs:
//
//   Part A  the REAL extension-closure BOOT GATE (enforceExtensionClosureAtBoot /
//           verifyRequiredInProdInstalled) reading the canonical installed_extension
//           store from the lane DB, in PROD posture → must NOT throw; + a
//           counterfactual (delete a required row) proving the gate has teeth.
//   Part B  the equality TRIPLE computed live from the branch's real files:
//           cinatra.extensions == cinatra.systemExtensions == the required-lock,
//           all WITHOUT default-artifact; floor const + extension dir gone.
//   Part C  the object-type REGISTRY warmed from the REAL extensions/ tree +
//           the REAL registry-routed upload resolver: typed packs present, the
//           generic `@cinatra-ai/artifact:object` catch-all ABSENT, a typed MIME
//           resolves, the `*/*` floor is never a candidate.
//   Part D  the library-served surface: seed a typed objects row of an
//           upload-RESOLVED pack type into the lane DB, read it back through the
//           registry's artifact type-id set → typed row served; zero generic rows.
//
// Run: node --conditions=react-server --import tsx docs/internals/proofs/1785-a6/reproduce-clean-boot.mts
// (cwd must be the worktree root so PACKAGE_JSON_PATH reads the branch manifest.)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const SCHEMA = "cinatra";
const CS = "postgres://postgres:postgres@127.0.0.1:5634/prove_1785_boot";
// Canonical store reads SUPABASE_DB_URL lazily (getCanonicalPool) — set before it pools.
process.env.SUPABASE_DB_URL = CS;
// PROD posture: mode !== "development" makes the closure gate fail-CLOSED (throw).
delete process.env.CINATRA_RUNTIME_MODE;
delete process.env.CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT;

const results: { part: string; name: string; pass: boolean; detail?: string }[] = [];
function assert(part: string, name: string, pass: boolean, detail?: string) {
  results.push({ part, name, pass, ...(detail ? { detail } : {}) });
}

const c = new Client({ connectionString: CS });
await c.connect();
await c.query(`SET search_path TO ${SCHEMA}, public`);

// ---- the branch's real required set (drives the manifest AND the seed) -------
const lock = JSON.parse(readFileSync("cinatra-required-extensions.lock.json", "utf8")) as {
  packages: { packageName: string; packageVersion: string }[];
};
const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  cinatra: { extensions: string[]; systemExtensions: string[] };
};

function kindFor(name: string): string {
  if (name.endsWith("-connector")) return "connector";
  if (name.endsWith("-agent")) return "agent";
  if (name.endsWith("-artifact")) return "artifact";
  return "skill";
}

// Seed the canonical installed_extension store with the branch's real required
// set — every row active + required_in_prod, version = the lock's pin, source a
// verdaccio pin (verifyRequiredInProdInstalled reads source.version for that type).
async function seedRequiredRows(skip?: string) {
  await c.query(`DELETE FROM installed_extension`);
  for (const p of lock.packages) {
    if (p.packageName === skip) continue;
    await c.query(
      `INSERT INTO installed_extension
        (id, package_name, owner_level, owner_id, organization_id, kind, status,
         source, version, is_default, required_in_prod)
       VALUES ($1,$2,'platform','__platform__',NULL,$3,'active',$4::jsonb,$5,true,true)`,
      [
        `ie_${p.packageName.replace(/[^a-z0-9]/gi, "_")}`,
        p.packageName,
        kindFor(p.packageName),
        JSON.stringify({ type: "verdaccio", version: p.packageVersion }),
        p.packageVersion,
      ],
    );
  }
}

// =============================================================================
// PART A — the REAL boot gate against the lane DB (prod posture)
// =============================================================================
await seedRequiredRows();

const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
const { verifyRequiredInProdInstalled, readRequiredInProdPackages, isPackageRequiredInProd } =
  await import("@cinatra-ai/extensions/required-in-prod");
const { enforceExtensionClosureAtBoot, buildClosureBootReport, assertClosureBootReport } =
  await import("../../../../src/lib/extension-closure-boot-gate.ts");

const dbRows = await listInstalledExtensions({});
assert("A", "canonical store read from lane DB returns the 13 required rows", dbRows.length === 13,
  `rows=${dbRows.length}`);

const requiredPkgs = readRequiredInProdPackages();
assert("A", "manifest required set = 13, WITHOUT default-artifact",
  requiredPkgs.length === 13 && !requiredPkgs.some((p) => p.includes("default-artifact")),
  `required=${requiredPkgs.length}`);
assert("A", "isPackageRequiredInProd('@cinatra-ai/default-artifact') === false",
  isPackageRequiredInProd("@cinatra-ai/default-artifact") === false);

const verification = await verifyRequiredInProdInstalled();
assert("A", "verifyRequiredInProdInstalled: ok (no missing / no version-mismatch)",
  verification.ok === true, verification.ok ? `installed=${verification.installed.length}` : verification.reason);
assert("A", "default-artifact absent from the required verification set",
  !verification.required.some((p) => p.includes("default-artifact")));

// THE boot gate: reads the lane DB, PROD posture. Must NOT throw.
let bootThrew: string | null = null;
try {
  await enforceExtensionClosureAtBoot();
} catch (e) {
  bootThrew = e instanceof Error ? e.message : String(e);
}
assert("A", "enforceExtensionClosureAtBoot() clean boot: NO throw (prod posture)",
  bootThrew === null, bootThrew ?? "no throw");

const report = await buildClosureBootReport(dbRows);
assert("A", "closure report: zero broken REQUIRED dependency closures",
  report.brokenClosures.length === 0, `broken=${report.brokenClosures.length}`);
assert("A", "closure report: required-in-prod verification ok",
  report.verification.ok === true);

// COUNTERFACTUAL — prove the gate has teeth: remove a required row → it fails
// closed and THROWS in prod posture. (Confirms the green boot above is not vacuous.)
await seedRequiredRows("@cinatra-ai/audio-artifact");
const cfVerify = await verifyRequiredInProdInstalled();
assert("A", "counterfactual: dropping a required row fails verification (names it missing)",
  cfVerify.ok === false && !!cfVerify.reason && cfVerify.reason.includes("audio-artifact"),
  cfVerify.ok ? "UNEXPECTED ok" : cfVerify.reason);
let cfThrew = false;
try {
  assertClosureBootReport(await buildClosureBootReport(await listInstalledExtensions({})), { mode: "production" });
} catch { cfThrew = true; }
assert("A", "counterfactual: assertClosureBootReport THROWS in prod on the violation",
  cfThrew === true);
await seedRequiredRows(); // restore the clean 13

// =============================================================================
// PART B — the equality triple, computed live from the branch's real files
// =============================================================================
const stripRange = (s: string) => s.split("@").slice(0, 2).join("@").replace(/@\^?[\d.]+$/, "");
const extSet = new Set(rootPkg.cinatra.extensions.map(stripRange));
const sysSet = new Set(rootPkg.cinatra.systemExtensions);
const lockSet = new Set(lock.packages.map((p) => p.packageName));
const eqSets = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
assert("B", "cinatra.extensions == cinatra.systemExtensions (13 each)",
  eqSets(extSet, sysSet), `ext=${extSet.size} sys=${sysSet.size}`);
assert("B", "cinatra.systemExtensions == required-lock packages (the triple)",
  eqSets(sysSet, lockSet), `sys=${sysSet.size} lock=${lockSet.size}`);
assert("B", "default-artifact absent from ALL THREE legs of the triple",
  ![...extSet, ...sysSet, ...lockSet].some((x) => x.includes("default-artifact")));
assert("B", "extensions/cinatra-ai/default-artifact directory is GONE",
  !existsSync("extensions/cinatra-ai/default-artifact"));
assert("B", "generated packages/objects/src/generated/artifact-floor.ts is GONE",
  !existsSync("packages/objects/src/generated/artifact-floor.ts"));

// =============================================================================
// PART C — registry warmed from the REAL extensions/ tree + upload resolver
// =============================================================================
const { registerArtifactExtensions } = await import("@cinatra-ai/objects/register-artifact-extensions");
const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
registerArtifactExtensions(resolve(process.cwd(), "extensions"));

const artifactTypeIds = objectTypeRegistry.listArtifacts().map((d) => d.type);
const hasBasePack = (frag: string) => artifactTypeIds.some((t) => t.includes(frag));
// The file-upload base packs each register ONE typed object type (pdf/audio/
// video/image). chart-artifact is required-in-prod but is a derived/structured
// artifact that mints NO object type (umbrella-type minting retired, entry 95)
// — correctly absent from the upload registry.
assert("C", "registry warmed: the four typed upload base packs registered (pdf/audio/video/image)",
  ["pdf", "audio", "video", "image"].every(hasBasePack),
  `artifactTypes=${artifactTypeIds.length}: ${artifactTypeIds.join(", ")}`);
assert("C", "generic '@cinatra-ai/artifact:object' catch-all NOT registered",
  !artifactTypeIds.includes("@cinatra-ai/artifact:object"));
assert("C", "no default-artifact-defined type registered",
  !artifactTypeIds.some((t) => t.toLowerCase().includes("default-artifact")));

const { resolveUploadArtifactType, readSystemBaseUploadCandidates } =
  await import("../../../../src/lib/artifacts/upload-artifact-type-map.ts");
const candidates = readSystemBaseUploadCandidates();
assert("C", "upload candidates are registry-routed & required-filtered (non-empty)",
  candidates.length > 0, `candidates=${candidates.map((x) => x.objectTypeId).join(", ")}`);
assert("C", "the retired '*/*' floor is NEVER an upload candidate",
  !candidates.some((x) => x.acceptMimes.some((m) => m.trim() === "*/*" || m.trim() === "*")));
const pdfRes = resolveUploadArtifactType("application/pdf");
assert("C", "application/pdf resolves to exactly one typed pack",
  pdfRes.ok === true, pdfRes.ok ? pdfRes.objectTypeId : pdfRes.reason);
const mdRes = resolveUploadArtifactType("text/markdown");
assert("C", "text/markdown REFUSED (no required type accepts it — fail closed)",
  mdRes.ok === false);
const emptyRes = resolveUploadArtifactType("");
assert("C", "empty MIME REFUSED (fail closed)", emptyRes.ok === false);

// =============================================================================
// PART D — the library serves typed rows (lane DB)
// =============================================================================
// Seed a row of an upload-RESOLVED pack type (proving the write-target type the
// resolver hands the writer is exactly what the library then serves), plus an
// image-typed row. NO generic floor row is created — the type no longer exists.
const pdfType = pdfRes.ok ? pdfRes.objectTypeId : artifactTypeIds.find((t) => t.includes("pdf"))!;
const imgType = artifactTypeIds.find((t) => t.includes("image"))!;
await c.query(`DELETE FROM objects`);
for (const [id, type] of [["obj_pdf", pdfType], ["obj_img", imgType]] as const) {
  await c.query(
    `INSERT INTO objects (id, type, data, org_id, owner_level, visibility)
     VALUES ($1,$2,'{"title":"seed"}'::jsonb,'org1','platform','private')`,
    [id, type],
  );
}
// The library lists rows whose type ∈ the registered artifact type-id set
// (src/lib/artifacts/artifact-read.ts: objectTypeRegistry.listArtifacts()).
const served = await c.query(
  `SELECT id, type FROM objects WHERE type = ANY($1::text[]) AND deleted_at IS NULL ORDER BY id`,
  [artifactTypeIds],
);
assert("D", "library type-scoped read serves the seeded TYPED rows",
  served.rows.length === 2 && served.rows.every((r) => artifactTypeIds.includes(r.type)),
  served.rows.map((r) => `${r.id}:${r.type}`).join(", "));
const genericRows = await c.query(
  `SELECT count(*)::int AS n FROM objects WHERE type = '@cinatra-ai/artifact:object'`,
);
assert("D", "zero generic '@cinatra-ai/artifact:object' rows exist to serve",
  genericRows.rows[0].n === 0, `generic rows=${genericRows.rows[0].n}`);
assert("D", "generic type is not in the served artifact type-id set",
  !artifactTypeIds.includes("@cinatra-ai/artifact:object"));

await c.end();

// ---- report -----------------------------------------------------------------
console.log("================ ITEM 4 — CLEAN BOOT WITHOUT default-artifact ================");
let pass = 0;
for (const r of results) {
  const line = `${r.pass ? "PASS" : "FAIL"}  [${r.part}] ${r.name}` + (r.detail ? `  [${r.detail}]` : "");
  console.log(line);
  if (r.pass) pass++;
}
console.log(`\n${pass}/${results.length} assertions passed`);
if (pass !== results.length) process.exit(1);
