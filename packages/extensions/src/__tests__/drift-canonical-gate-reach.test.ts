// Canonical lifecycle status reachability guard.
//
// Fails CI on any direct write of installed_extension.status outside the
// canonical lifecycle primitive. Catches new bypass paths added by future
// changes (UI server actions, MCP handlers, CLI/install adapters, boot/reload).
//
// Allow-list: the lifecycle primitive (lifecycle-primitive.ts) and the
// canonical store (canonical-store.ts) are the only files permitted to call
// the `_internal*` writers and update `installed_extension.status` directly.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const SOURCE_GLOBS = [
  "packages",
  "src",
  "scripts",
] as const;

const SOURCE_EXTS = new Set([".ts", ".tsx", ".mjs", ".mts"]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".pnpm-store",
  "__pycache__",
  ".git",
  "coverage",
]);

function* walkSourceFiles(dir: string): IterableIterator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTS.has(ext)) yield full;
    }
  }
}

const ALLOWED_FILES = [
  // Lifecycle primitive — the only legal writer of status / source.
  "packages/extensions/src/lifecycle-primitive.ts",
  // Canonical store — exposes the `_internal*` write functions consumed
  // exclusively by the primitive. The primitive is the only caller of these.
  "packages/extensions/src/canonical-store.ts",
  // This test references the symbol names.
  "packages/extensions/src/__tests__/drift-canonical-gate-reach.test.ts",
  // Primitive unit tests reference the direct-writer symbols.
  "packages/extensions/src/__tests__/lifecycle-primitive.test.ts",
  // Teardown-cleanup test — mocks the canonical-store writers (incl.
  // _internalUpdateInstalledExtensionStatus) + builds fixture rows with a
  // `status` field; references the direct-writer symbols, like the test above.
  "packages/extensions/src/__tests__/lifecycle-teardown-permissions.test.ts",
  // Hot-install dispatcher tests — mock the canonical-store writers (incl.
  // _internalDeleteInstalledExtension) in vi.mock fixtures + assertion spies to
  // exercise the install/rollback ordering through the public dispatch path. They
  // never perform a real write — same pattern as the teardown test above.
  "packages/extensions/src/__tests__/dispatcher-install-ordering.test.ts",
  "src/lib/__tests__/extension-dispatch-public-path.test.ts",
];

