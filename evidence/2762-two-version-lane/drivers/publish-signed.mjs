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
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync } from "node:fs";
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

// 1. Stage the package at the NEW version.
const stage = mkdtempSync(path.join(tmpdir(), "signed-pub-"));
cpSync(pkgDir, stage, { recursive: true });
const manifestPath = path.join(stage, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageName = manifest.name;
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

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
