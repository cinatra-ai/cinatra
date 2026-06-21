// ---------------------------------------------------------------------------
// Declarative command table for the `cinatra` CLI (cinatra#255 Stage-1).
//
// Plain ESM `.mjs`, NO imports, NO heavy deps — importable from anywhere
// (including the eager-`pg`-free unit tests). This module owns the DECLARATIVE
// shape of the command surface (the descriptors) and the PURE matching +
// help-index logic; `index.mjs` owns the HANDLERS (keyed by `id`) that close
// over the run* implementations and their lazy `import()`s.
//
// Why the split: the dispatcher in `index.mjs` was a hand-maintained ~200-line
// `if`-chain and the help banner (`printHelp`) was a separate hand-maintained
// string — the two drifted independently. The descriptors below are the single
// source of truth for "what commands exist"; the matcher replaces the if-chain
// (first-match-wins, identical semantics) and `buildHelpIndex` lets a drift test
// assert the help banner and the dispatcher stay in lockstep.
//
// IMPORTANT — behavior-preserving contract (do not "improve" without care):
//   * Ordering is significant. `matchDescriptor` scans the array top-to-bottom
//     and returns the FIRST match, mirroring the original if-chain exactly. Do
//     not reorder for aesthetics, and do not switch to a trie / longest-match.
//   * Match kinds mirror the original guards precisely:
//       - "command"        : matches on `argv[0]` ALONE, ignoring `mode`
//                            (e.g. `status`, `doctor` — `cinatra status x` still
//                            routed to status, as the original `command===` did).
//       - "command+mode"   : matches `argv[0]` AND `argv[1]`.
//       - "command+mode+sub": matches `argv[0]`, `argv[1]`, AND `argv[2]`
//                            (the `rest[0]` 3-token guards: `mcp llm-access …`).
//   * Handlers receive the LEGACY `rest = argv.slice(2)` (NOT a descriptor-
//     relative remainder). The 3-token handlers re-slice themselves
//     (`mcp llm-access verify` uses `rest.slice(1)`), exactly as before.
//   * `hidden: true` marks dispatch-only descriptors that have no standalone
//     help row (the env-driven `setup` no-mode entry and the removed
//     `mcp tunnel` stub). The dispatcher still routes them; the help banner does
//     not advertise them. So descriptors are NOT 1:1 with help rows.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CommandDescriptor
 * @property {string} id        Stable handler key (index.mjs HANDLERS[id]).
 * @property {string[]} path    The literal token(s) that route to this command.
 * @property {"command"|"command-no-mode"|"command+mode"|"command+mode+sub"} match  Match kind.
 * @property {boolean} [hidden] Dispatch-only (no standalone help row) when true.
 * @property {string} [summary] One-line description for the help index.
 */

/**
 * The canonical command surface, in dispatch order. The order MUST match the
 * original `runCli` if-chain so first-match-wins semantics are preserved.
 *
 * @type {CommandDescriptor[]}
 */
