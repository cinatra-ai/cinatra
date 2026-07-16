import "server-only";

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveExtensionDataRoot } from "@/lib/extension-data-root";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import {
  decideRendererAssetServe,
  parseRendererAssetPath,
  rendererAssetHeaders,
} from "@/lib/artifacts/renderer-asset-serving";

// The digest-pinned IMMUTABLE serving route for dynamically-loaded artifact
// renderer client bundles (epic #1620 M1 Slice A — cinatra#1630, plan §5.1.2).
// A THIN shell around the pure admission core
// (`src/lib/artifacts/renderer-asset-serving.ts`, fully unit-tested): it parses
// + validates the request path there, resolves the CURRENTLY-ACTIVE admitted
// digest from the runtime asset registry, and only then reads the
// content-addressed bytes and streams them with immutable JS headers.
//
// SAFETY (AC-8): the pure core refuses any traversal in the request path; this
// shell additionally resolves the store dir from the VALIDATED (kind, slug,
// digest, entry) — never raw request text — and realpath-contains the final
// file inside the digest dir, so even a resolution bug fails CLOSED (404)
// rather than serving anything outside the activated bundle's content-addressed
// directory. Only the ACTIVE admitted digest is served (a superseded / archived
// / never-admitted digest 404s).
//
// The live end-to-end serving proof rides the json-artifact slice (Slice B): a
// real marketplace install materializes the bundle into the store and activates
// it in the registry; this route then serves it. Its admission + safety + header
// logic is the security-critical part and is proven here by unit tests.

const ARTIFACT_KIND = "artifact";

type Params = { params: Promise<{ path: string[] }> };

/** The content-addressed digest dir for a (packageName, digest): the store
 * layout is `<root>/<kind>/<vendor>/<name>/<digest>/` for a scoped package and
 * `<root>/<kind>/<name>/<digest>/` otherwise — the slug is the package name with
 * its leading `@` stripped, split on `/`. Built ONLY from validated segments. */
function digestDirFor(dataRoot: string, packageName: string, digest: string): string {
  const slugParts = (packageName.startsWith("@") ? packageName.slice(1) : packageName).split("/");
  return path.join(dataRoot, ARTIFACT_KIND, ...slugParts, digest);
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { path: segments } = await params;
  const parse = parseRendererAssetPath(segments ?? []);

  // Resolve the active admitted digest for this (package, slot) from the runtime
  // registry (per-process cache; the DB-authoritative reconstruct hook is wired
  // by the host activation path). A non-runtime key resolves to null → 404.
  let activeDigest: string | null = null;
  if (parse.ok) {
    const key = runtimeAssetRegistry.keyFor(parse.parsed.packageName, parse.parsed.slot);
    activeDigest = runtimeAssetRegistry.resolveActive(key)?.digest ?? null;
  }

  const decision = decideRendererAssetServe({ parse, activeDigest });
  if (!decision.serve) {
    return new Response(null, { status: decision.status });
  }

  // The decision's storeRelPath is `<digest>/<entry>` (validated, traversal-safe).
  // Compose the absolute file from the VALIDATED package + digest, then
  // realpath-contain it inside the digest dir (fail-closed belt).
  const parsed = (parse as { ok: true; parsed: { packageName: string; digest: string; entry: string } }).parsed;
  const dataRoot = resolveExtensionDataRoot();
  const digestDir = digestDirFor(dataRoot, parsed.packageName, parsed.digest);
  const fileAbs = path.join(digestDir, parsed.entry);

  try {
    // Containment: the resolved real path must live inside the digest dir.
    const [realDir, realFile] = await Promise.all([realpath(digestDir), realpath(fileAbs)]);
    if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
      return new Response(null, { status: 404 });
    }
    const bytes = await readFile(realFile);
    return new Response(new Uint8Array(bytes), { status: 200, headers: rendererAssetHeaders() });
  } catch {
    // Missing/unreadable/materializing bytes for an admitted digest → 404 (the
    // client loader floors as materializing; no filesystem oracle is exposed).
    return new Response(null, { status: 404 });
  }
}
