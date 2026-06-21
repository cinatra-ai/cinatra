// Command-table drift + routing invariant (cinatra#255 Stage-1, §6 Q6).
//
// The CLI dispatcher was migrated from a hand-maintained ~200-line `if`-chain in
// `runCli` onto the declarative descriptors in `src/command-table.mjs`. These
// tests are the load-bearing guard that the migration is BEHAVIOR-PRESERVING and
// that the descriptors, the matcher, and the hand-written `printHelp` banner can
// never silently drift:
//
//   1. SNAPSHOT — the descriptor ids/paths/match-kinds, in order (first-match-
//      wins is significant), are pinned. A reorder or an added/removed command
//      shows up as a snapshot diff that a reviewer must consciously accept.
//   2. ROUTING — `matchDescriptor` returns the SAME command id the old if-chain
//      would have dispatched, for every prior subcommand plus the tricky
//      multi-token / no-mode / fallback edges (setup-no-mode, mcp llm-access
//      setup|refresh|verify, agents install vs agents fallback, mcp tunnel).
//   3. HELP EQUIVALENCE — every VISIBLE descriptor command appears in the
//      `printHelp` usage block and vice-versa (the §6 Q6 docs↔surface invariant,
//      package-local form). This is pure source-text scanning — no eager `pg`
//      import is triggered (the descriptors module is import-light, and the help
//      banner is read as a string from disk).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMMAND_DESCRIPTORS,
  matchDescriptor,
  buildHelpIndex,
} from "../src/command-table.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

