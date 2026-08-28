// THE REGISTRY PUBLISH — the step batch 1 (PR #3043) did not take, and the one
// its run died on.
//
// The run package's ARTIFACT BINDINGS are read from the instance's own package
// registry at materialization time (`loadRunPackageBindings` in
// `src/lib/artifacts/run-artifact-materializer.ts`), so a run whose package the
// registry has never seen fails with
//   "failed to load the run package's artifact bindings: 404 Not Found … no such
//    package available"
// which is exactly what batch 1 measured. This driver publishes the branch's own
// packages into the bundled dev registry BEFORE any run starts and PROVES the
// publish with a readback of each packument: the version, the manifest's kind
// and produces block, and the tarball's own shasum as the registry reports it.
//
// LANE PROVISIONING, DISCLOSED. This is a write to the lane's throwaway
// registry, not to the app: no run, gate, park, record or review task is
// inserted and no status is written. Every value comes from the environment.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const REGISTRY = process.env.LANE_REGISTRY;
const NPMRC = process.env.LANE_NPMRC;
const EXT_ROOT = process.env.LANE_EXTENSIONS_ROOT ?? "extensions/cinatra-ai";
const WORK = process.env.LANE_PACK_DIR;
const OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ LANE_REGISTRY: REGISTRY, LANE_NPMRC: NPMRC, LANE_PACK_DIR: WORK, OUT_JSON: OUT }))
  if (!v) throw new Error(`the publish driver needs ${n}`);

// The run package, the agent it depends on, and the artifact it produces.
const PACKAGES = (process.env.LANE_PUBLISH_PACKAGES ?? "blog-draft-writer-agent,context-selection-agent,blog-post-artifact")
  .split(",").map((s) => s.trim()).filter(Boolean);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const npm = (args) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const packed = [];
for (const p of PACKAGES) {
  const out = npm(["pack", join(EXT_ROOT, p), "--pack-destination", WORK, "--userconfig", NPMRC]).trim();
  const file = out.split("\n").filter(Boolean).pop();
  packed.push({ dir: join(EXT_ROOT, p), tarball: file });
  console.log(`packed ${p} -> ${file}`);
}

const published = [];
for (const { tarball } of packed) {
  const out = npm(["publish", join(WORK, tarball), "--userconfig", NPMRC, "--registry", REGISTRY]);
  const line = out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("+ ")).pop() ?? "";
  published.push(line.replace(/^\+\s*/, ""));
  console.log(`published ${line.trim()}`);
}

// THE READBACK — the registry's own answer, not this process's memory.
const readback = [];
for (const p of PACKAGES) {
  const name = `@cinatra-ai/${p}`;
  const url = `${REGISTRY.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
  const res = await fetch(url);
  const body = res.ok ? await res.json() : null;
  const latest = body?.["dist-tags"]?.latest ?? null;
  const manifest = latest ? body.versions[latest] : null;
  readback.push({
    packageName: name,
    httpStatus: res.status,
    latest,
    versions: body ? Object.keys(body.versions) : [],
    cinatraKind: manifest?.cinatra?.kind ?? null,
    produces: manifest?.cinatra?.produces ?? null,
    shasum: manifest?.dist?.shasum ?? null,
  });
  console.log(`readback ${name} HTTP ${res.status} latest=${latest}`);
}
const allOk = readback.every((r) => r.httpStatus === 200 && r.latest !== null);
console.log(allOk ? "PASS every run package answers from the instance's own registry" : "FAIL a package did not read back");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ registry: REGISTRY, published, readback, at: new Date().toISOString() }, null, 2) + "\n");
process.exitCode = allOk ? 0 : 1;
