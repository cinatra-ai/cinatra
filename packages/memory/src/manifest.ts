/**
 * Content-hash manifest: the deterministic per-bundle inventory the sync
 * layer builds its ledger on. Hashes are computed over the raw file bytes of
 * every conformant concept file; keys are sorted so the serialized form is
 * byte-stable for identical bundle content.
 */
import { createHash } from "node:crypto";

import { loadMemoryBundleConfig, walkMemoryTree } from "./bundle.ts";
import type { MemoryManifest } from "./types.ts";

/**
 * Build the content-hash manifest for the bundle at `root`. Hashes are
 * computed over the EXACT bytes each concept was validated from (captured by
 * the walk), so a file changing between validation and hashing can never put
 * unvalidated content into the ledger.
 */
export function buildMemoryManifest(root: string): MemoryManifest {
  const config = loadMemoryBundleConfig(root);
  const tree = walkMemoryTree(root, { caps: config.caps, captureSources: true });
  const concepts: MemoryManifest["concepts"] = {};
  for (const concept of tree.concepts) {
    const bytes = tree.sources?.get(concept.path);
    if (bytes === undefined) continue;
    concepts[concept.path] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    };
  }
  return { manifestFormat: 1, bundleId: config.bundleId, concepts };
}

/** Serialize a manifest to canonical JSON (sorted concept keys, trailing newline). */
export function serializeMemoryManifest(manifest: MemoryManifest): string {
  const sorted: MemoryManifest["concepts"] = {};
  for (const key of Object.keys(manifest.concepts).sort()) {
    const entry = manifest.concepts[key];
    if (entry) sorted[key] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  return `${JSON.stringify(
    {
      manifestFormat: manifest.manifestFormat,
      bundleId: manifest.bundleId,
      concepts: sorted,
    },
    null,
    2,
  )}\n`;
}
