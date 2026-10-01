#!/usr/bin/env node
// Vendors Cinatra design-registry primitive SOURCE into extension subtrees as
// own-your-code copies.
//
// This is the IN-MONOREPO equivalent of `shadcn add @cinatra-ai/<item>` of
// explicit items: an extension that still lives under extensions/ shares the
// app's `@/` alias (`@/*` -> ./src/*), so a literal `shadcn add --cwd <ext>`
// would rewrite copied imports to `@/components/ui/*` / `@/lib/utils` that
// resolve to the APP — re-coupling to exactly what the decouple removes. A
// faithful `shadcn add` only works once an extension is its own repo with its
// own `@/` (extraction time). Until then we vendor the registry source here
// with RELATIVE cross-imports, byte-identical to what `shadcn add` emits in a
// standalone repo.
//
// Run as `--check` it is a PROVENANCE GATE: every vendored file MUST equal its
// registry source modulo the import-path rewrite, so vendored copies cannot
// silently drift from src/components/ui / src/lib/utils.
//
// Usage:
//   node scripts/extensions/vendor-extension-primitives.mjs           # write/refresh
//   node scripts/extensions/vendor-extension-primitives.mjs --check    # gate (no writes)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Which design-registry primitives each extension vendors. `uiItems` lists only
// the primitives an extension imports DIRECTLY; the transitive closure (e.g.
// field -> label/separator, input-group -> button/input/textarea) is resolved
// from registry.json's registryDependencies so the manifest can't drift from
// the component graph. Sources are always the single source of truth:
// src/components/ui/<item>.tsx + src/lib/utils.ts. (StatusPill is NOT here — it
// is a Cinatra-ABI widget consumed from @cinatra-ai/sdk-ui/marketplace, not a
// vendored registry primitive.)
//
// KIND-AGNOSTIC CHANNEL (cinatra#1625, epic #1620 S8 — M3): this manifest and
// the whole vendoring/provenance mechanism are extension-KIND-neutral — an
// `extensionDir` under `extensions/<scope>/` is vendored the same way whether it
// is a connector OR an AGENT. A companion HITL-renderer slice that relocates a
// field-renderer component into its claiming `-agent` extension adds an entry
// here for that agent dir, exactly like a connector; the relative-import rewrite
// keeps the vendored primitives clear of the `@/` import-ban (which is itself
// kind-agnostic). Nothing below is connector-specific.
//
// RETIRED KINDS — DECISION 407 A (2026-09-13, cinatra-ai/cinatra#3471, epic
// #2926). Connectors render the setup page themselves and artifacts render the
// artifact view themselves, and the host shares its primitives with extension
// bundles at RUN TIME (the way React is shared) — so copying primitives INTO
// those packages is no longer the road, and the copy check is retired for both
// kinds: every kind:connector and kind:artifact entry is gone from this
// manifest. The copies those packages still carry are recorded by the
// shrink-only baseline of
// scripts/extensions/self-rendering-extensions-border-gate.mjs — the ONLY
// record of them from now on — so a change to a primitive no longer forces a
// release of every copying package. Re-adding an entry of either kind fails
// scripts/extensions/__tests__/vendor-extension-primitives.test.mjs.
const VENDOR_MANIFEST = [
  // AGENT claimant (cinatra#1625, epic #1620 S8 — M3): list-curator-agent
  // relocated its two HITL field-renderer components into its own repo; they
  // import these design-registry primitives, vendored the same kind-agnostic
  // way a connector does (relative imports, provenance-gated).
  {
    extensionDir: "extensions/cinatra-ai/list-curator-agent",
    uiItems: ["badge", "button", "card", "input", "input-group", "label", "textarea"],
  },
  // AGENT claimant (cinatra#1625, epic #1620 S8 — M3): blog-linkedin-publish-agent
  // relocated its draft-review HITL field renderer into its own repo; it imports
  // these design-registry primitives, vendored the same kind-agnostic way.
  {
    extensionDir: "extensions/cinatra-ai/blog-linkedin-publish-agent",
    uiItems: ["button", "card", "label", "textarea"],
  },
  // AGENT claimant (cinatra#1625, epic #1620 S8 — M3): blog-wordpress-publish-agent
  // relocated its draft-confirm HITL field renderer into its own repo; the pure
  // confirm/reject card imports only these design-registry primitives (no
  // editable textarea/label), vendored the same kind-agnostic way.
  {
    extensionDir: "extensions/cinatra-ai/blog-wordpress-publish-agent",
    uiItems: ["button", "card"],
  },
];

// registryDependencies are namespaced (`@cinatra-ai/label`) so a consumer's
// shadcn CLI resolves them in OUR registry instead of its default one; the item
// names themselves stay bare, so strip the namespace when walking the closure.
// STRICT on purpose: a bare or foreign-namespaced entry is exactly the defect
// this fix removes (a bare name resolves against the CONSUMER's default
// registry, which is how upstream's `utils` item overwrote ours), so it must
// fail loudly here rather than resolve to a plausible-looking local item.
export const localItemName = (dep) => {
  const match = /^@cinatra-ai\/([A-Za-z0-9._-]+)$/.exec(dep);
  if (!match) {
    throw new Error(
      `registryDependencies entry ${dep} is not namespaced as @cinatra-ai/<item>; ` +
        "a bare or foreign namespace resolves against the consumer's default registry",
    );
  }
  return match[1];
};