export const COMMAND_DESCRIPTORS = [
  {
    id: "install",
    path: ["install"],
    match: "command",
    summary: "Bootstrap a Cinatra dev/prod instance from zero (clone, env, infra, setup).",
  },
  {
    id: "login",
    path: ["login"],
    match: "command",
    summary: "Sign in to a Cinatra instance (browser OAuth) and cache the token.",
  },
  {
    id: "status",
    path: ["status"],
    match: "command",
    summary: "Show current setup state (auth tables, user count, MCP config).",
  },
  {
    id: "skills.reset-repo",
    path: ["skills", "reset-repo"],
    match: "command+mode",
    summary: "Force-push the local skills store to the connected GitHub repo (dev only).",
  },
  {
    id: "extensions.purge",
    path: ["extensions", "purge"],
    match: "command+mode",
    summary: "Fully remove an extension everywhere (dev only; loopback; destructive).",
  },
  {
    id: "extensions.acquire-prod",
    path: ["extensions", "acquire-prod"],
    match: "command+mode",
    summary: "Download the production required-extension set into extensions/.",
  },
  {
    id: "extensions.submit",
    path: ["extensions", "submit"],
    match: "command+mode",
    summary: "Submit a built extension tarball to the Cinatra Marketplace for review.",
  },
  {
    id: "mcp.tunnel",
    path: ["mcp", "tunnel"],
    match: "command+mode",
    hidden: true, // Removed feature — routes to a guidance error, not advertised.
  },
  {
    id: "backup.create",
    path: ["backup", "create"],
    match: "command+mode",
    summary: "Export a full backup bundle to data/backups/.",
  },
  {
    id: "backup.import",
    path: ["backup", "import"],
    match: "command+mode",
    summary: "Import a backup bundle (destructive — requires --yes).",
  },
  {
    id: "backup.export-api-configs",
    path: ["backup", "export-api-configs"],
    match: "command+mode",
    summary: "Export connector_config:* + openai_connection metadata to JSON.",
  },
  {
    id: "backup.import-api-configs",
    path: ["backup", "import-api-configs"],
    match: "command+mode",
    summary: "Import API configs from an export-api-configs JSON file.",
  },
  {
    id: "setup",
    path: ["setup"],
    match: "command-no-mode", // ONLY when no `mode` token follows (env-driven dev|prod).
    hidden: true, // No standalone help row.
  },
  {
    id: "setup.dev|prod",
    path: ["setup", "dev|prod"],
    match: "command+mode",
    summary: "Prepare Better Auth, schema, Nango, MCP server, and OAuth clients.",
  },
  {
    id: "setup.nango",
    path: ["setup", "nango"],
    match: "command+mode",
    summary: "Configure Nango administration only.",
  },
  {
    id: "setup.branch",
    path: ["setup", "branch"],
    match: "command+mode",
    summary: "Provision an isolated dev environment for the current git worktree.",
  },
  {
    id: "teardown.branch",
    path: ["teardown", "branch"],
    match: "command+mode",
    summary: "Remove the isolated Postgres schema for the current git worktree.",
  },
  {
    id: "setup.clone",
    path: ["setup", "clone"],
    match: "command+mode",
    summary: "Create + provision a dormant deep-fork clone.",
  },
  {
    id: "clone.refresh-seed",
    path: ["clone", "refresh-seed"],
    match: "command+mode",
    summary: "(Re)build the cinatra_seed template database.",
  },
  {
    id: "clone.prune",
    path: ["clone", "prune"],
    match: "command+mode",
    summary: "Destroy a clone (drops its DB, cleans Redis, releases the slot).",
  },
  {
    id: "clone.list",
    path: ["clone", "list"],
    match: "command+mode",
    summary: "List registered clones (slug, ports, database, state, worktree).",
  },
  {
    id: "clone.start",
    path: ["clone", "start"],
    match: "command+mode",
    summary: "Start a registered clone.",
  },
  {
    id: "clone.stop",
    path: ["clone", "stop"],
    match: "command+mode",
    summary: "Stop a registered clone.",
  },
  {
    id: "clone.status",
    path: ["clone", "status"],
    match: "command+mode",
    summary: "Show a clone's predicted-vs-registered runtime status.",
  },
  {
    id: "clone.slug-for-worktree",
    path: ["clone", "slug-for-worktree"],
    match: "command+mode",
    summary: "Registry lookup for shell hooks (resolve a worktree to its slug).",
  },
  {
    id: "db.migrate",
    path: ["db", "migrate"],
    match: "command+mode",
    summary: "Apply the additive bootstrap + versioned core migration chain.",
  },
  {
    id: "dev.refresh",
    path: ["dev", "refresh"],
    match: "command+mode",
    summary: "Reconcile your local dev environment (deps + dev DB schema).",
  },
  {
    id: "dev.tunnel",
    path: ["dev", "tunnel"],
    match: "command+mode",
    summary: "Manage the dev-main Tailscale Funnel (start|stop|status).",
  },
  {
    id: "reset.dev",
    path: ["reset", "dev"],
    match: "command+mode",
    summary: "Reset the development environment (requires --yes; dev only).",
  },
  {
    id: "mcp.llm-access.setup",
    path: ["mcp", "llm-access", "setup"],
    match: "command+mode+sub",
    summary: "Provision OAuth clients for OpenAI, Anthropic, and Gemini (dev only).",
  },
  {
    id: "mcp.llm-access.refresh",
    path: ["mcp", "llm-access", "refresh"],
    match: "command+mode+sub",
    summary: "Rotate all LLM provider client secrets.",
  },
  {
    id: "doctor",
    path: ["doctor"],
    match: "command",
    summary: "READ-ONLY content-editor write-path self-check (the \"done\" gate).",
  },
  {
    id: "mcp.llm-access.verify",
    path: ["mcp", "llm-access", "verify"],
    match: "command+mode+sub",
    summary: "Alias for `cinatra doctor`.",
  },
  {
    id: "agents.install",
    path: ["agents", "install"],
    match: "command+mode",
    summary: "Resolve and install an agent package tree from Verdaccio.",
  },
  {
    id: "agent.export",
    path: ["agent", "export"],
    match: "command+mode",
    summary: "Export an agent template to a portable ZIP archive.",
  },
  {
    id: "agent.import",
    path: ["agent", "import"],
    match: "command+mode",
    summary: "Import an agent template from a ZIP archive created by `agent export`.",
  },
];

