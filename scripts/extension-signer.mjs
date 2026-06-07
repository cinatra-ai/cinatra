#!/usr/bin/env node
// Cinatra extension signer — the OWNER's signing tool.
//
// Ed25519. Zero runtime dependencies (node builtins only). Produces signatures
// byte-compatible with the host verifier `src/lib/extension-signature.ts`
// (`signature-format-parity.test.ts` cross-checks the two).
//
// SECURITY: the PRIVATE key is a SECRET. This tool NEVER prints it to stdout and
// NEVER takes it on argv (which leaks via `ps`). `keygen` writes it to a 0600
// file; `sign` reads it from `--key-file` or `$CINATRA_EXTENSION_SIGNING_PRIVATE_KEY`.
// Store the private key in Infisical; publish only the PUBLIC key to the host.
//
// Usage:
//   node scripts/extension-signer.mjs keygen --out-dir <dir>
//   node scripts/extension-signer.mjs sign --package <name> --version <ver> \
//        (--tarball <pkg.tgz> | --integrity <sha512-...>) \
//        (--key-file <priv.b64> | env CINATRA_EXTENSION_SIGNING_PRIVATE_KEY)

import { generateKeyPairSync, createPrivateKey, sign as edSign, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";

const SIGNATURE_SCHEME = "cinatra-extension-signature/v1";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function die(msg) {
  console.error(`extension-signer: ${msg}`);
  process.exit(1);
}
function publicKeyId(derB64) {
  return createHash("sha256").update(Buffer.from(derB64, "base64")).digest("hex").slice(0, 16);
}
function sha512Sri(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
function buildPayload({ packageName, version, integrity }) {
  return `${SIGNATURE_SCHEME}\n${packageName}\n${version}\n${integrity}`;
}

function keygen() {
  const outDir = arg("out-dir") ?? ".";
  mkdirSync(outDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const keyId = publicKeyId(pubB64);
  const privPath = path.join(outDir, "extension-signing.key");
  const pubPath = path.join(outDir, "extension-signing.pub");
  // Write the private key with EXCLUSIVE create at 0600. `writeFileSync({mode})`
  // only applies the mode when CREATING a new file — an existing broader-perm
  // file would keep its perms, exposing the secret. Remove any stale file first,
  // then create fresh with `wx` (fails if it reappears) so the key is never
  // written into a pre-existing readable file.
  try {
    unlinkSync(privPath);
  } catch {
    /* ENOENT — nothing to remove */
  }
  const fd = openSync(privPath, "wx", 0o600);
  try {
    writeSync(fd, privB64 + "\n");
  } finally {
    closeSync(fd);
  }
  writeFileSync(pubPath, pubB64 + "\n"); // public key — not secret
  // Public key + keyId are safe to print; the private key is NOT printed.
  console.log(JSON.stringify({ keyId, publicKeyDerB64: pubB64, privateKeyFile: privPath, publicKeyFile: pubPath }, null, 2));
  console.error(
    `\n⚠ The private key was written to ${privPath} (mode 0600).\n` +
      `  → store its contents in Infisical (e.g. CINATRA_EXTENSION_SIGNING_PRIVATE_KEY), then DELETE the file.\n` +
      `  → configure the HOST with the PUBLIC key: CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS=${pubB64}\n` +
      `  Never commit the private key, paste it into chat/PRs, or pass it on argv.`,
  );
}

function loadPrivateKeyB64() {
  const fromEnv = process.env.CINATRA_EXTENSION_SIGNING_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv;
  const keyFile = arg("key-file");
  if (!keyFile) die("provide --key-file <path> or set CINATRA_EXTENSION_SIGNING_PRIVATE_KEY (never pass the key on argv)");
  return readFileSync(keyFile, "utf8").trim();
}

function sign() {
  const packageName = arg("package") ?? die("--package required");
  const version = arg("version") ?? die("--version required");
  let integrity = arg("integrity");
  const tarball = arg("tarball");
  if (!integrity) {
    if (!tarball) die("provide --integrity <sha512-...> or --tarball <pkg.tgz>");
    integrity = sha512Sri(readFileSync(tarball));
  }
  const privB64 = loadPrivateKeyB64();
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(privB64, "base64"), format: "der", type: "pkcs8" });
  } catch (e) {
    die(`invalid private key: ${e?.message ?? e}`);
  }
  const signature = edSign(null, Buffer.from(buildPayload({ packageName, version, integrity }), "utf8"), key).toString("base64");
  // Output is non-secret: the signature + the public-binding fields.
  console.log(JSON.stringify({ packageName, version, integrity, signature }, null, 2));
}

const cmd = process.argv[2];
if (cmd === "keygen") keygen();
else if (cmd === "sign") sign();
else die(`unknown command "${cmd ?? ""}" — use "keygen" or "sign"`);
