// Extension-empty CLI bootstrap (cold-import) guard.
//
// The CLI must resolve AND its post-config handlers degrade gracefully
// on a fresh checkout where the gitignored `extensions/cinatra-ai/` clone-back
// target is still absent (the CLI itself populates it during
// `cinatra setup dev`). All assertions below are hermetic — none mutates the
// real working tree, and the handler-driving ones isolate `$HOME` to a temp dir
// (so the clone registry + runtime dirs never touch the developer's real
// `~/.cinatra`) and point at an unreachable DB / no Docker project:
//
//   1. SOURCE INVARIANT — zero top-level static `import ... extensions/cinatra-ai`
//      statements in the CLI's `.mjs` sources. Mirrors the milestone gate
//      `rg "^import.*extensions/cinatra-ai" packages/cli/src/*.mjs` == 0, and
//      additionally catches the MULTI-LINE static-import shape (the original
//      pre-fix form). Lazy `await import("../../../extensions/cinatra-ai/...")`
//      calls inside handler bodies are allowed and are NOT matched.
//
//   2. COLD-START LOAD — spawn `cinatra --help` in a child Node process whose
//      module resolver forces every `extensions/cinatra-ai/` specifier to
//      ERR_MODULE_NOT_FOUND (the exact fresh-checkout failure mode). The CLI
//      must still exit 0 and print its help banner. Pre-fix, a top-level static
//      import made this crash at load.
//
//   3. CLONE-START GRACEFUL FALLBACK (HIGH regression) — `cinatra clone start`
//      with `TS_AUTHKEY` unset and the connector forced-absent must NOT hard-fail
//      with ERR_MODULE_NOT_FOUND. The lazy `TailscaleApiError` import lives
//      inside the auto-mint `try`, so an absent extension falls through to
//      local-only mode and the run proceeds to its next (DB) precheck.
//
//   4. DEV-TUNNEL STOP (MEDIUM regression) — `cinatra dev tunnel stop` must
//      complete teardown with the connector forced-absent. `stop` needs no
//      hostname, so the hostname-helper import lives in the `start` branch (not
//      the shared preamble) and `stop` never touches the connector source.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC_DIR = path.join(HERE, "..", "src");
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");
const REGISTER = path.join(HERE, "fixtures", "cold-import-register.mjs");
const REGISTER_URL = pathToFileURL(REGISTER).href;

// Mirrors `rg "^import.*extensions/cinatra-ai"` but additionally catches the
// MULTI-LINE static-import shape — a top-level `import { ... } from "..."`
// statement (one that begins at the start of a line with `import`) reaching
// the extension tree, even when the binding list and the `from "<specifier>"`
// span several lines (the original pre-fix shape). The `[^;]*?` gap allows
// newlines while staying bounded to a single import statement (a static import
// always terminates with `;`/the specifier before any `;`), so it never
// reaches across into an unrelated later line. Lazy `await import(
// "../../../extensions/cinatra-ai/...")` calls inside handler bodies are NOT
// matched: their `import` is preceded by `await `/`(` and is never at the start
// of a line.
const TOP_LEVEL_EXT_IMPORT = /^import\b[^;]*?extensions\/cinatra-ai/m;

// Spawn the CLI in a child Node process whose module resolver forces every
// `extensions/cinatra-ai/` specifier to ERR_MODULE_NOT_FOUND, with `$HOME`
// isolated to a throwaway temp dir so any clone-registry / runtime-dir writes
// stay out of the developer's real `~/.cinatra`.
function runCliExtensionAbsent(args, { home, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, ["--import", REGISTER_URL, BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      // `os.homedir()` on Windows reads USERPROFILE; mirror HOME there too so
      // the registry/runtime paths land in the temp dir on every platform.
      USERPROFILE: home,
      ...extraEnv,
    },
  });
}

describe("extension-empty CLI bootstrap — source invariant", () => {
  const mjsFiles = readdirSync(CLI_SRC_DIR).filter((f) => f.endsWith(".mjs"));

  it("there is at least one .mjs source to scan", () => {
    expect(mjsFiles.length).toBeGreaterThan(0);
  });

  it.each(mjsFiles)(
    "%s has no top-level static import of extensions/cinatra-ai",
    (file) => {
      const src = readFileSync(path.join(CLI_SRC_DIR, file), "utf8");
      expect(TOP_LEVEL_EXT_IMPORT.test(src)).toBe(false);
    },
  );
});

