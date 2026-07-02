// V2 store IO primitives (cinatra#790/#791): discovery over the kind-segregated
// content-addressed layout + the `current` active-digest mirror file.
//
// Layout (see extension-package-store-core.ts):
//   <root>/<kind>/<slug>/<digest>/           payload
//   <root>/<kind>/<slug>/<digest>.tgz        verified tarball
//   <root>/<kind>/<slug>/current             plain-text active digest (mirror ONLY)
//
// Discovery walks ONLY the known kind dirs (everything else under the root —
// `.staging`, legacy dirs, foreign files — is invisible), reuses the sdk's
// `recordFromManifest` for record construction, and REFUSES (skips, loudly) any
// record whose path-derived identity disagrees with its manifest: a manifest
// `cinatra.kind` that contradicts the kind dir, or a `name` whose slug is not
// the path slug. `current` is written atomically (tmp + rename) and is a
// MIRROR/ops+GC hint only — never a boot selector or trust input (the DB anchor
// owns selection).

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  recordFromManifest,
  type PackageStoreFs,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import {
  EXTENSION_STORE_KINDS,
  STORE_CURRENT_FILENAME,
  currentFilePathV2,
  isExtensionStoreKind,
  isStoreDigestSegment,
  parseCurrentFileText,
  storeSlugDirV2,
  storeSlugSegments,
  type ExtensionStoreKind,
} from "@/lib/extension-package-store-core";

/** A discovered V2 store record: the sdk record + the path-derived kind. */
export type PackageStoreRecordV2 = PackageStoreRecord & { kind: ExtensionStoreKind };

/** node:fs/promises-backed `PackageStoreFs` (shared by the V2 discovery callers). */
export const realStoreFs: PackageStoreFs = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
};

