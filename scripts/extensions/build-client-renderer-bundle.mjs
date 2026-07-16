#!/usr/bin/env node
// Publish-time CLIENT-bundle builder for a dynamically-loaded artifact renderer
// (epic #1620 M1 Slice A — cinatra#1630, plan §5.1.1). The browser-targeted
// sibling of `build-server-entry.mjs`: it turns a renderer's TS/TSX source entry
// into a self-contained ESM CLIENT bundle with React / ReactDOM / the JSX
// runtimes / the design-token module left EXTERNAL as HOST PEERS, inspects the
// esbuild metafile to (a) REJECT any bundled or transitive React copy and (b)
// enforce the externals ALLOWLIST (only the sanctioned host peers may be
// external), then binds the EXACT admitted tuple + the bundle integrity and
// SIGNS them together (Ed25519 — the browser-bundle-targeted extension of the
// `extension-signature.ts` payload idiom).
//
// SELF-CONTAINED (design contract, mirroring build-server-entry.mjs): the
// allowlist + the canonical signature payload are INLINED so this can run in a
// standalone extension-repo publish/conformance gate with no monorepo
// workspace; the parity test
// (`scripts/extensions/__tests__/build-client-renderer-bundle.test.mjs`) pins
// the inlined mirror against the SDK source of truth
// (`@cinatra-ai/sdk-extensions/artifact-client-bundle`). Only dependency:
// `esbuild` (resolved from this file's location, overridable via --esbuild-dir).
//
// POSTURE (plan §3.3, owner-ratified main-realm execution): this is an ADMISSION
// primitive — it binds "these exact bytes" to "this exact admitted tuple" and
// verifies the no-second-React / externals-only invariants. It is NOT an
// execution boundary; a dynamically-loaded renderer runs with page authority.

import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// INLINED MIRROR of @cinatra-ai/sdk-extensions/artifact-client-bundle
// (kept in lockstep by the parity test — never re-list, edit both together).
// ---------------------------------------------------------------------------

export const HOST_DESIGN_TOKEN_MODULE = "@cinatra-ai/design";

export const CLIENT_BUNDLE_EXTERNAL_ALLOWLIST = Object.freeze([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  HOST_DESIGN_TOKEN_MODULE,
]);

export const REACT_FAMILY_BASE_PACKAGES = Object.freeze(["react", "react-dom"]);

export const CLIENT_BUNDLE_SIGNATURE_SCHEME = "cinatra-artifact-client-bundle/v1";

export const STORE_DIGEST_RE = /^[0-9a-f]{128}$/;


export function basePackageOf(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split("/")[0] ?? null;
}

export function isAllowedClientBundleExternal(specifier) {
  return CLIENT_BUNDLE_EXTERNAL_ALLOWLIST.includes(specifier);
}

/** The metafile externals gate (mirror of the SDK's `checkClientBundleExternals`).
 * Returns null when the bundle conforms, else a fail-loud refusal reason. */
export function checkClientBundleExternals({ externals, inputBasePackages }) {
  const unsanctioned = externals.filter((s) => !isAllowedClientBundleExternal(s));
  if (unsanctioned.length > 0) {
    return (
      `un-sanctioned external import(s) ${unsanctioned.map((s) => `"${s}"`).join(", ")} — a client ` +
      `renderer bundle may leave external ONLY the host peers ` +
      `${CLIENT_BUNDLE_EXTERNAL_ALLOWLIST.map((s) => `"${s}"`).join(", ")}; bundle everything else`
    );
  }
  const bundledReact = inputBasePackages.filter((b) => REACT_FAMILY_BASE_PACKAGES.includes(b));
  if (bundledReact.length > 0) {
    return (
      `bundled/transitive React copy detected (${[...new Set(bundledReact)].join(", ")} in the ` +
      `bundle INPUT set) — React/ReactDOM must stay EXTERNAL host peers so the renderer shares the ` +
      `host's single in-realm instance; a second copy breaks hooks/context`
    );
  }
  return null;
}