// ---------------------------------------------------------------------------
// 1. Snapshot — the canonical surface, in dispatch order.
// ---------------------------------------------------------------------------
describe("command table — descriptor snapshot", () => {
  it("pins the full descriptor surface (id, command, match, hidden) in order", () => {
    const shape = COMMAND_DESCRIPTORS.map((d) => ({
      id: d.id,
      command: d.path.join(" "),
      match: d.match,
      hidden: Boolean(d.hidden),
    }));
    expect(shape).toMatchInlineSnapshot(`
      [
        {
          "command": "install",
          "hidden": false,
          "id": "install",
          "match": "command",
        },
        {
          "command": "login",
          "hidden": false,
          "id": "login",
          "match": "command",
        },
        {
          "command": "status",
          "hidden": false,
          "id": "status",
          "match": "command",
        },
        {
          "command": "skills reset-repo",
          "hidden": false,
          "id": "skills.reset-repo",
          "match": "command+mode",
        },
        {
          "command": "extensions purge",
          "hidden": false,
          "id": "extensions.purge",
          "match": "command+mode",
        },
        {
          "command": "extensions acquire-prod",
          "hidden": false,
          "id": "extensions.acquire-prod",
          "match": "command+mode",
        },
        {
          "command": "extensions submit",
          "hidden": false,
          "id": "extensions.submit",
          "match": "command+mode",
        },
        {
          "command": "mcp tunnel",
          "hidden": true,
          "id": "mcp.tunnel",
          "match": "command+mode",
        },
        {
          "command": "backup create",
          "hidden": false,
          "id": "backup.create",
          "match": "command+mode",
        },
        {
          "command": "backup import",
          "hidden": false,
          "id": "backup.import",
          "match": "command+mode",
        },
        {
          "command": "backup export-api-configs",
          "hidden": false,
          "id": "backup.export-api-configs",
          "match": "command+mode",
        },
        {
          "command": "backup import-api-configs",
          "hidden": false,
          "id": "backup.import-api-configs",
          "match": "command+mode",
        },
        {
          "command": "setup",
          "hidden": true,
          "id": "setup",
          "match": "command-no-mode",
        },
        {
          "command": "setup dev|prod",
          "hidden": false,
          "id": "setup.dev|prod",
          "match": "command+mode",
        },
        {
          "command": "setup nango",
          "hidden": false,
          "id": "setup.nango",
          "match": "command+mode",
        },
        {
          "command": "setup branch",
          "hidden": false,
          "id": "setup.branch",
          "match": "command+mode",
        },
        {
          "command": "teardown branch",
          "hidden": false,
          "id": "teardown.branch",
          "match": "command+mode",
        },
        {
          "command": "setup clone",
          "hidden": false,
          "id": "setup.clone",
          "match": "command+mode",
        },
        {
          "command": "clone refresh-seed",
          "hidden": false,
          "id": "clone.refresh-seed",
          "match": "command+mode",
        },
        {
          "command": "clone prune",
          "hidden": false,
          "id": "clone.prune",
          "match": "command+mode",
        },
        {
          "command": "clone list",
          "hidden": false,
          "id": "clone.list",
          "match": "command+mode",
        },
        {
          "command": "clone start",
          "hidden": false,
          "id": "clone.start",
          "match": "command+mode",
        },
        {
          "command": "clone stop",
          "hidden": false,
          "id": "clone.stop",
          "match": "command+mode",
        },
        {
          "command": "clone status",
          "hidden": false,
          "id": "clone.status",
          "match": "command+mode",
        },
        {
          "command": "clone slug-for-worktree",
          "hidden": false,
          "id": "clone.slug-for-worktree",
          "match": "command+mode",
        },
        {
          "command": "db migrate",
          "hidden": false,
          "id": "db.migrate",
          "match": "command+mode",
        },
        {
          "command": "dev refresh",
          "hidden": false,
          "id": "dev.refresh",
          "match": "command+mode",
        },
        {
          "command": "dev tunnel",
          "hidden": false,
          "id": "dev.tunnel",
          "match": "command+mode",
        },
        {
          "command": "reset dev",
          "hidden": false,
          "id": "reset.dev",
          "match": "command+mode",
        },
        {
          "command": "mcp llm-access setup",
          "hidden": false,
          "id": "mcp.llm-access.setup",
          "match": "command+mode+sub",
        },
        {
          "command": "mcp llm-access refresh",
          "hidden": false,
          "id": "mcp.llm-access.refresh",
          "match": "command+mode+sub",
        },
        {
          "command": "doctor",
          "hidden": false,
          "id": "doctor",
          "match": "command",
        },
        {
          "command": "mcp llm-access verify",
          "hidden": false,
          "id": "mcp.llm-access.verify",
          "match": "command+mode+sub",
        },
        {
          "command": "agents install",
          "hidden": false,
          "id": "agents.install",
          "match": "command+mode",
        },
        {
          "command": "agent export",
          "hidden": false,
          "id": "agent.export",
          "match": "command+mode",
        },
        {
          "command": "agent import",
          "hidden": false,
          "id": "agent.import",
          "match": "command+mode",
        },
      ]
    `);
  });

  it("every descriptor id is unique", () => {
    const ids = COMMAND_DESCRIPTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every id has a matching index.mjs handler (HANDLERS key)", () => {
    // The id-keyed handler map lives in `buildHandlers()` in index.mjs; each
    // descriptor id must appear as a quoted/bare object key there, so the
    // dispatcher can never reference a missing handler at runtime.
    for (const { id } of COMMAND_DESCRIPTORS) {
      // Keys are either `"id":` (dotted/piped ids) or `id:` (bare identifiers).
      const quoted = INDEX_SRC.includes(`"${id}":`);
      const bare = new RegExp(`(^|[\\s{])${escapeRe(id)}:`, "m").test(INDEX_SRC);
      expect(quoted || bare, `missing handler for "${id}"`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Routing — matchDescriptor returns the id the old if-chain would dispatch.
// ---------------------------------------------------------------------------
describe("command table — routing equivalence with the prior if-chain", () => {
  const cases = [
    // [argv, expected descriptor id | null]
    [["install"], "install"],
    [["install", "--dir", "/tmp/x"], "install"], // command-only: flags ignored by the matcher.
    [["install", "--ref", "main"], "install"],
    [["status"], "status"],
    [["status", "extra"], "status"], // command-only: ignores trailing tokens.
    [["skills", "reset-repo"], "skills.reset-repo"],
    [["extensions", "purge"], "extensions.purge"],
    [["extensions", "acquire-prod"], "extensions.acquire-prod"],
    [["extensions", "submit"], "extensions.submit"],
    [["mcp", "tunnel"], "mcp.tunnel"],
    [["backup", "create"], "backup.create"],
    [["backup", "import"], "backup.import"],
    [["backup", "export-api-configs"], "backup.export-api-configs"],
    [["backup", "import-api-configs"], "backup.import-api-configs"],
    [["setup"], "setup"], // no-mode form.
    [["setup", "dev"], "setup.dev|prod"],
    [["setup", "prod"], "setup.dev|prod"],
    [["setup", "nango"], "setup.nango"],
    [["setup", "branch"], "setup.branch"],
    [["teardown", "branch"], "teardown.branch"],
    [["setup", "clone"], "setup.clone"],
    [["clone", "refresh-seed"], "clone.refresh-seed"],
    [["clone", "prune"], "clone.prune"],
    [["clone", "list"], "clone.list"],
    [["clone", "start"], "clone.start"],
    [["clone", "stop"], "clone.stop"],
    [["clone", "status"], "clone.status"],
    [["clone", "slug-for-worktree"], "clone.slug-for-worktree"],
    [["db", "migrate"], "db.migrate"],
    [["dev", "refresh"], "dev.refresh"],
    [["dev", "tunnel"], "dev.tunnel"],
    [["dev", "tunnel", "start"], "dev.tunnel"], // tunnel sub-verbs route to the same handler.
    [["reset", "dev"], "reset.dev"],
    [["mcp", "llm-access", "setup"], "mcp.llm-access.setup"],
    [["mcp", "llm-access", "refresh"], "mcp.llm-access.refresh"],
    [["mcp", "llm-access", "verify"], "mcp.llm-access.verify"],
    [["mcp", "llm-access", "verify", "--strict"], "mcp.llm-access.verify"],
    [["doctor"], "doctor"],
    [["doctor", "--strict"], "doctor"],
    [["agents", "install"], "agents.install"],
    [["agents", "install", "@scope/x"], "agents.install"],
    [["agent", "export"], "agent.export"],
    [["agent", "import"], "agent.import"],
    // Non-matches: fall through to the fallback / unknown handling in runCli.
    [["agents"], null],
    [["agents", "bogus"], null],
    [["mcp", "llm-access", "bogus"], null],
    [["mcp"], null],
    [["bogus"], null],
    [["setup", "unknown-mode"], null],
    // A LITERAL `"dev|prod"` arg must NOT match the `dev|prod` alternation token
    // (the alternation only matches its expanded alternatives), mirroring the
    // old `mode === "dev" || mode === "prod"` guard which never saw the pipe.
    [["setup", "dev|prod"], null],
  ];

  it.each(cases)("routes %j -> %s", (argv, expectedId) => {
    const d = matchDescriptor(COMMAND_DESCRIPTORS, argv);
    expect(d ? d.id : null).toBe(expectedId);
  });

  it("setup-no-mode never shadows `setup dev` (specificity)", () => {
    // The bare `setup` descriptor precedes `setup dev|prod` in dispatch order,
    // but its `command-no-mode` match kind requires the absence of a mode token,
    // so `setup dev` still reaches `setup.dev|prod` (first-match-wins is safe).
    expect(matchDescriptor(COMMAND_DESCRIPTORS, ["setup"]).id).toBe("setup");
    expect(matchDescriptor(COMMAND_DESCRIPTORS, ["setup", "dev"]).id).toBe("setup.dev|prod");
  });

  it("doctor is matched by command alone, before the verify alias", () => {
    // Mirrors the original ordering: the `doctor` guard sits between the
    // llm-access setup/refresh guards and the verify alias; none collide.
    const doctorIdx = COMMAND_DESCRIPTORS.findIndex((d) => d.id === "doctor");
    const verifyIdx = COMMAND_DESCRIPTORS.findIndex((d) => d.id === "mcp.llm-access.verify");
    const setupIdx = COMMAND_DESCRIPTORS.findIndex((d) => d.id === "mcp.llm-access.setup");
    expect(setupIdx).toBeLessThan(doctorIdx);
    expect(doctorIdx).toBeLessThan(verifyIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. Help equivalence — visible commands <-> printHelp usage block (§6 Q6).
// ---------------------------------------------------------------------------
describe("command table — docs↔surface drift (printHelp equivalence)", () => {
  const helpIndex = buildHelpIndex(COMMAND_DESCRIPTORS);
  // The `Usage:` block of printHelp (between `Usage:` and the `Commands:` header).
  const usageBlock = extractUsageBlock(INDEX_SRC);

  it("printHelp has a Usage block to scan", () => {
    expect(usageBlock.length).toBeGreaterThan(200);
  });

  it("forward: every visible descriptor command appears in the printHelp Usage block", () => {
    for (const { command } of helpIndex) {
      // `setup dev|prod` is rendered as BOTH `cinatra setup dev` and
      // `cinatra setup prod`; require EVERY expanded alternative to be present
      // (so neither alternative can silently vanish from the banner).
      const variants = expandPipeAlternatives(command);
      for (const v of variants) {
        expect(
          usageBlock.includes(`cinatra ${v}`),
          `"cinatra ${v}" missing from printHelp Usage`,
        ).toBe(true);
      }
    }
  });

  it("reverse: every `cinatra <cmd>` Usage line maps to a known descriptor", () => {
    // Bidirectional drift guard: a usage line for a command that no longer
    // exists in the table (or never did) must fail, so the banner can never
    // advertise a command the dispatcher does not route.
    const usageCommands = extractUsageCommands(usageBlock);
    expect(usageCommands.length).toBeGreaterThan(20);
    for (const tokens of usageCommands) {
      const d = matchDescriptor(COMMAND_DESCRIPTORS, tokens);
      expect(
        d !== null,
        `Usage advertises "cinatra ${tokens.join(" ")}" but no descriptor routes it`,
      ).toBe(true);
    }
  });

  it("hidden descriptors are excluded from the help index", () => {
    const ids = new Set(helpIndex.map((e) => e.id));
    expect(ids.has("setup")).toBe(false); // no-mode form
    expect(ids.has("mcp.tunnel")).toBe(false); // removed feature
  });

  it("the help index is stable and non-empty", () => {
    expect(helpIndex.length).toBe(
      COMMAND_DESCRIPTORS.filter((d) => !d.hidden).length,
    );
    expect(helpIndex.length).toBeGreaterThan(25);
  });
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Extract the `Usage:` ... up to `Commands:` slice of the printHelp template.
function extractUsageBlock(src) {
  const start = src.indexOf("Usage:");
  const end = src.indexOf("Commands:", start);
  if (start === -1 || end === -1) return "";
  return src.slice(start, end);
}

// Parse the Usage block into the routing token lists each `cinatra <...>` line
// advertises. For every line beginning `cinatra `, take the leading literal
// tokens up to the first flag / placeholder (`[`, `<`, `--`), which are exactly
// the command/mode/sub tokens the dispatcher matches on. `mcp llm-access verify`
// -> ["mcp","llm-access","verify"]; `setup dev [--x]` -> ["setup","dev"].
function extractUsageCommands(block) {
  const out = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("cinatra ")) continue;
    const after = line.slice("cinatra ".length).trim();
    const tokens = [];
    for (const tok of after.split(/\s+/)) {
      if (tok.startsWith("[") || tok.startsWith("<") || tok.startsWith("--")) break;
      tokens.push(tok);
    }
    if (tokens.length > 0) out.push(tokens);
  }
  return out;
}

// `setup dev|prod` -> ["setup dev", "setup prod"]; commands with no pipe return [command].
function expandPipeAlternatives(command) {
  const parts = command.split(" ");
  const pipeIdx = parts.findIndex((p) => p.includes("|"));
  if (pipeIdx === -1) return [command];
  const alts = parts[pipeIdx].split("|");
  return alts.map((alt) => {
    const copy = parts.slice();
    copy[pipeIdx] = alt;
    return copy.join(" ");
  });
}
