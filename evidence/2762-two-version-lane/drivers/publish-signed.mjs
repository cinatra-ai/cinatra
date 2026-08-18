// Publish a SIGNED newer version of a bundled connector to a lane-private
// Verdaccio, exactly as the marketplace would: the Ed25519 signature travels in
// the packument's per-version `dist.cinatraSignature`, binding packageName +
// resolved version + the sha512 integrity of the tarball.
//
// No production credentials are involved. The registry is the repo's own
// Verdaccio image on a lane-private port, and the signing key is generated here
// and configured as trusted for the app under test.
//
// Usage:
//   node publish-signed.mjs <pkgDir> <version> <registryUrl> <privateKeyB64>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const [pkgDir, version, registryUrl, privateKeyB64] = process.argv.slice(2);
if (!pkgDir || !version || !registryUrl || !privateKeyB64) {
  console.error("usage: publish-signed.mjs <pkgDir> <version> <registryUrl> <privateKeyB64>");
  process.exit(2);
}

// The canonical v1 payload the host verifies, byte for byte: UTF-8, LF
// separated, no trailing newline, four lines (extension-signature.ts).
const SIGNATURE_SCHEME = "cinatra-extension-signature/v1";
const buildPayload = (packageName, v, integrity) =>
  `${SIGNATURE_SCHEME}\n${packageName}\n${v}\n${integrity}`;

/** Walk up from `startDir` and return the first `node_modules/<name>` that
 *  exists, or null. Mirrors Node's own lookup order without going through the
 *  exports map, which many packages close to `package.json`. */