function joinPosix(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

/** The declared `cinatra.kind` of a manifest text, when present (invalid → undefined). */
function manifestDeclaredKind(pkgJsonText: string): string | undefined {
  try {
    const pkg = JSON.parse(pkgJsonText) as Record<string, unknown>;
    const cinatra = (pkg.cinatra ?? null) as Record<string, unknown> | null;
    return cinatra && typeof cinatra.kind === "string" ? cinatra.kind : undefined;
  } catch {
    return undefined;
  }
}

async function collectSlugDirRecords(
  slugDir: string,
  slugSegments: readonly string[],
  kind: ExtensionStoreKind,
  fs: PackageStoreFs,
  out: PackageStoreRecordV2[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(slugDir);
  } catch {
    return; // unreadable slug dir → skip, never fatal
  }
  for (const entry of entries) {
    if (entry === STORE_CURRENT_FILENAME || entry.startsWith(".") || entry.endsWith(".tgz")) continue;
    if (!isStoreDigestSegment(entry)) continue; // foreign entry — not a digest dir
    const digestDir = joinPosix(slugDir, entry);
    if (!(await fs.isDirectory(digestDir))) continue;
    const manifestPath = joinPosix(digestDir, "package.json");
    if (!(await fs.exists(manifestPath))) continue;
    let manifestText: string;
    try {
      manifestText = await fs.readFile(manifestPath);
    } catch {
      continue; // unreadable manifest → skip this digest dir
    }
    const rec = recordFromManifest(digestDir, manifestText, entry);
    if (!rec) continue; // not a Cinatra extension manifest

    // Path/manifest identity binding — REFUSE (skip loudly) on disagreement:
    // the path is what discovery trusts for placement; the manifest is what the
    // loader trusts for identity. They must agree or the record is suspect. A
    // PRESENT-but-unknown manifest kind is refused too (fail closed — the
    // materializer would never have written it; codex diff-review finding 2).
    const declaredKind = manifestDeclaredKind(manifestText);
    if (declaredKind !== undefined && !isExtensionStoreKind(declaredKind)) {
      console.warn(
        `[extension-store] refusing ${rec.packageName} at ${digestDir}: manifest cinatra.kind ` +
          `${JSON.stringify(declaredKind)} is not a known extension kind`,
      );
      continue;
    }
    if (declaredKind !== undefined && declaredKind !== kind) {
      console.warn(
        `[extension-store] refusing ${rec.packageName} at ${digestDir}: manifest cinatra.kind ` +
          `"${declaredKind}" contradicts the store path kind "${kind}"`,
      );
      continue;
    }
    let expectedSlug: string[];
    try {
      expectedSlug = storeSlugSegments(rec.packageName);
    } catch {
      console.warn(
        `[extension-store] refusing store record at ${digestDir}: manifest name ` +
          `${JSON.stringify(rec.packageName)} is not a valid store package name`,
      );
      continue;
    }
    if (expectedSlug.join("/") !== slugSegments.join("/")) {
      console.warn(
        `[extension-store] refusing ${rec.packageName} at ${digestDir}: manifest name slug ` +
          `"${expectedSlug.join("/")}" contradicts the store path slug "${slugSegments.join("/")}"`,
      );
      continue;
    }
    out.push({ ...rec, kind });
  }
}

/**
 * Discover every materialized package under the V2 data root, across all known
 * kind dirs. A missing root / missing kind dir yields no records (a deployment
 * with no data volume is a clean no-op, never an error); unreadable/foreign
 * entries are skipped, not fatal.
 */
export async function discoverStoreRecordsV2(
  dataRoot: string,
  fs: PackageStoreFs = realStoreFs,
): Promise<PackageStoreRecordV2[]> {
  const out: PackageStoreRecordV2[] = [];
  if (!(await fs.exists(dataRoot))) return out;
  for (const kind of EXTENSION_STORE_KINDS) {
    const kindDir = joinPosix(dataRoot, kind);
    if (!(await fs.isDirectory(kindDir))) continue;
    let level1: string[];
    try {
      level1 = await fs.readdir(kindDir);
    } catch {
      continue;
    }
    for (const e1 of level1) {
      if (e1.startsWith(".")) continue;
      const p1 = joinPosix(kindDir, e1);
      if (!(await fs.isDirectory(p1))) continue;
      if (e1.startsWith("@")) {
        // scope dir → one more level of package dirs.
        let level2: string[];
        try {
          level2 = await fs.readdir(p1);
        } catch {
          continue;
        }
        for (const e2 of level2) {
          if (e2.startsWith(".")) continue;
          const p2 = joinPosix(p1, e2);
          if (!(await fs.isDirectory(p2))) continue;
          await collectSlugDirRecords(p2, [e1, e2], kind, fs, out);
        }
      } else {
        await collectSlugDirRecords(p1, [e1], kind, fs, out);
      }
    }
  }
  return out;
}

/**
 * Atomically point the `current` mirror at `digest` (tmp write + rename; the
 * slug dir is created if needed). MIRROR ONLY: nothing selects or trusts this
 * file — the DB anchor owns the active digest (cinatra#792 wires the writes).
 */
export async function promoteCurrent(
  dataRoot: string,
  kind: ExtensionStoreKind,
  packageName: string,
  digest: string,
): Promise<void> {
  if (!isStoreDigestSegment(digest)) {
    throw new Error(`[extension-store] promoteCurrent: invalid digest ${JSON.stringify(digest)}`);
  }
  const slugDir = storeSlugDirV2(dataRoot, kind, packageName);
  await mkdir(slugDir, { recursive: true });
  const tmp = joinPosix(slugDir, `.current.tmp-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, `${digest}\n`, "utf8");
    await rename(tmp, currentFilePathV2(dataRoot, kind, packageName));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Read the `current` mirror's digest, or null (missing/garbage — never a throw). */
export async function readCurrentDigest(
  dataRoot: string,
  kind: ExtensionStoreKind,
  packageName: string,
): Promise<string | null> {
  try {
    const raw = await readFile(currentFilePathV2(dataRoot, kind, packageName), "utf8");
    return parseCurrentFileText(raw);
  } catch {
    return null;
  }
}
