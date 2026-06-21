// `cinatra <subcommand> --help|-h` must print usage and exit 0 WITHOUT running
// the handler (cinatra#255 footgun). Before this guard, `--help` was an unknown
// flag the per-command arg parsers silently ignored, so the handler EXECUTED —
// for `install` that meant a real from-zero install kicked off (it clones the
// cinatra repo and starts Docker) the moment a user typed `cinatra install
// --help`. These tests pin that a help flag short-circuits to usage with NO
// side effect, across every matcher shape plus the destructive commands.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

// Each test runs the CLI inside a FRESH empty temp dir with a sabotaged PATH so
// that any attempt to actually perform work (git clone, docker, pnpm) is both
// observable (the dir would gain a `cinatra/` checkout) and unable to succeed.
// A correct `--help` short-circuit never touches the dir and exits 0 fast.
let workdir;
const created = [];

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "cinatra-help-"));
  created.push(workdir);
});

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function runHelp(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: workdir,
    timeout: 30_000,
    env: {
      ...process.env,
      // Force any spawned tool lookup to fail fast rather than do real work,
      // and keep installers non-interactive. A correct short-circuit never gets
      // far enough to consult these.
      PATH: workdir,
      CI: "1",
    },
  });
}

// The temp dir must remain empty (no `cinatra/` checkout, no `.env.local`, no
// docker artifacts) — proof that no handler side effect ran.
function assertNoSideEffect() {
  const entries = readdirSync(workdir);
  expect(entries, `temp dir should be untouched, saw: ${entries.join(", ")}`).toEqual([]);
  expect(existsSync(path.join(workdir, "cinatra"))).toBe(false);
  expect(existsSync(path.join(workdir, ".env.local"))).toBe(false);
}

describe("cinatra install --help (the footgun)", () => {
  it("exits 0 and performs NO install/clone/docker side effect", () => {
    const res = runHelp(["install", "--help"]);
    expect(res.status).toBe(0);
    // Prints usage for the install command, NOT the install's own progress.
    expect(res.stdout).toContain("cinatra install");
    expect(res.stdout).toMatch(/Usage:/i);
    // It must NOT have started a real install.
    expect(res.stdout).not.toContain("Checking requirements");
    expect(res.stderr).not.toMatch(/git clone/i);
    assertNoSideEffect();
  });

  it("`-h` is also honored (no install side effect)", () => {
    const res = runHelp(["install", "-h"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cinatra install");
    expect(res.stdout).not.toContain("Checking requirements");
    assertNoSideEffect();
  });
});

describe("cinatra <subcommand> --help across matcher shapes", () => {
  // [argv, expected usage token] — one per match kind plus more destructive cmds.
  const cases = [
    [["install", "--help"], "cinatra install"], // command, destructive
    [["setup", "dev", "--help"], "cinatra setup dev"], // command+mode (dev|prod alt), destructive
    [["db", "migrate", "--help"], "cinatra db migrate"], // command+mode, destructive
    [["clone", "prune", "--help"], "cinatra clone prune"], // command+mode, destructive
    [["dev", "refresh", "--help"], "cinatra dev refresh"], // command+mode, destructive
    [["backup", "import", "--help"], "cinatra backup import"], // command+mode, destructive
    [["reset", "dev", "--help"], "cinatra reset dev"], // command+mode, destructive
    [["mcp", "llm-access", "setup", "--help"], "cinatra mcp llm-access setup"], // command+mode+sub
    [["doctor", "--help"], "cinatra doctor"], // command (read-only, still must not run)
    [["status", "-h"], "cinatra status"], // command, -h alias
  ];

  it.each(cases)("`%j` prints usage, exits 0, no side effect", (args, token) => {
    const res = runHelp(args);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain(token);
    expect(res.stdout).toMatch(/Usage:/i);
    assertNoSideEffect();
  });
});

describe("cinatra <subcommand> --help edge cases", () => {
  it("an unknown command with --help falls back to the full banner (exit 0)", () => {
    const res = runHelp(["bogus", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    expect(res.stdout).toContain("Usage:");
    assertNoSideEffect();
  });

  it("a hidden descriptor (`setup` no-mode) with --help shows the full banner, not a synopsis", () => {
    // `setup --help` matches the hidden `command-no-mode` descriptor; printCommandHelp
    // falls back to the full banner rather than advertise a hidden entry.
    const res = runHelp(["setup", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    assertNoSideEffect();
  });

  it("global `cinatra --help` still renders the full banner (unchanged)", () => {
    const res = runHelp(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    expect(res.stdout).toContain("cinatra install");
  });

  it("a `--help` AFTER the `--` end-of-flags separator is NOT treated as help", () => {
    // hasHelpFlag stops scanning at `--`; a help token after it is positional.
    // `install -- --help` therefore does NOT short-circuit; it dispatches to the
    // install handler, which (with no real toolchain on PATH) fails fast. The
    // point is only that it did NOT print usage — it reached the handler.
    const res = runHelp(["install", "--", "--help"]);
    expect(res.stdout).not.toMatch(/^Usage: cinatra install$/m);
  });
});