/** The canonical signed payload (byte-identical mirror of the SDK builder). */
export function buildClientBundleSignaturePayload(f) {
  return [
    CLIENT_BUNDLE_SIGNATURE_SCHEME,
    f.packageName,
    f.slot,
    f.digest,
    f.entry,
    String(f.propsApiVersion),
    f.sdkAbiRange,
    f.reactPeerRange,
    f.reactDomPeerRange,
    f.tokenModuleAbi,
    f.integrity,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Metafile → externals + input-base-packages extraction.
// ---------------------------------------------------------------------------

/** Map an esbuild metafile input path (`node_modules/...`) to its package. */
export function packageNameFromInputPath(inputPath) {
  const norm = String(inputPath).replace(/\\/g, "/");
  const idx = norm.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const rest = norm.slice(idx + "node_modules/".length);
  const parts = rest.split("/");
  if (parts[0] === ".pnpm") return null;
  if (parts[0]?.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/** The set of EXTERNAL specifiers the output declared (metafile.outputs[*].imports
 * with external === true). */
export function externalImportsOf(metafile, outfileBasename) {
  const key = Object.keys(metafile.outputs).find((k) => k.endsWith(outfileBasename));
  const imports = key ? (metafile.outputs[key]?.imports ?? []) : [];
  return imports.filter((i) => i.external === true).map((i) => i.path);
}

/** The base packages of every INPUT (what got bundled). */
export function inputBasePackagesOf(metafile) {
  return [
    ...new Set(
      Object.keys(metafile.inputs)
        .map((p) => packageNameFromInputPath(p))
        .filter((n) => n !== null),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Digest / integrity / signing.
// ---------------------------------------------------------------------------

/** The 128-hex sha512 store digest of the bundle bytes. */
export function storeDigestOf(bytes) {
  return createHash("sha512").update(bytes).digest("hex");
}

/** The sha512 SRI integrity (`sha512-<base64>`) — the materialize root of trust. */
export function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Sign the canonical payload with a base64 PKCS8-DER Ed25519 key → base64 sig. */
export function signClientBundle(fields, privateKeyPkcs8DerB64) {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8DerB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const sig = cryptoSign(null, Buffer.from(buildClientBundleSignaturePayload(fields), "utf8"), key);
  return sig.toString("base64");
}

// ---------------------------------------------------------------------------
// Derive the admitted tuple from a package manifest + a resolved slot.
// ---------------------------------------------------------------------------

/**
 * Assemble the admitted tuple from the manifest (minus the digest, which is
 * computed from the built bytes). The React/ReactDOM peer ranges come from the
 * package's `peerDependencies`; the token ABI from the design peer (or an
 * explicit `cinatra.artifact.ui.tokenModuleAbi`); the sdk range + propsApiVersion
 * from the `cinatra.artifact.ui` block. Throws with the exact missing field.
 */
export function deriveTupleFields(pkg, slot) {
  const cin = pkg.cinatra ?? {};
  const ui = cin.artifact?.ui ?? {};
  const renderer = ui.renderers?.[slot];
  if (!renderer) throw new Error(`no cinatra.artifact.ui.renderers.${slot} in ${pkg.name}`);
  const peers = pkg.peerDependencies ?? {};
  const reactPeerRange = peers.react;
  const reactDomPeerRange = peers["react-dom"];
  if (!reactPeerRange) throw new Error(`${pkg.name}: declare "react" in peerDependencies (the host React peer range)`);
  if (!reactDomPeerRange) throw new Error(`${pkg.name}: declare "react-dom" in peerDependencies`);
  const tokenModuleAbi = ui.tokenModuleAbi ?? peers[HOST_DESIGN_TOKEN_MODULE];
  if (!tokenModuleAbi) {
    throw new Error(
      `${pkg.name}: pin the design-token ABI — declare "${HOST_DESIGN_TOKEN_MODULE}" in ` +
        `peerDependencies or set cinatra.artifact.ui.tokenModuleAbi`,
    );
  }
  if (!ui.sdkAbiRange) throw new Error(`${pkg.name}: cinatra.artifact.ui.sdkAbiRange is required`);
  if (typeof renderer.propsApiVersion !== "number") {
    throw new Error(`${pkg.name}: cinatra.artifact.ui.renderers.${slot}.propsApiVersion must be a number`);
  }
  return {
    packageName: pkg.name,
    slot,
    entry: renderer.entry,
    propsApiVersion: renderer.propsApiVersion,
    sdkAbiRange: ui.sdkAbiRange,
    reactPeerRange,
    reactDomPeerRange,
    tokenModuleAbi,
  };
}

async function loadEsbuild(esbuildDir) {
  const dir = esbuildDir ?? process.env.CINATRA_ESBUILD_DIR ?? null;
  if (dir) {
    const req = createRequire(pathToFileURL(path.join(path.resolve(dir), "noop.js")));
    return import(pathToFileURL(req.resolve("esbuild")).href);
  }
  return import("esbuild");
}

/**
 * Build ONE renderer slot's client bundle. Returns the built bytes + the metafile
 * verdict + the (digest-less) tuple fields + the integrity + digest. Throws
 * fail-loud on any externals-gate violation (bundled React / un-sanctioned
 * external). Does NOT sign — signing needs the publisher key and is a separate
 * step so the metafile gate is testable without a key.
 *
 * @param {{ packageDir: string, slot: "detail"|"preview", esbuildDir?: string|null }} opts
 */
export async function buildClientRendererBundle({ packageDir, slot, esbuildDir = null }) {
  const pkgDir = path.resolve(packageDir);
  const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const fields = deriveTupleFields(pkg, slot);
  const entryAbs = path.join(pkgDir, fields.entry.replace(/^\.?\//, ""));

  const esbuild = await loadEsbuild(esbuildDir);
  const result = await esbuild.build({
    entryPoints: [entryAbs],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    write: false,
    metafile: true,
    external: [...CLIENT_BUNDLE_EXTERNAL_ALLOWLIST],
    logLevel: "silent",
  });

  const outBasename = "bundle.js";
  const externals = externalImportsOf(result.metafile, path.basename(entryAbs).replace(/\.(tsx?|jsx?|mts|cts)$/, ".js"));
  // esbuild's output key varies; fall back to scanning all outputs' externals.
  const allExternals =
    externals.length > 0
      ? externals
      : Object.values(result.metafile.outputs)
          .flatMap((o) => o.imports ?? [])
          .filter((i) => i.external === true)
          .map((i) => i.path);
  const inputBasePackages = inputBasePackagesOf(result.metafile);

  const refusal = checkClientBundleExternals({ externals: allExternals, inputBasePackages });
  if (refusal !== null) {
    throw new Error(`[build-client-renderer-bundle] ${pkg.name} (${slot}): ${refusal}.`);
  }

  const bytes = result.outputFiles[0].contents;
  const digest = storeDigestOf(bytes);
  const integrity = integrityOf(bytes);
  // The tuple's `entry` is the EMITTED bundle name (what the digest-pinned URL
  // targets + what the host materializes into the store), NOT the source `.tsx`
  // `fields.entry` is the esbuild INPUT (a source path); signing +
  // serving must reference the OUTPUT. Single-file bundle (no splitting) so the
  // whole chunk graph is one content-addressed file — no unpinned chunks.
  return {
    packageName: pkg.name,
    slot,
    outBasename,
    bytes: Buffer.from(bytes),
    metafile: result.metafile,
    tuple: { ...fields, entry: outBasename, digest },
    integrity,
    externals: allExternals,
    inputBasePackages,
  };
}

// ---------------------------------------------------------------------------
// CLI: build + sign a slot; emit the bundle + a sidecar manifest.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { packageDir: null, slot: "detail", out: null, esbuildDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--slot") args.slot = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--esbuild-dir") args.esbuildDir = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--")) throw new Error(`[build-client-renderer-bundle] unknown flag ${a}`);
    else if (!args.packageDir) args.packageDir = a;
    else throw new Error(`[build-client-renderer-bundle] unexpected positional ${a}`);
  }
  if (!args.packageDir) {
    throw new Error(
      "usage: node build-client-renderer-bundle.mjs <packageDir> [--slot detail|preview] " +
        "[--out <dir>] [--esbuild-dir <dir>] [--json]   (signs with CINATRA_CLIENT_BUNDLE_SIGNING_KEY when set)",
    );
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const built = await buildClientRendererBundle({
      packageDir: args.packageDir,
      slot: args.slot,
      esbuildDir: args.esbuildDir,
    });
    const signingKey = process.env.CINATRA_CLIENT_BUNDLE_SIGNING_KEY;
    let signature = null;
    if (signingKey) {
      signature = signClientBundle({ ...built.tuple, integrity: built.integrity }, signingKey);
    }
    if (args.out) {
      const outDir = path.resolve(args.out);
      await writeFile(path.join(outDir, built.outBasename), built.bytes);
      await writeFile(
        path.join(outDir, "client-bundle.manifest.json"),
        `${JSON.stringify({ tuple: built.tuple, integrity: built.integrity, signature, scheme: CLIENT_BUNDLE_SIGNATURE_SCHEME }, null, 2)}\n`,
      );
    }
    const summary = { packageName: built.packageName, slot: built.slot, digest: built.tuple.digest, integrity: built.integrity, signed: signature !== null };
    process.stdout.write(args.json ? `${JSON.stringify(summary, null, 2)}\n` : `[build-client-renderer-bundle] ${built.packageName} (${built.slot}): digest=${built.tuple.digest.slice(0, 16)}… signed=${signature !== null}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