function findPackageDir(startDir, name) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// 1. Stage the package at the NEW version.
const stage = mkdtempSync(path.join(tmpdir(), "signed-pub-"));
cpSync(pkgDir, stage, { recursive: true });
const manifestPath = path.join(stage, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageName = manifest.name;
manifest.version = version;

// 1a. MAKE THE PUBLISHED VERSION VISIBLY ITSELF.
//
// A real newer version of a connector differs from the one baked into the
// image; that is the whole reason anyone installs it. The version this lane
// publishes is otherwise byte-identical to the bundled one, and an identical
// manifest renders an identical setup surface — so a screenshot of that surface
// could not say WHICH version produced it. That is precisely the weakness that
// made four "different" setup captures come out byte-identical.
//
// Setting LANE_MANIFEST_MARK stamps the connector's own declared
// `calendarId` placeholder with the version being published. It changes one
// declared string in the manifest and nothing else: no code path, no signing
// input handling, no install logic. The signature is taken over the tarball
// that results, exactly as before. The point is that the setup surface then
// NAMES the version whose manifest reached the render, so "the bundled version
// is still serving" and "the marketplace version is serving" become two
// visibly different screens instead of one blob.
if (process.env.LANE_MANIFEST_MARK === "true") {
  const fields = manifest?.cinatra?.configSchema?.fields;
  const field = Array.isArray(fields)
    ? fields.find((f) => f && f.key === "calendarId")
    : undefined;
  if (!field || typeof field.placeholder !== "string") {
    console.error(
      "LANE_MANIFEST_MARK set, but the cinatra.configSchema field with key " +
        "'calendarId' carries no string placeholder — refusing to publish an " +
        "unmarked package silently",
    );
    process.exit(1);
  }
  field.placeholder = `[lane registry build ${version}] ${field.placeholder}`;
  console.error(`marked the declared calendarId placeholder with build ${version}`);
}

// 1b. BUNDLE THE RUNTIME DEPENDENCIES.
//
// The installer never runs npm/pnpm install — that is a deliberate security
// rule. A published extension must therefore ship every runtime dependency
// either inside its tarball or under a signed materialization plan, and the
// package store refuses the install otherwise
// (`validateBundledDependencies`, src/lib/extension-package-store.ts).
//
// This lane takes the bundled route, which is the simpler of the two and needs
// no second signature protocol: each declared runtime dependency is copied into
// the staged `node_modules` and named in `bundleDependencies`, which is the one
// mechanism that makes `npm pack` carry `node_modules/<dep>` into the tarball.
// Host-internal SDK packages are NEVER bundled — they are peers, and a second
// copy would break ABI identity — but those are declared in `peerDependencies`,
// which this loop does not touch.
// Start from an EMPTY staged `node_modules`. The working copy's own
// `node_modules` is a workspace install full of symlinks into the monorepo;
// copying those into a published tarball would ship links that resolve to
// nothing on the installing host, and a dereferencing copy over an existing
// link resolves to the very directory it is copying from. Only the
// dependencies bundled below belong in the tarball.
rmSync(path.join(stage, "node_modules"), { recursive: true, force: true });

const runtimeDeps = Object.keys(manifest.dependencies ?? {});
const bundled = [];
for (const dep of runtimeDeps) {
  // Locate the dependency the way Node's resolver walks: up the directory
  // chain from the package, checking each `node_modules`. This is a directory
  // lookup on purpose rather than `require.resolve` — many packages do not
  // expose `package.json` in their `exports`, so resolving a subpath would fail
  // on packages that are perfectly present on disk. A workspace install hoists
  // shared dependencies to the repo root, which this walk reaches naturally.
  const depDir = findPackageDir(path.resolve(pkgDir), dep);
  if (!depDir) {
    console.error(`cannot find runtime dependency ${dep} in any node_modules above ${pkgDir}`);
    process.exit(1);
  }
  const dest = path.join(stage, "node_modules", dep);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(depDir, dest, { recursive: true, dereference: true });
  bundled.push(dep);
}
if (bundled.length > 0) manifest.bundleDependencies = bundled;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
if (bundled.length > 0) console.error(`bundled runtime dependencies: ${bundled.join(", ")}`);

// 1c. BUILD THE PACKAGE. The in-tree form points its export map at TypeScript
// source, which the runtime store refuses outright ("the runtime store accepts
// BUILT artifacts only"). A real publisher ships built ESM, so the lane does
// too. This rewrites the staged manifest, so it must run BEFORE the manifest is
// read back into the packument below.
execFileSync(process.execPath, [
  path.join(import.meta.dirname, "build-publishable.mjs"),
  stage,
], { stdio: "inherit" });
Object.assign(manifest, JSON.parse(readFileSync(manifestPath, "utf8")));

// 2. Pack it and take the sha512 SRI of the exact bytes.
execFileSync("npm", ["pack", "--quiet"], { cwd: stage, stdio: "inherit" });
const tgz = readdirSync(stage).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error("npm pack produced no tarball");
const tarball = readFileSync(path.join(stage, tgz));
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

// 3. Sign the canonical payload.
const key = createPrivateKey({
  key: Buffer.from(privateKeyB64, "base64"),
  format: "der",
  type: "pkcs8",
});
const signature = cryptoSign(null, Buffer.from(buildPayload(packageName, version, integrity), "utf8"), key)
  .toString("base64");

// 4. PUT the packument with the signature in `dist.cinatraSignature`. This is
//    the shape the registry client reads, so the app under test sees a signed
//    package through its ordinary resolution path.
// Encode EVERY separator, not just the first: a single-occurrence replace
// would silently mis-address any name with more than one slash.
const encodedName = packageName.replaceAll("/", "%2f");
const body = {
  _id: packageName,
  name: packageName,
  "dist-tags": { latest: version },
  versions: {
    [version]: {
      ...manifest,
      _id: `${packageName}@${version}`,
      dist: {
        tarball: `${registryUrl}/${packageName}/-/${tgz}`,
        integrity,
        shasum: createHash("sha1").update(tarball).digest("hex"),
        cinatraSignature: signature,
      },
    },
  },
  _attachments: {
    [tgz]: {
      content_type: "application/octet-stream",
      data: tarball.toString("base64"),
      length: tarball.length,
    },
  },
};

const res = await fetch(`${registryUrl}/${encodedName}`, {
  method: "PUT",
  headers: { "content-type": "application/json", authorization: "Bearer lane" },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`publish failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(JSON.stringify({ packageName, version, integrity, signature }, null, 2));