/**
 * Find the first descriptor that matches `argv`, mirroring the original
 * if-chain's first-match-wins semantics. Returns the descriptor, or `null` when
 * nothing matches (the caller then applies its `agents`-no-mode fallback and the
 * unknown-command throw).
 *
 * `path` tokens may use the `a|b` alternation shape (e.g. `setup dev|prod`); a
 * token matches the argv slot when the slot equals the token outright OR is one
 * of the pipe-separated alternatives.
 *
 * @param {CommandDescriptor[]} descriptors
 * @param {string[]} argv
 * @returns {CommandDescriptor|null}
 */
export function matchDescriptor(descriptors, argv) {
  const [command, mode, sub] = argv;
  for (const d of descriptors) {
    if (descriptorMatches(d, command, mode, sub)) {
      return d;
    }
  }
  return null;
}

/**
 * @param {CommandDescriptor} d
 * @param {string|undefined} command
 * @param {string|undefined} mode
 * @param {string|undefined} sub
 * @returns {boolean}
 */
function descriptorMatches(d, command, mode, sub) {
  switch (d.match) {
    case "command":
      return tokenMatches(d.path[0], command);
    case "command-no-mode":
      // Matches the bare command ONLY when no `mode` token follows it, mirroring
      // the original `command === "setup" && !mode` guard. `!mode` was truthy for
      // both `undefined` and an empty-string token, so mirror that exactly.
      return tokenMatches(d.path[0], command) && !mode;
    case "command+mode":
      return tokenMatches(d.path[0], command) && tokenMatches(d.path[1], mode);
    case "command+mode+sub":
      return (
        tokenMatches(d.path[0], command) &&
        tokenMatches(d.path[1], mode) &&
        tokenMatches(d.path[2], sub)
      );
    default:
      return false;
  }
}

/**
 * A single path token matches an argv slot. For a plain token, the slot must
 * equal it. For an `a|b` alternation token, the slot must be one of the
 * EXPANDED alternatives — never the literal `"a|b"` string. This mirrors the
 * original `mode === "dev" || mode === "prod"` guard exactly: `cinatra setup dev`
 * and `cinatra setup prod` route, but a literal `cinatra setup "dev|prod"` does
 * NOT (it falls through to the unknown-command path, as before).
 *
 * @param {string} token
 * @param {string|undefined} slot
 * @returns {boolean}
 */
function tokenMatches(token, slot) {
  if (slot === undefined) return false;
  if (token.includes("|")) {
    // Alternation: match ONLY the expanded alternatives, not the literal token.
    return token.split("|").includes(slot);
  }
  if (token === slot) return true;
  return false;
}

/**
 * A deterministic, human-readable index of the (visible) command surface,
 * derived purely from the descriptors. The drift test snapshots this and
 * asserts every visible command also appears in `printHelp`'s usage block (and
 * vice-versa), so the dispatcher and the banner can never silently diverge.
 *
 * Hidden (dispatch-only) descriptors are excluded — they have no help row.
 *
 * @param {CommandDescriptor[]} descriptors
 * @returns {{ id: string, command: string, summary: string }[]}
 */
export function buildHelpIndex(descriptors) {
  return descriptors
    .filter((d) => !d.hidden)
    .map((d) => ({
      id: d.id,
      command: d.path.join(" "),
      summary: d.summary ?? "",
    }));
}

/**
 * True when `argv` carries a help request (`--help` or `-h`) as a recognized
 * affordance. The dispatcher uses this to SHORT-CIRCUIT to a usage print BEFORE
 * any handler (and therefore any side effect) runs — this is the guard that
 * stops `cinatra install --help` from kicking off a real from-zero install
 * (cinatra#255 footgun: `--help` was an unknown flag the per-command parsers
 * silently ignored, so the destructive handler executed).
 *
 * Scanning stops at the conventional `--` end-of-flags separator, so a literal
 * `-h` / `--help` that a future command might accept as a positional VALUE
 * (after `--`) is not mistaken for a help request. A `--help`/`-h` BEFORE `--`
 * is always treated as help (the conventional meaning, and no current command
 * takes either token as a value).
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasHelpFlag(argv) {
  for (const token of argv) {
    if (token === "--") break; // end-of-flags: anything after is positional.
    if (token === "--help" || token === "-h") return true;
  }
  return false;
}