function findFilesWithPattern(pattern: RegExp): string[] {
  // Pure-Node walker — no dependency on rg / ripgrep / external binaries.
  // Bounded to packages/ + src/ + scripts/ so a single test run is < 2s.
  const hits: string[] = [];
  for (const root of SOURCE_GLOBS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walkSourceFiles(abs)) {
      // Read only files small enough to be source (<= 2 MB defensive cap).
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size > 2 * 1024 * 1024) continue;
      let body: string;
      try {
        body = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (pattern.test(body)) {
        hits.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return hits;
}

describe("canonical lifecycle status reachability guard", () => {
  it(
    "no code writes installed_extension.status directly outside the primitive",
    () => {
      // The primitive uses the `_internal*` helpers (which contain the
      // canonical write). Any file calling `_internalUpdateInstalledExtensionStatus`
      // (or its siblings) outside the allow-list is a drift.
      const hits = findFilesWithPattern(
        /_internalUpdateInstalledExtensionStatus|_internalInsertInstalledExtension|_internalDeleteInstalledExtension|_internalUpdateInstalledExtensionSource|_internalUpdateInstalledExtensionMetadata/,
      );

      const offenders = hits.filter((f) => !ALLOWED_FILES.includes(f));
      expect(
        offenders,
        `These files write installed_extension.status outside the canonical primitive:\n  ${offenders.join("\n  ")}\n\nAdd the file to ALLOWED_FILES only if it is genuinely the lifecycle primitive itself; otherwise route the write through transitionExtensionLifecycle(...).`,
      ).toEqual([]);
    },
    30_000,
  );

  it(
    "raw SQL inserts/updates against installed_extension are confined to the canonical store + DDL",
    () => {
      // Also catch raw SQL writes (Drizzle .insert,
      // .update on the table; or string SQL UPDATE/INSERT INTO installed_extension).
      // Match INSERT/UPDATE/DELETE against installed_extension, INCLUDING
      // schema-qualified forms — `cinatra.installed_extension`,
      // `${q(SCHEMA)}.installed_extension`, `"${s}"."installed_extension"`. The
      // bracket class spans the (single-line) schema qualifier without crossing
      // a newline, so it can't run away across statements.
      const hits = findFilesWithPattern(
        /installedExtensionTable|(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[\w."'`${}()\- ]*installed_extension/i,
      );
      const allowed = new Set([
        "packages/extensions/src/canonical-store.ts",
        "packages/extensions/src/lifecycle-primitive.ts",
        "packages/extensions/src/system-extension-inventory.ts",
        "packages/extensions/src/required-in-prod.ts",
        "src/lib/drizzle-store.ts",
        // Seed script — idempotent seed-marker wipe + re-insert (dev seeding).
        "scripts/seed.mjs",
        "packages/extensions/src/__tests__/drift-canonical-gate-reach.test.ts",
      ]);
      const offenders = hits.filter((f) => !allowed.has(f));
      expect(
        offenders,
        `Raw SQL/Drizzle write against installed_extension found outside the canonical store. Route through transitionExtensionLifecycle:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    },
    30_000,
  );

  it(
    "no code WRITES a per-kind extension_lifecycle_status column",
    () => {
      // The per-kind extension_lifecycle_status columns
      // (agent_templates / skill_packages / workflow_template) are not present;
      // the canonical installed_extension manifest is the single status store.
      // This gate forbids any code from re-introducing a per-kind WRITE:
      //   - SQL:      SET extension_lifecycle_status = ...
      //   - schema:   ADD COLUMN ... extension_lifecycle_status (re-create)
      //   - object:   extensionLifecycleStatus: "active" | "archived" (write)
      // Reads, type fields, comments, and the DROP COLUMN statements are
      // allowed (those don't write the column). The ONLY legal status write
      // is transitionExtensionLifecycle (canonical), covered by the gate above.
      // Patterns are matched PER LINE (not whole-body) so a negated char class
      // can't span statements/newlines and false-match an unrelated ADD COLUMN
      // followed pages later by a DROP/comment mention of the column.
      // Patterns target the SPECIFIC DB-write
      // shapes (drizzle .set()/.values(), patch-object mutation, SQL SET, ADD
      // COLUMN re-create). Plain object-literal fields (return-shape defaults,
      // type signatures, test fixtures) do NOT match — so we no longer need a
      // file-wide allow-list for agents/store.ts which would mask a re-introduced
      // updates.extensionLifecycleStatus writer.
      const WRITE_PATTERNS: RegExp[] = [
        /\bSET\s+extension_lifecycle_status\s*=/i,
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?extension_lifecycle_status\b/i,
        // drizzle .set({ ... extensionLifecycleStatus: ... }) — update writer
        /\.set\s*\(\s*\{[^}]*extensionLifecycleStatus\s*:/,
        // drizzle .values({ ... extensionLifecycleStatus: ... }) — insert writer
        /\.values\s*\(\s*\{[^}]*extensionLifecycleStatus\s*:/,
        // patch-object mutation (e.g. updates.extensionLifecycleStatus = ...)
        /\bupdates?\.extensionLifecycleStatus\s*=/,
      ];
      const ALLOWED_WRITE_MENTION = new Set([
        // This test contains these regexes.
        "packages/extensions/src/__tests__/drift-canonical-gate-reach.test.ts",
      ]);

      const offenders: string[] = [];
      for (const root of SOURCE_GLOBS) {
        const abs = path.join(REPO_ROOT, root);
        if (!fs.existsSync(abs)) continue;
        for (const file of walkSourceFiles(abs)) {
          const rel = path.relative(REPO_ROOT, file);
          if (ALLOWED_WRITE_MENTION.has(rel)) continue;
          let body: string;
          try {
            body = fs.readFileSync(file, "utf8");
          } catch {
            continue;
          }
          const lines = body.split("\n");
          if (lines.some((line) => WRITE_PATTERNS.some((re) => re.test(line)))) {
            offenders.push(rel);
          }
        }
      }
      expect(
        offenders,
        `Per-kind extension_lifecycle_status WRITE re-introduced. Route status through transitionExtensionLifecycle (canonical). Offending files:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    },
    30_000,
  );
});
