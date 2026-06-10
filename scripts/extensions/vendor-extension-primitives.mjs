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
// the primitives a connector imports DIRECTLY; the transitive closure (e.g.
// field -> label/separator, input-group -> button/input/textarea) is resolved
// from registry.json's registryDependencies so the manifest can't drift from
// the component graph. Sources are always the single source of truth:
// src/components/ui/<item>.tsx + src/lib/utils.ts. (StatusPill is NOT here — it
// is a Cinatra-ABI widget consumed from @cinatra-ai/sdk-ui/marketplace, not a
// vendored registry primitive.)
const VENDOR_MANIFEST = [
  {
    extensionDir: "extensions/cinatra-ai/google-calendar-connector",
    uiItems: ["alert", "button", "field", "input-group"],
  },
  {
    extensionDir: "extensions/cinatra-ai/twenty-connector",
    uiItems: ["card"],
  },
  {
    extensionDir: "extensions/cinatra-ai/linkedin-connector",
    uiItems: ["badge", "button", "input", "label"],
  },
  {
    extensionDir: "extensions/cinatra-ai/drupal-assistant-connector",
    uiItems: ["badge", "button", "field", "input"],
  },
  {
    extensionDir: "extensions/cinatra-ai/tailscale-connector",
    uiItems: ["alert", "badge", "button", "card", "field", "input-group"],
  },
  {
    extensionDir: "extensions/cinatra-ai/crm-connector",
    uiItems: ["field", "input-group"],
  },
  {
    extensionDir: "extensions/cinatra-ai/gemini-connector",
    uiItems: ["button", "input", "label"],
  },
  {
    extensionDir: "extensions/cinatra-ai/github-connector",
    uiItems: ["button", "input", "label"],
  },
  {
    extensionDir: "extensions/cinatra-ai/gmail-connector",
    uiItems: ["alert", "button"],
  },
  {
    extensionDir: "extensions/cinatra-ai/apify-connector",
    uiItems: ["alert", "button", "field", "input"],
  },
  {
    extensionDir: "extensions/cinatra-ai/mcp-client-connector",
    uiItems: ["alert", "button"],
  },
  {
    extensionDir: "extensions/cinatra-ai/wordpress-mcp-connector",
    uiItems: ["badge", "button", "input-group"],
  },
  {
    extensionDir: "extensions/cinatra-ai/drupal-mcp-connector",
    uiItems: ["alert", "badge", "button", "field", "input", "input-group", "label"],
  },
  {
    extensionDir: "extensions/cinatra-ai/wordpress-assistant-connector",
    uiItems: ["badge", "button", "field", "input"],
  },
  {
    extensionDir: "extensions/cinatra-ai/a2a-server-connector",
    uiItems: ["alert", "button", "field", "input", "input-group"],
  },
  {
    extensionDir: "extensions/cinatra-ai/nango-connector",
    uiItems: ["alert", "button", "card", "field", "input", "input-group", "label"],
  },
  {
    extensionDir: "extensions/cinatra-ai/apollo-connector",
    uiItems: ["alert", "button", "field", "input", "label", "table", "paginated-table"],
  },
  {
    extensionDir: "extensions/cinatra-ai/openai-connector",
    uiItems: ["button", "input", "label", "textarea"],
  },
];

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
    for (const dep of regDeps.get(name) ?? []) queue.push(dep);
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