// Resolve the transitive registry:ui closure of `directItems` from
// registry.json's registryDependencies (excluding the `utils` lib, which is
// always vendored separately). A vendored field.tsx imports ./label + ./separator
// relatively, so those siblings MUST also be vendored or the import dangles.
function resolveUiClosure(directItems) {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8"));
  const regDeps = new Map(
    registry.items.map((it) => [it.name, it.registryDependencies ?? []]),
  );
  const seen = new Set();
  const queue = [...directItems];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === "utils" || seen.has(name)) continue;
    seen.add(name);
    for (const dep of regDeps.get(name) ?? []) queue.push(localItemName(dep));
  }
  return [...seen].sort();
}

// Every registry item name — used to scope orphan detection to vendor-MANAGED
// files only, so a connector's own (non-primitive) components/ui/* is never touched.
function registryItemNames() {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8"));
  return new Set(registry.items.map((it) => it.name));
}

// Vendored primitive files on disk that the current manifest+closure no longer
// expects. Without this, a stale sibling left after a closure shrink would
// silently satisfy a now-removed relative import (masking the regression — the
// provenance check only compares PLANNED files). Scoped to registry-item names.
function findOrphans() {
  const managed = registryItemNames();
  const orphans = [];
  for (const entry of VENDOR_MANIFEST) {
    const expected = new Set(resolveUiClosure(entry.uiItems));
    const uiDir = join(REPO_ROOT, entry.extensionDir, "src/components/ui");
    if (!existsSync(uiDir)) continue;
    for (const file of readdirSync(uiDir)) {
      if (!file.endsWith(".tsx")) continue;
      const name = file.slice(0, -4);
      if (managed.has(name) && !expected.has(name)) {
        orphans.push(join(entry.extensionDir, "src/components/ui", file));
      }
    }
  }
  return orphans;
}

// Rewrite a primitive's app-aliased imports to the relative paths it has once
// vendored at <ext>/src/components/ui/<item>.tsx. Fails loud on any OTHER `@/`
// import so a new coupling can never be vendored silently.
function rewriteUiImports(content, sourceRel) {
  // Quote-agnostic: src/components/ui/* mixes single- and double-quoted imports.
  let out = content.replace(/from (['"])@\/lib\/utils\1/g, 'from "../../lib/utils"');
  out = out.replace(/from (['"])@\/components\/ui\/([a-z0-9-]+)\1/g, 'from "./$2"');
  const leftover = out.match(/from ['"]@\/[^'"]+['"]/g);
  if (leftover) {
    throw new Error(
      `[vendor-extension-primitives] ${sourceRel} has un-vendorable app import(s) ` +
        `${JSON.stringify(leftover)} — only "@/lib/utils" and "@/components/ui/*" are ` +
        `relative-rewritable. Decouple it through a port (608b), do not vendor it.`,
    );
  }
  return out;
}

function plannedFiles() {
  const files = [];
  for (const entry of VENDOR_MANIFEST) {
    // cn / utils (registry:lib) — no `@/` self-refs, copied verbatim.
    files.push({
      source: "src/lib/utils.ts",
      target: join(entry.extensionDir, "src/lib/utils.ts"),
      transform: (c) => c,
    });
    for (const item of resolveUiClosure(entry.uiItems)) {
      const source = `src/components/ui/${item}.tsx`;
      files.push({
        source,
        target: join(entry.extensionDir, `src/components/ui/${item}.tsx`),
        transform: (c) => rewriteUiImports(c, source),
      });
    }
  }
  return files;
}

function main() {
  const check = process.argv.includes("--check");
  const files = plannedFiles();
  const drift = [];
  let wrote = 0;

  for (const file of files) {
    const sourceAbs = join(REPO_ROOT, file.source);
    const targetAbs = join(REPO_ROOT, file.target);
    const expected = file.transform(readFileSync(sourceAbs, "utf8"));

    if (check) {
      let actual = null;
      try {
        actual = readFileSync(targetAbs, "utf8");
      } catch {
        actual = null;
      }
      if (actual !== expected) {
        drift.push(file.target);
      }
    } else {
      mkdirSync(dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, expected);
      wrote += 1;
    }
  }

  const orphans = findOrphans();

  if (check) {
    const problems = [];
    if (drift.length > 0) {
      problems.push("PROVENANCE DRIFT — vendored primitives no longer match registry source (modulo import rewrites):");
      for (const t of drift) problems.push(`  - ${t}`);
    }
    if (orphans.length > 0) {
      problems.push("ORPHAN vendored primitives — on disk but no longer in the connector's resolved closure (would mask a removed relative import):");
      for (const o of orphans) problems.push(`  - ${o}`);
    }
    if (problems.length > 0) {
      console.error("[vendor-extension-primitives] " + problems.join("\n"));
      console.error("Run `node scripts/extensions/vendor-extension-primitives.mjs` to re-vendor + prune from source.");
      process.exit(1);
    }
    console.log(
      `[vendor-extension-primitives] OK — ${files.length} vendored file(s) match registry source; no orphans.`,
    );
    return;
  }

  // Prune orphaned vendored primitives so a closure shrink can't leave a stale
  // sibling on disk.
  for (const o of orphans) rmSync(join(REPO_ROOT, o), { force: true });
  console.log(
    `[vendor-extension-primitives] wrote ${wrote} file(s)` +
      (orphans.length ? `; pruned ${orphans.length} orphan(s).` : "."),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { plannedFiles, rewriteUiImports, resolveUiClosure, findOrphans, VENDOR_MANIFEST };
