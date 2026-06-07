// `cinatra extensions submit <tarball.tgz>` — submit a built extension
// tarball to the Cinatra Marketplace for review.
//
// Flow:
//   1. Read the tarball bytes from disk.
//   2. Extract `package.json` via pacote to derive `name` + `version`.
//      `name` MUST be of the form `@<namespace>/<extension-stem>`.
//   3. Compute sha256(bytes) + size; base64-encode.
//   4. Call `cinatra/extension-submit-for-review` over MCP. The marketplace
//      verifies digest + size, stages the tarball into the hidden scope,
//      and records a `pending` submission.
//
// Vendor surface intentionally minimal: no flags for `--namespace` etc. The
// tarball's own `package.json` is the source of truth — that matches the
// invariant we want to enforce at promotion time (reviewed bytes == installed
// bytes from the same package.json).

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";

import pacote from "pacote";

import { callMarketplaceTool } from "./marketplace-mcp.mjs";
import {
  assertDependencyOrdering,
  DEFAULT_REGISTRY_URL,
} from "./extensions-dependency-gate.mjs";

/**
 * @param {string[]} args  the args AFTER `cinatra extensions submit`
 */
export async function runExtensionsSubmit(args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const tarballPathArg = positional[0];
  if (!tarballPathArg) {
    throw new Error(
      "Usage: cinatra extensions submit <tarball.tgz> [--description \"<short text>\"] [--skip-dependency-check]",
    );
  }
  const tarballPath = resolvePath(process.cwd(), tarballPathArg);

  const descriptionFlagIndex = args.indexOf("--description");
  const description =
    descriptionFlagIndex >= 0 && descriptionFlagIndex + 1 < args.length
      ? args[descriptionFlagIndex + 1]
      : undefined;

  // Read tarball bytes from disk (the marketplace caps at 50 MiB — let the
  // server reject oversize rather than duplicating the constant here).
  let tarballBytes;
  try {
    tarballBytes = await readFile(tarballPath);
  } catch (err) {
    throw new Error(`Could not read tarball at ${tarballPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // pacote.manifest('file:<path>') reads the package.json out of the .tgz
  // without unpacking the whole tarball. The vendor doesn't need to pass the
  // name/version flags — the tarball is the source of truth.
  let manifest;
  try {
    manifest = await pacote.manifest(`file:${tarballPath}`);
  } catch (err) {
    throw new Error(`Could not parse the tarball's package.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@")) {
    throw new Error(
      `Tarball package name "${manifest.name}" is not scoped — extensions submitted to the marketplace MUST be scoped (@namespace/name).`,
    );
  }
  const [namespace, extensionName] = (() => {
    const idx = manifest.name.indexOf("/");
    if (idx < 0) {
      throw new Error(`Tarball package name "${manifest.name}" is missing the /<extension> suffix.`);
    }
    return [manifest.name.slice(0, idx), manifest.name.slice(idx + 1)];
  })();
  const version = String(manifest.version ?? "");
  if (!version) {
    throw new Error("Tarball package.json is missing a `version` field.");
  }

  // Dependency-ordering preflight: every @cinatra-ai/* EXTENSION EDGE this package
  // declares in its canonical `cinatra.dependencies` MUST already be published on
  // the registry (these extension packages live ONLY there). Host-internal SDK/app
  // peers (sdk-extensions, sdk-ui, mcp-client, …) are NOT edges — they are
  // host-provided under model-B and intentionally never on the registry, so the
  // gate skips them. Fail BEFORE submit if a real edge is missing — submitting
  // would produce a public repo that can't install a sibling extension it needs.
  // The marketplace re-validates at approval; this is the fast local preflight. A
  // zero-dep / host-internal-only package passes trivially (no probes).
  const skipDependencyCheck = args.includes("--skip-dependency-check");
  if (skipDependencyCheck) {
    process.stderr.write(
      "⚠ --skip-dependency-check: bypassing the @cinatra-ai/* dependency-ordering gate. " +
        "Only safe if you have independently confirmed the closure is published.\n",
    );
  } else {
    const registryUrl = (process.env.CINATRA_REGISTRY_URL || DEFAULT_REGISTRY_URL).trim();
    // A read-scope registry token (distinct from the marketplace submit token);
    // not required once the registry's public-read flip is live.
    const registryToken = process.env.CINATRA_REGISTRY_TOKEN;
    const report = await assertDependencyOrdering({ manifest, registryUrl, token: registryToken });
    if (report.deps.length > 0) {
      process.stderr.write(
        `Dependency-ordering gate OK — ${report.satisfied.length}/${report.deps.length} @cinatra-ai/* dependency(ies) present on ${registryUrl}.\n`,
      );
    }
  }

  // Digest the raw bytes (the marketplace recomputes + verifies).
  const artifactDigestSha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const artifactSizeBytes = tarballBytes.byteLength;
  const tarballBase64 = tarballBytes.toString("base64");

  process.stderr.write(
    `Submitting ${manifest.name}@${version} (${artifactSizeBytes.toLocaleString()} bytes) to the Cinatra Marketplace…\n`,
  );

  const result = await callMarketplaceTool("extension_submit_for_review", {
    namespace,
    extension_name: extensionName,
    version,
    artifact_digest_sha256: artifactDigestSha256,
    artifact_size_bytes: artifactSizeBytes,
    tarball_base64: tarballBase64,
    ...(description ? { description } : {}),
  });

  process.stdout.write(
    `submission_id: ${result.submission_id}\n` +
      `target:        ${result.target_final_identity}\n` +
      `status:        ${result.status}\n` +
      (result.idempotent_replay ? "(idempotent replay — same digest was already pending)\n" : ""),
  );
}