describe("extension-empty CLI bootstrap — source-invariant regex shape", () => {
  // Locks in the LOW finding fix: the invariant must catch BOTH single-line and
  // multi-line static imports of the extension tree, while never flagging the
  // lazy `await import()` calls the CLI legitimately uses.
  it("catches a single-line static import", () => {
    const src = `import { Foo } from "../../../extensions/cinatra-ai/x/y.mjs";\n`;
    expect(TOP_LEVEL_EXT_IMPORT.test(src)).toBe(true);
  });

  it("catches a MULTI-LINE static import (the original pre-fix shape)", () => {
    const src =
      `import {\n` +
      `  TailscaleApiError,\n` +
      `} from "../../../extensions/cinatra-ai/tailscale-connector/src/tailscale-api.mjs";\n`;
    expect(TOP_LEVEL_EXT_IMPORT.test(src)).toBe(true);
  });

  it("does NOT flag a lazy multi-line `await import()` of the extension tree", () => {
    const src =
      `  const { TailscaleApiError } = await import(\n` +
      `    "../../../extensions/cinatra-ai/tailscale-connector/src/tailscale-api.mjs"\n` +
      `  );\n`;
    expect(TOP_LEVEL_EXT_IMPORT.test(src)).toBe(false);
  });

  it("does NOT flag a lazy destructured-assignment `await import()` of the extension tree", () => {
    const src =
      `  let TailscaleApiError;\n` +
      `  ({ TailscaleApiError } = await import(\n` +
      `    "../../../extensions/cinatra-ai/tailscale-connector/src/tailscale-api.mjs"\n` +
      `  ));\n`;
    expect(TOP_LEVEL_EXT_IMPORT.test(src)).toBe(false);
  });

  it("does NOT reach across a terminated import into a later extension mention", () => {
    // A real unrelated import statement, then a lazy import on a later line. The
    // `[^;]*?` bound stops at the first `;`, so the two are not stitched together.
    const src =
      `import { spawnSync } from "node:child_process";\n` +
      `  await import("../../../extensions/cinatra-ai/x.mjs");\n`;
    expect(TOP_LEVEL_EXT_IMPORT.test(src)).toBe(false);
  });
});

describe("extension-empty CLI bootstrap — cold-start load", () => {
  it("`cinatra --help` loads and exits 0 with extensions/cinatra-ai forced-absent", () => {
    const res = spawnSync(
      process.execPath,
      ["--import", REGISTER_URL, BIN, "--help"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // No load-time crash on the absent connector source.
    expect(output).not.toMatch(/Cannot find module/);
    expect(res.status).toBe(0);
    // The help banner actually rendered (a handler-free path).
    expect(output).toContain("cinatra setup");
  });
});

describe("extension-empty CLI bootstrap — post-config handlers degrade gracefully", () => {
  /** @type {string[]} */
  const tempHomes = [];

  function makeTempHome() {
    const home = mkdtempSync(path.join(os.tmpdir(), "cinatra-cold-home-"));
    tempHomes.push(home);
    return home;
  }

  afterEach(() => {
    while (tempHomes.length > 0) {
      const home = tempHomes.pop();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("`clone start` falls through to local-only (no ERR_MODULE_NOT_FOUND) when the connector is absent and TS_AUTHKEY is unset", () => {
    // HIGH regression: a registered, ready clone whose `.env.local` carries an
    // (unreachable) SUPABASE_DB_URL drives runCloneStart into the auto-mint
    // path. With the connector forced-absent the lazy import throws inside the
    // try and the run falls through to local-only mode, then fails LATER on the
    // unreachable-DB precheck — never on a module-not-found crash.
    const home = makeTempHome();
    const worktree = path.join(home, "wt-coldtest");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(path.join(home, ".cinatra"), { recursive: true });
    // Unreachable DB on a deliberately-unused port → fast ECONNREFUSED.
    writeFileSync(
      path.join(worktree, ".env.local"),
      "SUPABASE_DB_URL=postgres://nope:nope@127.0.0.1:5999/cinatra_clone_coldtest\nSUPABASE_SCHEMA=cinatra\n",
    );
    const registry = {
      version: 1,
      clones: {
        coldtest: {
          index: 0,
          nextjsPort: 3100,
          wayflowPort: 3200,
          dbName: "cinatra_clone_coldtest",
          worktreePath: worktree,
          state: "ready",
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      },
    };
    writeFileSync(
      path.join(home, ".cinatra", "clones.json"),
      JSON.stringify(registry),
    );

    const res = runCliExtensionAbsent(["clone", "start", "--slug", "coldtest"], {
      home,
      extraEnv: { TS_AUTHKEY: "" },
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // The fix: NO module-not-found crash on the absent connector source.
    expect(output).not.toMatch(/Cannot find module/);
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    // It fell through to local-only mode (auto-tunnel skipped, no secret leak)…
    expect(output).toMatch(/Tailscale auto-tunnel skipped/);
    // …and proceeded to the next gate: the unreachable clone DB precheck.
    expect(output).toMatch(/cannot reach clone database/);
  });

  it("`dev tunnel stop` tears down (exit 0, no ERR_MODULE_NOT_FOUND) when the connector is absent", () => {
    // MEDIUM regression: `stop` needs no hostname derivation, so the lazy
    // hostname-helper import lives in the `start` branch — not the shared
    // preamble. An empty SUPABASE_DB_URL keeps the teardown DB-free, and the
    // temp HOME means no dev-main compose project exists, so stop is a clean
    // best-effort no-op that exits 0.
    const home = makeTempHome();
    const res = runCliExtensionAbsent(["dev", "tunnel", "stop"], {
      home,
      extraEnv: { SUPABASE_DB_URL: "", CINATRA_RUNTIME_MODE: "development" },
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(output).not.toMatch(/Cannot find module/);
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(res.status).toBe(0);
    expect(output).toMatch(/cinatra dev tunnel stopped/);
  });
});
