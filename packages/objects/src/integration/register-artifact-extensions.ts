import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { objectTypeRegistry } from "../registry";
import type { SemanticArtifactManifest } from "../types";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import {
  GenericObjectListRow,
  GenericObjectCard,
  GenericObjectDetail,
} from "./generic-renderers";

// ---------------------------------------------------------------------------
// Object-registry descriptor bridge.
//
// Scans `extensions/cinatra-ai/*-artifact/package.json`, reads the metadata-
// only `cinatra.artifact` descriptor, and registers ONE generic
// `ObjectTypeDefinition` per artifact type carrying `isArtifact`. The
// library / serving / MCP layers then consume `objectTypeRegistry
// .listArtifacts()` GENERICALLY — a NEW artifact type appears purely by
// adding a `kind:"artifact"` extension dir, with ZERO core per-type
// branches. That pluggability guarantee is proven by the fixture test in
// `__tests__/artifact-bridge.test.ts`.
//
// Server-only + sync fs (mirrors the boot-time registration model). NOT
// exported from the package barrel — the barrel is SSR/React-free; this is
// reached via the `@cinatra-ai/objects/register-artifact-extensions`
// subpath by server callers only (register-all-object-types, dev-watcher).
// ---------------------------------------------------------------------------

// The bridge ingests the semantic artifact manifest. Canonical schema/parser
// lives in ../semantic-manifest; artifact-handler.ts keeps a byte-mirrored copy
// (objects↔extensions cycle forbids sharing — same lock-step constraint).
// `dependencies` (cross-kind ExtensionDependency[], extension-deps gate) and
// `roles` (cinatra#151 Stage 5 role bindings, validated fail-closed by the
// agent-bindings generator) are permitted CROSS-KIND metadata on any
// extension manifest — not agent-package drift; keep in lock-step with
// artifact-handler.ts ALLOWED_CINATRA_KEYS.
const ALLOWED_CINATRA_KEYS = new Set(["kind", "apiVersion", "artifact", "dependencies", "roles"]);

function registerOneArtifactDir(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  let pkg: { name?: unknown; cinatra?: { kind?: unknown; artifact?: unknown } };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return false;
  }
  if (pkg?.cinatra?.kind !== "artifact" || typeof pkg.name !== "string") {
    return false;
  }
  // Keep the same cinatra allowlist as the handler: reject any manifest
  // carrying non-artifact (agent-package) keys.
  const extraneous = Object.keys(pkg.cinatra ?? {}).filter(
    (k) => !ALLOWED_CINATRA_KEYS.has(k),
  );
  if (extraneous.length > 0) {
    console.warn(
      `[artifacts:bridge] ${pkg.name} declares disallowed cinatra key(s) [${extraneous.join(", ")}] — skipped`,
    );
    return false;
  }
  const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
  if (!parsed.ok) {
    console.warn(
      `[artifacts:bridge] ${pkg.name} has an invalid semantic artifact manifest — skipped: ${parsed.errors.join("; ")}`,
    );
    return false;
  }
  const descriptor: SemanticArtifactManifest = parsed.manifest;
  objectTypeRegistry.register({
    // Namespaced id `@scope/pkg:artifact` (matches OBJECT_TYPE_NAMESPACE_RE).
    type: `${pkg.name}:artifact`,
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: {
      sources: ["agent", "user", "import"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: GenericObjectListRow,
      card: GenericObjectCard,
      detail: GenericObjectDetail,
    },
    isArtifact: descriptor,
  });
  return true;
}

function scanDirForArtifacts(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.endsWith("-artifact")) continue;
    if (registerOneArtifactDir(path.join(dir, dirent.name))) n += 1;
  }
  return n;
}

/**
 * Register every `kind:"artifact"` extension under `root`. Robust to caller
 * depth: scans BOTH `<root>/*-artifact` AND `<root>/<vendor>/*-artifact`, so it
 * is correct whether the caller passes the `extensions/` root (dev-watcher /
 * instrumentation) or the `extensions/cinatra-ai` vendor dir
 * (registerAllObjectTypes). Idempotent — the registry is replace-by-id.
 * Returns the count registered.
 */
export function registerArtifactExtensions(root: string): number {
  if (!existsSync(root)) return 0;
  let registered = scanDirForArtifacts(root);
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.endsWith("-artifact")) continue;
    registered += scanDirForArtifacts(path.join(root, dirent.name));
  }
  return registered;
}
