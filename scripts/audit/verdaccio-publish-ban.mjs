#!/usr/bin/env node
/**
 * Verdaccio / registry.cinatra publish-EXECUTION ban (standing CI gate).
 *
 * THE RULE — extensions publish ONLY through the marketplace proxy. No
 * GitHub Actions workflow (or local composite action) in this repo may
 * EXECUTE a registry publish to Verdaccio / registry.cinatra.ai. The
 * registry is the install-backend behind a marketplace listing; it is never
 * a publish target a workflow drives directly.
 *
 * This scanner reads every `.github/workflows/*.yml|*.yaml` AND every local
 * composite action (`.github/actions/** /action.yml|action.yaml`) and FAILS
 * (exit 1, printing the offending file + line) if any `run:` step EXECUTES a
 * publish command. Banned executed forms include:
 *
 *     npm  publish ...                      (and behind manager flags that
 *     pnpm publish ...                       take VALUES, e.g.
 *     yarn publish ...                       `npm --prefix dist publish`,
 *     bun  publish ...                       `pnpm --filter foo publish`,
 *                                            `yarn --cwd dist publish`)
 *     pnpm recursive publish                (pnpm subcommand aliases:
 *     pnpm multi publish                     recursive / multi / m / -r)
 *     corepack pnpm --filter foo publish    (runner-shim prefixes)
 *     /usr/bin/npm publish                  (absolute-path command names)
 *     npm.cmd publish                       (.cmd/.exe/.ps1 windows shims)
 *     npm exec -- npm publish               (exec wrappers)
 *     pnpm exec npm publish
 *     npm exec --call 'npm publish'
 *     bash -c "npm publish ..."             (shell -c string bodies)
 *     sh -c 'pnpm publish'
 *     env -S 'npm publish'                  (env split-string command body)
 *     (npm publish) | { npm publish; }      (subshell / group wrappers)
 *     if true; then npm publish; fi         (compound-command wrappers)
 *     while/for ... do npm publish; done
 *     ! npm publish                         (pipeline-negation wrapper)
 *     yarn npm publish                      (yarn berry's `yarn npm publish`)
 *     curl -X PUT https://registry.cinatra.ai/...   (raw PUT publish)
 *     curl --upload-file=x https://registry.cinatra.ai/...
 *     curl -T x .../  (to a verdaccio/registry.cinatra host)
 *
 * regardless of whether `--registry <verdaccio-url>` is present — an executed
 * publish is banned outright, and a registry pointed at the cinatra registry
 * is reported with extra emphasis.
 *
 * CONTENT-AWARE — only an ACTUALLY-EXECUTED publish trips the gate. A publish
 * token that merely appears inside a printed string is allowed:
 *
 *   - `echo "... pnpm publish bundle.tgz --registry <url>"`  → ALLOWED
 *   - `printf '... npm publish ...\n'`                       → ALLOWED
 *   - a `#` comment line mentioning `npm publish`           → ALLOWED
 *   - a DATA-only heredoc body (`cat <<EOF` … `EOF`)         → ALLOWED
 *   - `--registry https://npm.publish.example/` (value only) → ALLOWED
 *   - `npm run publish-docs` / `npm run-script publish`      → ALLOWED
 *     (a RUN SCRIPT named publish-* is NOT the publish subcommand)
 *
 * vs.
 *
 *   - `npm publish --tag proof --registry "$URL"`            → BANNED
 *   - `pnpm publish bundle.tgz --no-git-checks`              → BANNED
 *   - `corepack pnpm --filter foo publish`                   → BANNED
 *   - `bash <<'EOF'` … `npm publish` … `EOF` (shell heredoc) → BANNED
 *
 * PARSING APPROACH — CONSERVATIVE (zero-dep, line-oriented). An adversarial
 * reviewer keeps inventing new direct-execution shell forms a PRECISE parser
 * misses. We stop trying to precisely parse shell grammar. Instead we BIAS TO
 * FLAG: decompose each run body into CANDIDATE SIMPLE COMMANDS by splitting
 * AGGRESSIVELY (on the full set of shell command separators AND group/keyword
 * boundaries), strip wrappers off each candidate, then flag on a simple
 * manager+`publish` adjacency or a curl-upload signal. This collapses the
 * shell-evasion space — every grammar wrapper (`(...)`, `{ ...; }`,
 * `if/then/fi`, `while/for/do/done`, `! cmd`) decomposes to a candidate whose
 * tokens start with the manager. A false POSITIVE is acceptable (the workflow
 * author fixes it or adds an explicit allow-comment); a false NEGATIVE defeats
 * the gate. The marketplace proxy + broker re-validate server-side — this is a
 * structural tripwire, so we OVER-flag by design.
 *
 *   1. Identify `run:` steps (tolerant key match: `run:` / `"run"` / `'run'`,
 *      spaces around `:`, optional `-` list marker, a YAML anchor `&name` / tag
 *      `!!str`/`!<...>`/`!foo` after the key) and extract their full executable
 *      text: inline (plain / 'single' / "double" quoted), literal/folded block
 *      scalars (`|` / `>`, with optional chomp/indent/comment/anchor/tag in the
 *      header), AND a plain multi-line scalar (`run:` with nothing after it,
 *      then an indented continuation). Also scan local composite actions.
 *   2. Within a run body, join backslash line-continuations, fold folded
 *      scalars, drop `#` comment lines + inline comments (outside quotes/subs/
 *      URL fragments), and recurse INTO shell-interpreter heredoc bodies
 *      (bash/sh/zsh/dash/ksh without inline -c); skip DATA heredocs (cat/tee).
 *   3. Extract every command substitution (`$(...)`, backticks) outside single
 *      quotes and RECURSE — a publish inside a substitution executes.
 *   4. Strip single-quoted literal regions; treat the ARGUMENT text of a
 *      leading echo/printf/:/true/false as data.
 *   5. SPLIT the remaining executable text into CANDIDATE SIMPLE COMMANDS on a
 *      BROAD boundary set: newline, `;`, `&&`, `||`, `|`, `&`, `(`, `)`, `{`,
 *      `}`, and standalone shell keywords (then/do/else/elif/fi/done/in/time).
 *   6. PER-CANDIDATE: strip a leading `!`, env assignments, and runner shims
 *      (env/sudo/doas/time/nice/stdbuf/setsid/command/exec/corepack/npx/bunx +
 *      `pnpm dlx`) with their option flags; recurse into shim command STRINGS
 *      (`bash -c`/`-lc`, `npx -c`/`--call`, `env -S 'cmd'`). Compute the head
 *      token's BASENAME (strip dir path + trailing `.cmd`/`.exe`/`.ps1`).
 *   7. FLAG when the basename is a package manager and the first non-flag,
 *      non-alias token is exactly `publish`; OR yarn berry `yarn npm publish`;
 *      OR a `curl` upload (`-X`/`--request` PUT|POST, `-T`/`--upload-file`,
 *      joined forms too) to a verdaccio/registry.cinatra URL.
 *   8. EXEMPT pure echo/printf/:/true/false candidates; publish tokens that
 *      only survive inside print args or comments are already stripped.
 *
 * ACCEPTED LIMITATIONS (honest scope of this CI ratchet — the marketplace
 * proxy + credential broker re-validate publish authority SERVER-SIDE
 * regardless, which is the real control; this scanner is a structural
 * tripwire, not a sandbox). With the conservative redesign, the only residual
 * gaps are the GENUINELY statically-undecidable ones:
 *   - VAR-INDIRECTION OF THE COMMAND NAME — when the publishing binary is named
 *     by a variable whose value is unknown at scan time (`${PM} publish`,
 *     `$PM publish`, `"$RUNNER" publish`). We cannot prove the variable expands
 *     to npm/pnpm/yarn/bun.
 *   - EVAL / DECODED COMMANDS — `eval "$VAR"`, `… | base64 -d | sh`,
 *     `printf … | bash`, or any command assembled/decoded at runtime. The
 *     literal text is not a publish; the runtime value is.
 *   - EXTERNAL / 3rd-party actions (`uses: some-org/publish-action@v1`) are NOT
 *     fetched or parsed — only their `uses:` reference is visible here.
 *   - REUSABLE workflows in OTHER repos (`uses: org/repo/.github/workflows/
 *     x.yml@ref`) are not followed.
 *   - Arbitrary INVOKED SCRIPT FILES (`run: node scripts/publish.mjs`,
 *     `run: ./release.sh`) are not opened/expanded — only literal `run:` text.
 *   - WINDOWS BACKSLASH-PATH manager invocations (`C:\…\npm.cmd publish`,
 *     `.\node_modules\.bin\npm.cmd publish`) on a POSIX shell: the backslash is
 *     genuinely SHELL-AMBIGUOUS — an ESCAPE under bash/sh (where `C:\…\npm.cmd`
 *     does not even invoke npm) and a PATH SEPARATOR under cmd/pwsh — so the
 *     literal text cannot be resolved without knowing the runner shell. A
 *     forward-slash path (`./node_modules/.bin/npm publish`) IS caught.
 *   - COMMAND-LAUNCHER UTILITIES that invoke a publish indirectly — `find . -exec
 *     npm publish {} \;`, `xargs npm publish`, `parallel npm publish`,
 *     `timeout 60 npm publish`, `watch npm publish` — are not modeled (the
 *     launcher head is not a package manager). Publishing through `find`/`xargs`
 *     is a contrived shape no real release workflow uses; the server-side
 *     control covers it. (Common runner SHIMS that merely prefix the command —
 *     `env`/`sudo`/`time`/`nice`/`corepack`/`npx`/`bash -c`/`env -S` — ARE
 *     stripped and their wrapped publish IS caught.)
 *
 * NO filename-based exemptions — this gate does not whitelist specific
 * workflow filenames. No publish-EXECUTING workflow is exempted; the repo
 * ships none.
 *
 * Usage:
 *   node scripts/audit/verdaccio-publish-ban.mjs
 *
 * Exit codes:
 *   0  no workflow / composite action executes a registry publish
 *   1  one or more EXECUTE a publish command (offenders printed)
 *
 * Unit tests in scripts/audit/__tests__/verdaccio-publish-ban.test.mjs.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = fileURLToPath(
  new URL("../../.github/workflows", import.meta.url),
);
const ACTIONS_DIR = fileURLToPath(
  new URL("../../.github/actions", import.meta.url),
);

const CINATRA_REGISTRY_HINT_RE = /verdaccio|registry\.cinatra/i;

/**
 * Package managers whose `publish` SUBCOMMAND is banned.
 */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/**
 * Manager flags that take a SEPARATE VALUE token (i.e. the next token is the
 * flag's argument, not the subcommand). These must be skipped TOGETHER WITH
 * their value when scanning for the `publish` subcommand, otherwise e.g.
 * `npm --prefix dist publish` looks like subcommand `dist`. We treat ANY
 * `--flag=value` (joined) as a single token automatically; this set covers
 * the SPACE-separated value forms.
 */
const VALUE_TAKING_FLAGS = new Set([
  "-C",
  "--prefix",
  "--cwd",
  "--filter",
  "-F",
  "--workspace",
  "--dir",
  "-d",
  "--registry",
  "--tag",
  "--access",
  "--otp",
  "--userconfig",
  "--config",
  // Common GLOBAL value-taking flags across npm/pnpm/yarn. Modeled explicitly
  // so a flag VALUE that happens to collide with a subcommand name is skipped,
  // not mistaken for the subcommand — e.g. `npm --loglevel info publish`
  // (`info` is --loglevel's value, the real subcommand is `publish`).
  "--loglevel",
  "--cache",
  "--globalconfig",
  "--include",
  "--omit",
  "--before",
  "--node-options",
  "--script-shell",
  "--depth",
  "--auth-type",
  "--proxy",
  "--https-proxy",
  "--noproxy",
  "--maxsockets",
  "--fetch-timeout",
  "--fetch-retries",
  "--cafile",
  "--ca",
  "--cert",
  "--key",
  "--user-agent",
  "--store-dir",
  "--store",
  "--modules-dir",
  "--virtual-store-dir",
  "--reporter",
  "--network-concurrency",
  "--child-concurrency",
  "--workspace-concurrency",
  "--resolution-mode",
  "--package-import-method",
  "--filter-prod",
  "--cache-folder",
  "--global-folder",
  "--modules-folder",
  "--preferred-cache-folder",
  "--network-timeout",
  "--mutex",
  "--use-yarnrc",
]);

/**
 * pnpm SUBCOMMAND ALIASES that precede a real subcommand and select a
 * workspace-recursive run (`pnpm recursive publish`, `pnpm multi publish`,
 * `pnpm m publish`). These must be skipped like a flag so the eventual
 * `publish` surfaces. (`-r` / `--recursive` are handled as boolean flags.)
 */
const PNPM_SUBCOMMAND_ALIASES = new Set(["recursive", "multi", "m"]);

/**
 * npm resolves any UNAMBIGUOUS abbreviation of a command, and every prefix of
 * `publish` from `pu` up is unambiguous (no other npm command starts with
 * `pu`). So `npm pu` / `pub` / `publ` / `publi` / `publis` all execute the
 * publish subcommand. We treat any of these prefix tokens as `publish` for ALL
 * managers (conservative; none collide with another npm/pnpm/yarn subcommand).
 */
const PUBLISH_ABBREVIATIONS = new Set([
  "pu", "pub", "publ", "publi", "publis", "publish",
]);

/** A subcommand token that executes (an abbreviation of) `npm publish`. */
function isPublishSubcommand(token) {
  return PUBLISH_ABBREVIATIONS.has(token);
}

/**
 * Known package-manager subcommands that take ARGUMENTS. When the first non-flag
 * token is one of these (not `publish`), a later `publish` token is its argument
 * (e.g. `npm install publish`, a package literally named "publish") and is NOT
 * the publish subcommand. Used to disambiguate the value-flag-ambiguity case:
 * `npm --loglevel verbose publish` has an UNKNOWN first non-flag token
 * (`verbose`, a misparsed flag value) — since it is not a known subcommand we
 * conservatively look downstream for the real `publish` subcommand and flag it.
 */
const KNOWN_SUBCOMMANDS = new Set([
  "install", "i", "isntall", "add", "remove", "rm", "uninstall", "un", "r",
  "update", "up", "upgrade", "view", "v", "info", "show", "config", "c", "set",
  "get", "run", "run-script", "exec", "dlx", "create", "init", "pack", "link",
  "ln", "unlink", "dedupe", "prune", "audit", "test", "t", "tst", "start",
  "stop", "restart", "ci", "cit", "login", "adduser", "logout", "whoami",
  "ping", "search", "s", "se", "find", "outdated", "why", "list", "ls", "la",
  "ll", "store", "fetch", "rebuild", "rb", "deploy", "patch", "patch-commit",
  "owner", "access", "dist-tag", "team", "org", "hook", "token", "profile",
  "star", "unstar", "version", "bin", "root", "prefix", "cache", "doctor",
  "edit", "explore", "fund", "help", "repo", "shrinkwrap", "import", "setup",
  "env", "completion", "docs", "home", "issues", "bugs", "unpublish",
  "deprecate", "undeprecate", "build", "why", "dlx", "use", "remove",
]);

/**
 * Per-manager VALUE-taking short flags whose single letter is ambiguous across
 * managers. `-w` is `--workspace <name>` for npm/yarn (value-taking) but
 * `--workspace-root` for pnpm (BOOLEAN). Listing them per manager lets
 * `npm -w pkg publish` skip `-w pkg` (then sees `publish`) while
 * `pnpm -w publish` skips only `-w` (then sees `publish`). Flags in the shared
 * VALUE_TAKING_FLAGS set are value-taking for ALL managers.
 */
const MANAGER_VALUE_FLAGS_BY_MANAGER = {
  npm: new Set(["-w", "--workspace"]),
  yarn: new Set(["-w", "--workspace"]),
  pnpm: new Set([]), // pnpm `-w`/`--workspace-root` are boolean → not here
  bun: new Set([]),
};

/**
 * Runner shims that may precede the package manager / command and must be
 * stripped before we test the leading command. e.g. `corepack pnpm publish`,
 * `npx npm publish`, `env FOO=bar npm publish`, `sudo npm publish`,
 * `time npm publish`. Each entry is matched as a whole leading token.
 *
 * A shim may also carry OPTION FLAGS that must be stripped along with it so the
 * real command surfaces: `env -i npm publish`, `npx --yes npm publish`,
 * `sudo -E npm publish`, `sudo -u x npm publish`, `time -p npm publish`,
 * `nice -n 10 npm publish`. Some of those flags take a SEPARATE VALUE
 * (`sudo -u <user>`, `nice -n <prio>`) — those are in SHIM_VALUE_FLAGS so the
 * value token is skipped too. Any other flag after a shim is a value-less
 * option, skipped alone.
 */
const RUNNER_SHIMS = new Set([
  "corepack",
  "npx",
  "bunx",
  "sudo",
  "command",
  "env",
  "time",
  "nice",
  "exec",
  "builtin",
  "stdbuf",
  "setsid",
  "doas",
]);

/**
 * Per-shim option flags that consume the FOLLOWING token as their value, so
 * both must be skipped. The mapping is shim-SPECIFIC because the same short
 * flag means different things to different shims — `time -p` is the value-less
 * POSIX-format flag, while `npx -p <pkg>` takes a value. A flag NOT listed for
 * the active shim (and not joined as `--flag=value`) is treated as value-less.
 *
 * NOTE: `env -S`/`--split-string` is INTENTIONALLY omitted here — `-S` does not
 * consume a separate value, it RE-SPLITS a single string argument into a
 * command, which unwrapToInnerCommand recurses into.
 */
const SHIM_VALUE_FLAGS_BY_SHIM = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-r", "-t", "-C", "--user", "--group", "--prompt"]),
  doas: new Set(["-u", "-C", "-a"]),
  nice: new Set(["-n", "--adjustment"]),
  npx: new Set(["-p", "--package", "--userconfig"]),
  bunx: new Set(["-p", "--package"]),
  env: new Set(["-C", "--chdir", "-u", "--unset"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  command: new Set([]),
  corepack: new Set([]),
  time: new Set([]),
  builtin: new Set([]),
  exec: new Set(["-a"]),
  setsid: new Set([]),
};

/**
 * Shell interpreters: a heredoc whose command is one of these (without `-c`)
 * EXECUTES its body, so the body must be scanned. Also the targets of the
 * `<interp> -c "<body>"` string-command form.
 */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Pure-print / no-op command heads whose ARGUMENT text is DATA, not execution.
 * (Their command substitutions are extracted before this point, so a publish
 * hidden in `echo "$(npm publish)"` is still caught.)
 */
const PRINT_HEADS = new Set(["echo", "printf", ":", "true", "false"]);

/**
 * Standalone shell keywords that act as candidate-command BOUNDARIES when they
 * appear as their own token. Splitting on these decomposes compound commands
 * (`if true; then npm publish; fi`, `while false; do npm publish; done`,
 * `for x in 1; do npm publish; done`) into candidates whose head is the real
 * command. We deliberately do NOT split on the OPENING keywords (`if`, `while`,
 * `for`, `until`, `case`, `function`, `select`) — those precede a TEST/loop
 * header, and the candidate AFTER the next `;`/`then`/`do` is what matters; but
 * splitting on the CONTINUATION keywords below isolates the body command.
 */
const SHELL_KEYWORD_BOUNDARIES = new Set([
  "then",
  "do",
  "else",
  "elif",
  "fi",
  "done",
  "in",
]);

/**
 * Strip a directory path and a trailing windows-shim extension from a command
 * head, yielding the BASENAME used for manager/shell detection.
 * `/usr/bin/npm` -> `npm`; `npm.cmd` -> `npm`; `./node_modules/.bin/pnpm` ->
 * `pnpm`. A bare `.` or empty result is returned as-is.
 *
 * @param {string} token
 * @returns {string}
 */
function commandBasename(token) {
  if (token === "" || token === ".") return token;
  let base = token;
  const slash = base.lastIndexOf("/");
  if (slash !== -1) base = base.slice(slash + 1);
  // Windows path separator too (`C:\...\npm.cmd`, `.\node_modules\.bin\npm.cmd`).
  const backslash = base.lastIndexOf("\\");
  if (backslash !== -1) base = base.slice(backslash + 1);
  base = base.replace(/\.(cmd|exe|ps1|bat)$/i, "");
  // Corepack version descriptors: `corepack pnpm@11.1.2 publish` runs
  // `pnpm publish` — normalize `pnpm@<spec>` / `yarn@4` / `npm@latest` to the
  // bare manager so the publish check still fires.
  const corepack = base.match(/^(npm|pnpm|yarn|bun)@\S+$/);
  if (corepack) base = corepack[1];
  return base;
}

/**
 * Tokenize a shell command line into top-level tokens, honoring single and
 * double quotes (so a quoted value with spaces stays one token). Quote
 * characters are stripped from the produced tokens. This is a heuristic
 * tokenizer — it does not implement full POSIX word-splitting — but is
 * sufficient for recognizing command shape.
 *
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  const tokens = [];
  let cur = "";
  let quote = null; // "'" or '"' when inside a quoted run
  let has = false; // whether cur holds anything (even empty quotes)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      // Single quotes are fully literal — backslash is not special.
      if (ch === "'") {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (quote === '"') {
      // Inside double quotes a backslash escapes the next char (treat the next
      // char as literal). This collapses `np\m` / `\npm` quote-splitting.
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    // Unquoted backslash escape: `\x` → literal `x`, NOT a word boundary. This
    // neutralizes `\npm publish` (a backslash-escaped command name suppresses
    // alias expansion but runs `npm` all the same).
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * Split a shell line into CANDIDATE SIMPLE COMMANDS — the conservative core.
 * Splits AGGRESSIVELY on the full boundary set so any shell-grammar wrapper
 * decomposes to a candidate whose tokens begin with the real command:
 *   - operator separators: newline, `;`, `&&`, `||`, `|` (incl. `|&`), `&`
 *   - group/subshell delimiters: `(`, `)`, `{`, `}`
 *   - standalone continuation keywords: then/do/else/elif/fi/done/in
 * Splitting does NOT occur inside single/double quotes (the quote-tracking
 * state below keeps a separator INSIDE quotes from splitting), so a single-
 * quoted argument like `echo 'a; npm publish'` stays ONE candidate (head
 * `echo` → exempt) while the command NAME quotes (`'npm' publish`, `np''m
 * publish`) and `-c`/exec command-string bodies are handled by the tokenizer's
 * quote-stripping + the unwrap recursion downstream. `(npm publish)`,
 * `{ npm publish; }`, `if true; then npm publish; fi`,
 * `while/for ... do npm publish; done`, `! npm publish` all yield a candidate
 * `npm publish`.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCandidates(line) {
  const candidates = [];
  let cur = "";
  let quote = null;
  const push = () => {
    const t = cur.trim();
    if (t.length > 0) candidates.push(t);
    cur = "";
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\n") {
      push();
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      push();
      i++;
      continue;
    }
    // Single-char operator + group separators are boundaries. `(`, `)`, `{`,
    // `}` may abut a token (e.g. `(npm` / `publish)` / `{npm`) so we split on
    // them whether or not they are space-delimited.
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "(" ||
      ch === ")" ||
      ch === "{" ||
      ch === "}"
    ) {
      push();
      continue;
    }
    cur += ch;
  }
  push();

  // Second pass: split each candidate on STANDALONE shell-keyword boundaries
  // (a keyword surrounded by word boundaries, e.g. `then`, `do`, `done`). A
  // keyword glued to other characters (`done_flag`, `doing`) is not a boundary.
  const out = [];
  for (const cand of candidates) {
    const parts = cand
      .split(/\s+/)
      .reduce(
        (acc, word) => {
          if (SHELL_KEYWORD_BOUNDARIES.has(word)) {
            acc.push([]);
          } else {
            acc[acc.length - 1].push(word);
          }
          return acc;
        },
        [[]],
      )
      .map((words) => words.join(" ").trim())
      .filter((s) => s.length > 0);
    for (const p of parts) out.push(p);
  }
  return out;
}

/**
 * Strip a leading pipeline-negation `!`, leading `KEY=value` env assignments,
 * and runner shims so the candidate starts at the real command. Operates on the
 * already-tokenized form, then returns the remaining tokens (for command-shape
 * inspection).
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function stripLeadingShims(tokens) {
  let idx = 0;

  // Leading shell grammar that OPENS a compound command — the command we care
  // about follows it: `! npm publish` (negation), `if npm publish; then …`,
  // `while ! npm publish; do …`, `until npm publish`, `elif npm publish`.
  // (`then`/`do`/`else` are split boundaries, included here defensively.)
  const LEADING_KEYWORDS = new Set([
    "!", "if", "while", "until", "elif", "then", "do", "else", "{",
  ]);
  while (idx < tokens.length && LEADING_KEYWORDS.has(tokens[idx])) idx++;

  while (idx < tokens.length) {
    const t = tokens[idx];
    // Leading / inter-shim env assignment: NAME=...  (value may be empty).
    // `env NODE_ENV=production npm publish` puts the assignment AFTER `env`.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      idx++;
      continue;
    }
    // A bare `!` re-encountered (e.g. between shims) is a negation token.
    if (t === "!") {
      idx++;
      continue;
    }
    const base = commandBasename(t);
    if (RUNNER_SHIMS.has(base)) {
      idx++;
      // Strip the shim's own OPTION FLAGS (and any value they consume) so the
      // real command surfaces: `env -i`, `npx --yes`, `sudo -E`, `sudo -u x`,
      // `time -p`, `nice -n 10`. Stop at the first bare token (the next shim or
      // the real command head). Value-taking flags are shim-SPECIFIC (see
      // SHIM_VALUE_FLAGS_BY_SHIM) so `time -p` (value-less) and `npx -p pkg`
      // (value-taking) are disambiguated.
      const valueFlags = SHIM_VALUE_FLAGS_BY_SHIM[base] || new Set();
      while (idx < tokens.length) {
        const f = tokens[idx];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(f)) {
          // assignment between shim and command (e.g. after `env`)
          idx++;
          continue;
        }
        if (!f.startsWith("-")) break;
        // `--flag=value` joined → single skip.
        if (f.includes("=")) {
          idx++;
          continue;
        }
        // Known value-taking shim flag → skip the flag AND its value.
        if (valueFlags.has(f)) {
          idx += 2;
          continue;
        }
        // Value-less option flag → skip just it.
        idx++;
      }
      continue;
    }
    // `pnpm dlx` two-token shim.
    if (commandBasename(t) === "pnpm" && tokens[idx + 1] === "dlx") {
      idx += 2;
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

/**
 * Given tokens whose head BASENAME is a package manager, return true if the
 * eventual SUBCOMMAND is `publish`, skipping manager flags and pnpm subcommand
 * aliases. A `--flag=value` joined token is a single skip; a space-separated
 * value-taking flag (`--prefix dist`) skips the following token too. The FIRST
 * non-flag, non-alias token is the subcommand: it must equal `publish`.
 *
 * Crucially, `npm run publish` / `npm run-script publish` are SCRIPT runs, not
 * the publish subcommand — when the first non-flag token is `run`/`run-script`
 * we do NOT treat the following `publish` as the banned subcommand (so
 * `npm run publish-docs` and `npm run publish` are both allowed).
 *
 * Also handles yarn berry's `yarn npm publish`: when the manager is `yarn` and
 * the first non-flag token is `npm`, the NEXT token must be `publish`.
 *
 * @param {string[]} tokens - tokens whose head is a package-manager basename
 * @returns {boolean}
 */
function managerPublishesSubcommand(tokens) {
  const manager = commandBasename(tokens[0] || "");
  if (!PACKAGE_MANAGERS.includes(manager)) return false;
  const managerValueFlags =
    MANAGER_VALUE_FLAGS_BY_MANAGER[manager] || new Set();
  const isPnpm = manager === "pnpm";
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      // Joined `--flag=value` is one token → skip it alone.
      if (t.includes("=")) {
        i++;
        continue;
      }
      // Space-separated value-taking flag → skip the flag AND its value.
      // `-w` is value-taking for npm/yarn (`--workspace <name>`) but BOOLEAN
      // for pnpm (`--workspace-root`), so consult the per-manager set too.
      if (VALUE_TAKING_FLAGS.has(t) || managerValueFlags.has(t)) {
        i += 2;
        continue;
      }
      // Bare boolean flag (incl. pnpm `-r`/`--recursive`) → skip just it.
      i++;
      continue;
    }
    // pnpm subcommand aliases (`recursive`/`multi`/`m`) precede the real
    // subcommand → skip and keep scanning.
    if (isPnpm && PNPM_SUBCOMMAND_ALIASES.has(t)) {
      i++;
      continue;
    }
    // First non-flag token = the subcommand candidate.
    if (isPublishSubcommand(t)) return true;
    // `npm run publish` / `npm run-script publish` are SCRIPT runs, not the
    // publish subcommand → NOT banned (avoids a false positive on
    // `npm run publish-docs`).
    if (t === "run" || t === "run-script") return false;
    // yarn berry: `yarn npm publish`.
    if (manager === "yarn" && t === "npm") {
      // Skip flags between `npm` and `publish` too.
      let j = i + 1;
      while (j < tokens.length && tokens[j].startsWith("-")) j++;
      return j < tokens.length && isPublishSubcommand(tokens[j]);
    }
    // First non-flag token is a KNOWN subcommand (not publish) → a later
    // `publish` is its argument (`npm install publish`) → not banned.
    if (KNOWN_SUBCOMMANDS.has(t)) return false;
    // First non-flag token is UNKNOWN — almost always a misparsed value of a
    // global flag whose value-taking-ness we don't model (e.g.
    // `npm --loglevel verbose publish`, where `verbose` is `--loglevel`'s
    // value). Conservatively scan downstream: if the real `publish` subcommand
    // surfaces before any script-run or known subcommand, flag it.
    for (let k = i + 1; k < tokens.length; k++) {
      const u = tokens[k];
      if (u.startsWith("-")) continue;
      if (isPublishSubcommand(u)) return true;
      if (u === "run" || u === "run-script") return false;
      if (KNOWN_SUBCOMMANDS.has(u)) return false;
      // Another unknown token (another flag value) → keep scanning.
    }
    return false;
  }
  return false;
}

/**
 * Detect a curl command that PUTs / uploads to a verdaccio / registry.cinatra
 * URL — a raw publish that bypasses the package managers entirely. The head
 * BASENAME must be `curl` (so `/usr/bin/curl`, `curl.exe` count); an
 * upload/PUT verb (`-X`/`--request` PUT|POST, joined `-XPUT`/`--request=PUT`,
 * `-T`/`--upload-file`, joined `-Tfile`/`--upload-file=file`) must be present;
 * and a verdaccio/registry.cinatra URL must appear anywhere in the candidate.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isCurlRegistryPublish(tokens) {
  if (commandBasename(tokens[0] || "") !== "curl") return false;
  const joined = tokens.join(" ");
  if (!CINATRA_REGISTRY_HINT_RE.test(joined)) return false;
  // An upload/PUT verb is what makes it a publish (vs. a GET probe).
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-T" || t === "--upload-file") return true;
    if ((t === "-X" || t === "--request") && /^(PUT|POST)$/i.test(tokens[i + 1] || ""))
      return true;
    if (/^--request=(PUT|POST)$/i.test(t)) return true;
    if (/^--upload-file=./i.test(t)) return true;
    if (/^-X(PUT|POST)$/i.test(t)) return true;
    // Joined short upload flag `-Tbundle.tgz` (value glued to -T).
    if (/^-T.+$/.test(t)) return true;
  }
  return false;
}

/**
 * Is `t` a SHORT-flag cluster (single leading `-`, not `--`) whose combined
 * letters include `c`? e.g. `-c`, `-lc`, `-lic`, `-ec`, `-xc`. Used to detect
 * a shell command-string flag even when bundled with `-l`/`-i`/`-e`/`-x`.
 *
 * @param {string} t
 * @returns {boolean}
 */
function isShortFlagClusterWithC(t) {
  if (!t.startsWith("-") || t.startsWith("--")) return false;
  const letters = t.slice(1);
  // Only treat it as a flag cluster if it is purely short-flag letters
  // (no `=`, no embedded value) and contains `c`.
  return /^[A-Za-z]+$/.test(letters) && letters.includes("c");
}

/**
 * Extract an inner command STRING from a wrapper whose quoted argument is a
 * command body, so the inner command can be scanned recursively. Returns the
 * inner string, or null if this candidate is not such a wrapper.
 *
 * Recognized wrappers (after shim-stripping):
 *   bash -c "<body>" | sh -c '<body>' | zsh -lc "<body>"  (shell -c clusters)
 *   env -S '<cmd>'   | env --split-string='<cmd>'         (env split-string)
 *   npm  exec [--] <body>            (npm exec -- npm publish)
 *   pnpm exec <body>                 (pnpm exec npm publish)
 *   npm  exec --call '<body>'        (explicit shell body)
 *   npx  -c '<body>' | npx --call '<body>'  (npx command string)
 *
 * @param {string[]} tokens - shim-stripped tokens
 * @returns {string|null}
 */
function unwrapToInnerCommand(tokens) {
  if (tokens.length === 0) return null;
  const head = commandBasename(tokens[0]);

  // Shell interpreter `-c "<body>"`. The `-c` may be combined with other short
  // flags in a single cluster (`-lc`, `-lic`, `-ec`) — ANY short-flag token
  // whose letters include `c` introduces a command-string argument. The first
  // non-flag token AFTER that cluster is the command body.
  if (SHELL_INTERPRETERS.has(head)) {
    let ci = -1;
    // Shell options that consume a SEPARATE value word, so the value is not the
    // command body: `-o pipefail` / `+o pipefail` / `-O shopt`, and a short
    // cluster ENDING in `o`/`O` (`-euo pipefail`). Also the rcfile loaders.
    const SHELL_VALUE_FLAGS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
    for (let k = 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (isShortFlagClusterWithC(t)) {
        ci = k;
        break;
      }
      // A value-taking shell option consumes the FOLLOWING token (its value);
      // skip both so e.g. `bash -o pipefail -c '<body>'` still finds `-c`.
      const clusterTakesValue =
        /^-[A-Za-z]*[oO]$/.test(t) || SHELL_VALUE_FLAGS.has(t);
      if (clusterTakesValue && !t.includes("=")) {
        k++; // skip the option's value word
        continue;
      }
      // A value-less long flag (`--login`/`--norc`) or short flag → keep scanning.
      if (t.startsWith("-")) continue;
      // A non-flag, non-value token means this is `bash <script>` (no `-c`).
      break;
    }
    if (ci !== -1) {
      // Skip any remaining flag tokens between the cluster and the body
      // (`bash -l -c "..."` → body after the value-less flags).
      let b = ci + 1;
      while (b < tokens.length && tokens[b].startsWith("-")) b++;
      if (b < tokens.length) return tokens.slice(b).join(" ");
    }
    return null;
  }

  // PowerShell (`pwsh`/`powershell`): `-Command`/`-c "<body>"` runs a command
  // string (other flags like -NoProfile / -ExecutionPolicy <val> are ignored —
  // we only need the `-Command` body). `-EncodedCommand <base64>` is a
  // documented decoded-command limitation.
  if (head === "pwsh" || head === "powershell") {
    for (let k = 1; k < tokens.length; k++) {
      if (/^-c(ommand)?$/i.test(tokens[k]) && k + 1 < tokens.length) {
        return tokens.slice(k + 1).join(" ");
      }
    }
    return null;
  }
  // Windows `cmd` / `cmd.exe`: `/c` or `/C` introduces the command; the rest is
  // it (other switches like `/S` `/Q` `/V` precede it). The body may be a
  // SEPARATE token (`/c npm publish`) or GLUED (`/c"npm publish"`, which the
  // quote-aware tokenizer yields as `/cnpm publish`).
  if (head === "cmd") {
    for (let k = 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (/^\/c$/i.test(t) && k + 1 < tokens.length) {
        return tokens.slice(k + 1).join(" ");
      }
      const glued = /^\/c(.+)$/i.exec(t);
      if (glued) {
        return [glued[1], ...tokens.slice(k + 1)].join(" ");
      }
    }
    return null;
  }

  // `npm exec` / `npm x` (alias) / `pnpm exec` / … — including when MANAGER
  // GLOBAL FLAGS precede the subcommand (`pnpm --filter foo exec npm publish`,
  // `npm --prefix dist exec -- npm publish`). Find the exec/x subcommand index
  // by skipping the manager's global flags (+ their space-separated values) and
  // pnpm subcommand-aliases first.
  if (PACKAGE_MANAGERS.includes(head)) {
    const managerValueFlags = MANAGER_VALUE_FLAGS_BY_MANAGER[head] || new Set();
    let xi = 1;
    while (xi < tokens.length && tokens[xi].startsWith("-")) {
      const t = tokens[xi];
      if (t.includes("=")) {
        xi++;
        continue;
      }
      if (VALUE_TAKING_FLAGS.has(t) || managerValueFlags.has(t)) {
        xi += 2;
        continue;
      }
      xi++;
    }
    while (
      xi < tokens.length &&
      head === "pnpm" &&
      PNPM_SUBCOMMAND_ALIASES.has(tokens[xi])
    ) {
      xi++;
    }
    if (tokens[xi] === "exec" || tokens[xi] === "x") {
      // `--call`/`-c` command string (separate or joined) anywhere after exec.
      for (let k = xi + 1; k < tokens.length; k++) {
        const t = tokens[k];
        const joined = /^(?:--call|-c)=([\s\S]*)$/.exec(t);
        if (joined) return joined[1];
        if ((t === "--call" || t === "-c") && k + 1 < tokens.length) {
          return tokens.slice(k + 1).join(" ");
        }
      }
      // `exec [flags] [--] <cmd...>` — skip exec flags AND their space-separated
      // VALUES (`--package foo`, `-p foo`, `--userconfig x`) so the command body
      // (`npm publish`) surfaces.
      const EXEC_VALUE_FLAGS = new Set(["--package", "-p", "--userconfig", "-w", "--workspace"]);
      let start = xi + 1;
      while (start < tokens.length && tokens[start].startsWith("-")) {
        if (tokens[start] === "--") {
          start++;
          break;
        }
        const valueFlag = EXEC_VALUE_FLAGS.has(tokens[start]) && !tokens[start].includes("=");
        start++;
        if (valueFlag && start < tokens.length) start++;
      }
      if (start < tokens.length) return tokens.slice(start).join(" ");
      return null;
    }
  }

  return null;
}

/**
 * If a candidate is an `env -S '<cmd>'` / `env --split-string='<cmd>'` form,
 * return the inner command string. `env -S` re-splits its single string
 * argument into a command line and runs it, so a publish inside it executes.
 * Handled separately from stripLeadingShims because `-S` does NOT consume the
 * next token as a value — it consumes the REST as a command body to recurse.
 *
 * Note: this operates on the RAW (pre-shim-strip) tokens of a candidate so the
 * `env` head is still present.
 *
 * @param {string[]} rawTokens
 * @returns {string|null}
 */
function unwrapEnvSplitString(rawTokens) {
  let i = 0;
  // Allow leading env-assignments before `env` itself is unusual, but tolerate.
  while (i < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[i])) i++;
  if (commandBasename(rawTokens[i] || "") !== "env") return null;
  i++;
  // Scan env's args for -S / --split-string (joined `--split-string=...` too).
  while (i < rawTokens.length) {
    const t = rawTokens[i];
    if (t === "-S" || t === "--split-string") {
      // The body is the remaining tokens joined (env -S 'npm publish').
      if (i + 1 < rawTokens.length) return rawTokens.slice(i + 1).join(" ");
      return null;
    }
    if (t.startsWith("--split-string=")) {
      return t.slice("--split-string=".length);
    }
    // Attached short form `-S'npm publish'` → tokenizer yields `-Snpm publish`.
    const gluedS = /^-S(.+)$/.exec(t);
    if (gluedS) {
      return [gluedS[1], ...rawTokens.slice(i + 1)].join(" ");
    }
    // env -uVAR / env VAR=val / other flags before the command: keep scanning.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      i++;
      continue;
    }
    // Reached env's command without an -S → not a split-string form.
    return null;
  }
  return null;
}

/**
 * `npx -c '<cmd>'` / `npx --call '<cmd>'` (and `bunx`) execute the string as a
 * shell command, so a publish inside it runs. Detected on the RAW (pre-shim-
 * strip) tokens because `npx`/`bunx` are runner shims that stripLeadingShims
 * would otherwise consume — dropping the `-c`/`--call` body. Tolerates leading
 * env-assignments + one or more non-npx leading shims (`sudo npx -c …`,
 * `env FOO=bar npx --call …`). Returns null for plain `npx npm publish` (no
 * `-c`/`--call`) so the normal shim-strip path handles that.
 *
 * @param {string[]} rawTokens
 * @returns {string|null}
 */
function unwrapNpxCommandString(rawTokens) {
  let i = 0;
  while (i < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[i])) i++;
  // Skip non-npx leading runner shims (+ their value flags) so `sudo npx -c …`
  // and `corepack npx --call …` still resolve to the npx head.
  while (i < rawTokens.length) {
    const sh = commandBasename(rawTokens[i]);
    if (sh === "npx" || sh === "bunx" || !RUNNER_SHIMS.has(sh)) break;
    i++;
    const vf = SHIM_VALUE_FLAGS_BY_SHIM[sh] || new Set();
    // Skip the shim's option flags (+ their values) AND any env-assignment args
    // (`env FOO=bar npx …`) before the next command head.
    while (
      i < rawTokens.length &&
      (rawTokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[i]))
    ) {
      const f = rawTokens[i];
      i++;
      if (vf.has(f)) i++;
    }
  }
  const base = commandBasename(rawTokens[i] || "");
  if (base !== "npx" && base !== "bunx") return null;
  i++;
  const npxValueFlags = SHIM_VALUE_FLAGS_BY_SHIM[base] || new Set();
  while (i < rawTokens.length) {
    const t = rawTokens[i];
    if (t === "-c" || t === "--call") {
      return i + 1 < rawTokens.length ? rawTokens.slice(i + 1).join(" ") : null;
    }
    const m = /^--call=([\s\S]*)$/.exec(t);
    if (m) return m[1];
    if (t.startsWith("-")) {
      i++;
      if (npxValueFlags.has(t)) i++;
      continue;
    }
    // First non-flag token that is not -c/--call → npx is running a command
    // directly (`npx npm publish`); let stripLeadingShims handle it.
    return null;
  }
  return null;
}

/**
 * Strip an inline shell comment (` #…` to end-of-line) that begins OUTSIDE any
 * single/double quote and outside a `$(...)`/backtick command substitution. A
 * `#` not preceded by whitespace (e.g. `foo#bar`, a URL fragment) does NOT
 * start a comment in POSIX shell, so we only treat `#` as a comment when it's
 * at the start of the line or preceded by an unquoted space/tab. Quoted `#`,
 * and `#` inside `$(...)`/backticks, are preserved verbatim.
 *
 * @param {string} line
 * @returns {string}
 */
function stripInlineShellComment(line) {
  let quote = null; // "'" or '"'
  let parenDepth = 0; // inside $(...)
  let inBacktick = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "$" && line[i + 1] === "(") {
      parenDepth++;
      i++;
      continue;
    }
    if (parenDepth > 0) {
      if (ch === ")") parenDepth--;
      continue;
    }
    // Outside all quotes/substitutions: a `#` that starts a word is a comment.
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line;
}

/**
 * Find every top-level command-substitution body in `s` — `$(...)` and
 * backtick `…` — that is NOT inside single quotes (single-quoted text is
 * literal, so a `$(...)` there is never executed). Double-quoted substitutions
 * ARE executed, so we DO descend into double quotes. Nested `$( $(...) )` is
 * handled via paren depth; the OUTERMOST body is returned (recursion in the
 * caller re-extracts any inner ones). Backtick bodies do not nest.
 *
 * @param {string} s
 * @returns {string[]} extracted substitution bodies (without the wrappers)
 */
function extractCommandSubstitutions(s) {
  const bodies = [];
  let squote = false; // single quote: literal, do NOT extract
  let dquote = false; // double quote: substitutions still execute
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (squote) {
      if (ch === "'") squote = false;
      continue;
    }
    if (ch === "'" && !dquote) {
      squote = true;
      continue;
    }
    if (ch === '"') {
      dquote = !dquote;
      continue;
    }
    // `$(...)` — capture the balanced body.
    if (ch === "$" && s[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      // Track quotes WITHIN the substitution so a `)` inside a quoted string
      // doesn't prematurely close it.
      let sq = false;
      let dq = false;
      for (; j < s.length && depth > 0; j++) {
        const c = s[j];
        if (sq) {
          if (c === "'") sq = false;
          continue;
        }
        if (dq) {
          if (c === '"') dq = false;
          continue;
        }
        if (c === "'") sq = true;
        else if (c === '"') dq = true;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      if (depth === 0) {
        bodies.push(s.slice(i + 2, j - 1));
        i = j - 1;
      }
      continue;
    }
    // Backtick `...` — capture up to the next unescaped backtick.
    if (ch === "`") {
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "`" && s[j - 1] !== "\\") break;
      }
      if (j < s.length) {
        bodies.push(s.slice(i + 1, j));
        i = j;
      }
      continue;
    }
  }
  return bodies;
}

/**
 * Does this candidate (its remaining shim-stripped tokens) invoke a publish?
 * Recurses into `-c`/exec/env-S command STRINGS. Returns the banned/registry
 * verdict for the single candidate.
 *
 * @param {string} candidate - one candidate simple command (quotes intact)
 * @param {number} depth
 * @returns {{ banned: boolean, registryHint: boolean }}
 */
function candidateExecutesPublish(candidate, depth) {
  if (depth > 8) return { banned: false, registryHint: false };
  const rawTokens = tokenize(candidate);
  if (rawTokens.length === 0) return { banned: false, registryHint: false };

  // `env -S '<cmd>'` re-splits a string into a command → recurse into it.
  const envBody = unwrapEnvSplitString(rawTokens);
  if (envBody !== null) {
    const nested = analyzeExecLine(envBody, depth + 1);
    if (nested.banned) {
      return {
        banned: true,
        registryHint:
          nested.registryHint || CINATRA_REGISTRY_HINT_RE.test(candidate),
      };
    }
    return { banned: false, registryHint: false };
  }

  // `npx -c '<cmd>'` / `npx --call '<cmd>'` run the string as a command →
  // recurse (must run BEFORE stripLeadingShims consumes the `npx` head).
  const npxBody = unwrapNpxCommandString(rawTokens);
  if (npxBody !== null) {
    const nested = analyzeExecLine(npxBody, depth + 1);
    if (nested.banned) {
      return {
        banned: true,
        registryHint:
          nested.registryHint || CINATRA_REGISTRY_HINT_RE.test(candidate),
      };
    }
    return { banned: false, registryHint: false };
  }

  const tokens = stripLeadingShims(rawTokens);
  if (tokens.length === 0) return { banned: false, registryHint: false };

  // A leading pure-print / no-op head means this candidate's args are DATA
  // (its command substitutions were already extracted upstream).
  const head = commandBasename(tokens[0]);
  if (PRINT_HEADS.has(head)) return { banned: false, registryHint: false };

  // Unwrap shell `-c` / exec / npx command STRINGS and recurse into them.
  const inner = unwrapToInnerCommand(tokens);
  if (inner !== null) {
    const nested = analyzeExecLine(inner, depth + 1);
    if (nested.banned) {
      return {
        banned: true,
        registryHint:
          nested.registryHint || CINATRA_REGISTRY_HINT_RE.test(candidate),
      };
    }
    return { banned: false, registryHint: false };
  }

  if (managerPublishesSubcommand(tokens) || isCurlRegistryPublish(tokens)) {
    return {
      banned: true,
      registryHint: CINATRA_REGISTRY_HINT_RE.test(candidate),
    };
  }
  return { banned: false, registryHint: false };
}

/**
 * Recurse into every command-substitution body (`$(...)`, backticks) reachable
 * from `line` and return whether ANY of them executes a publish. A substitution
 * is EXECUTED for its side effect even when its stdout is only printed/captured
 * (`echo "$(npm publish)"`, `OUT=$(npm publish)`), so this runs BEFORE the
 * candidate splitting (which would otherwise blank single-quoted regions but a
 * double-quoted `"$(npm publish)"` survives). Single-quoted text is literal and
 * is skipped by extractCommandSubstitutions.
 *
 * @param {string} line
 * @param {number} depth
 * @returns {{ banned: boolean, registryHint: boolean }}
 */
function substitutionsExecutePublish(line, depth) {
  if (depth > 8) return { banned: false, registryHint: false };
  for (const body of extractCommandSubstitutions(line)) {
    // The body is itself a command line — analyze it as one (it may further
    // contain candidates, wrappers, and nested substitutions).
    const found = analyzeExecLine(body, depth + 1);
    if (found.banned) {
      return {
        banned: true,
        registryHint: found.registryHint || CINATRA_REGISTRY_HINT_RE.test(body),
      };
    }
  }
  return { banned: false, registryHint: false };
}

/**
 * Analyze a single executed logical command line — the CONSERVATIVE pipeline:
 *   1. strip an inline shell comment;
 *   2. extract + recurse into command substitutions (they execute even inside
 *      echo/printf/VAR= contexts);
 *   3. split AGGRESSIVELY into candidate simple commands (quote-aware, so a
 *      separator inside a single-/double-quoted argument does NOT split);
 *   4. per candidate: strip wrappers, recurse into command strings, flag a
 *      manager+publish adjacency or curl-upload signal. A candidate whose head
 *      basename is a pure-print command (echo/printf/:/true/false) is exempt —
 *      its quoted/literal arguments are data, never an execution.
 *
 * @param {string} execLine
 * @param {number} [depth=0] - recursion guard shared with substitution descent
 * @returns {{ banned: boolean, registryHint: boolean }}
 */
function analyzeExecLine(execLine, depth = 0) {
  if (depth > 8) return { banned: false, registryHint: false };
  const line = stripInlineShellComment(execLine);

  // A publish hidden inside ANY command substitution is a real execution, even
  // when the surrounding command is a pure print or a VAR= assignment. Run this
  // on the ORIGINAL (single-quote-bearing) line so the extractor can correctly
  // skip single-quoted (literal) substitutions and descend double-quoted ones.
  const subst = substitutionsExecutePublish(line, depth);
  if (subst.banned) return subst;

  // Split into candidate simple commands. splitCandidates is quote-aware, so a
  // separator inside `echo 'a; npm publish'` does not split it out of the echo
  // candidate; the tokenizer then strips the quote chars so a single-quoted
  // command NAME (`'npm'`, `np''m`) and a single-quoted `-c`/exec body are
  // still recognized by the downstream unwrap + manager detection.
  for (const candidate of splitCandidates(line)) {
    const found = candidateExecutesPublish(candidate, depth);
    if (found.banned) {
      return {
        banned: found.banned,
        registryHint: found.registryHint || CINATRA_REGISTRY_HINT_RE.test(line),
      };
    }
  }
  return { banned: false, registryHint: false };
}

/**
 * Decide whether a heredoc opener's body is EXECUTED (a shell interpreter reads
 * it as a script) or is DATA (cat/tee/grep/etc. consume it).
 *
 * @param {string} openerLine - the line containing the `<<DELIM`
 * @returns {boolean} true if the heredoc body should be scanned as executed
 */
function heredocBodyIsExecuted(openerLine) {
  const tokens = stripLeadingShims(tokenize(openerLine));
  if (tokens.length === 0) return false;
  const head = commandBasename(tokens[0]);
  if (!SHELL_INTERPRETERS.has(head)) return false;
  // `bash -c ...` consumes -c, not the heredoc, as its program → not exec body.
  if (tokens.includes("-c")) return false;
  return true;
}

/**
 * Join backslash line-continuations within a list of physical body lines into
 * logical command lines. A line ending in an unescaped trailing `\` continues
 * onto the next line (the backslash + newline are replaced by a single space).
 * Comment lines and blank lines break continuation runs naturally because a
 * `\` only continues when present.
 *
 * @param {string[]} physical
 * @returns {Array<{ text: string, line: number }>} logical lines with the
 *   1-based source line number of their FIRST physical line.
 */
function joinBackslashContinuations(physical) {
  const out = [];
  let buf = null;
  let startLine = 0;
  for (const { text, line } of physical) {
    const stripped = text.replace(/\s+$/, "");
    const continues = /(^|[^\\])\\$/.test(stripped) || stripped === "\\";
    if (buf === null) {
      startLine = line;
      buf = stripped.replace(/\\$/, " ");
    } else {
      buf += stripped.replace(/\\$/, " ");
    }
    if (continues) {
      // keep accumulating
    } else {
      out.push({ text: buf, line: startLine });
      buf = null;
    }
  }
  if (buf !== null) out.push({ text: buf, line: startLine });
  return out;
}

/**
 * Analyze the body of a single run step. `bodyLines` are { text, line } pairs
 * (text already has the block-scalar base indentation removed if literal, or is
 * already space-joined if folded).
 *
 * @param {Array<{ text: string, line: number }>} bodyLines
 * @returns {Array<{ line: number, content: string, registryHint: boolean }>}
 */
function analyzeRunBody(bodyLines) {
  const offenders = [];
  let heredocDelim = null;
  let heredocExecuted = false;

  const logical = joinBackslashContinuations(bodyLines);

  for (const { text, line } of logical) {
    const trimmed = text.trim();

    if (heredocDelim !== null) {
      if (trimmed === heredocDelim) {
        heredocDelim = null;
        heredocExecuted = false;
        continue;
      }
      if (heredocExecuted) {
        if (trimmed.startsWith("#")) continue;
        const found = analyzeExecLine(trimmed);
        if (found.banned) {
          offenders.push({ line, content: trimmed, registryHint: found.registryHint });
        }
      }
      continue;
    }

    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;

    // Heredoc opener? Strip an optional quoted-delim and record the delimiter.
    const heredocMatch = trimmed.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredocMatch) {
      heredocDelim = heredocMatch[1];
      heredocExecuted = heredocBodyIsExecuted(trimmed);
      // The opener line itself can also execute a publish before the `<<`.
      const beforeHeredoc = trimmed.slice(0, trimmed.indexOf("<<"));
      const found = analyzeExecLine(beforeHeredoc);
      if (found.banned) {
        offenders.push({ line, content: trimmed, registryHint: found.registryHint });
      }
      continue;
    }

    const found = analyzeExecLine(trimmed);
    if (found.banned) {
      offenders.push({ line, content: trimmed, registryHint: found.registryHint });
    }
  }

  return offenders;
}

/**
 * Skip a YAML anchor (`&name`), tag (`!!str`, `!<...>`, `!foo`), and
 * surrounding spaces at the START of a `run:` value, returning the remaining
 * value text. e.g. `&cmd npm publish` -> `npm publish`; `!!str |` -> `|`;
 * `!<tag:x> echo hi` -> `echo hi`.
 *
 * @param {string} s - the trimmed text AFTER the `run:` key
 * @returns {string}
 */
function skipYamlAnchorAndTag(s) {
  let rest = s;
  // Repeatedly strip a leading anchor or tag (either order, e.g. `&a !!str`).
  for (let guard = 0; guard < 4; guard++) {
    const before = rest;
    rest = rest.replace(/^\s+/, "");
    // Anchor `&name`.
    const anchor = rest.match(/^&[A-Za-z0-9_-]+\s*/);
    if (anchor) {
      rest = rest.slice(anchor[0].length);
      continue;
    }
    // Tag: `!!str`, `!<tag:...>`, `!foo`.
    const tag = rest.match(/^(?:!!?[A-Za-z0-9_-]+|!<[^>]*>)\s*/);
    if (tag) {
      rest = rest.slice(tag[0].length);
      continue;
    }
    if (rest === before) break;
  }
  return rest;
}

/**
 * Collect YAML scalar/block anchors (`key: &name <value>` / `- &name <value>`)
 * so a `run: *name` ALIAS can be resolved to the anchored command before
 * analysis (GitHub Actions supports YAML anchors/aliases). Only anchors that
 * follow a mapping-value `:` or a sequence `- ` are collected, so a shell `&`
 * (`cmd &`, `a && b`) is never mistaken for an anchor.
 *
 * @param {string[]} lines
 * @returns {Map<string, {inline?: string, body?: string[]}>}
 */
function collectAnchors(lines) {
  const map = new Map();
  const indentOf = (s) => s.length - s.replace(/^\s+/, "").length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /(?::[ \t]+|^[ \t]*-[ \t]+)&([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/,
    );
    if (!m) continue;
    const name = m[1];
    const rest = (m[2] || "").trim();
    const blockMatch = rest.match(/^([|>])(?:[+-]?\d*|\d*[+-]?)\s*(?:#.*)?$/);
    if (rest === "" || blockMatch) {
      // Block-scalar anchor (`&name |`) → collect the indented body.
      const keyIndent = indentOf(lines[i]);
      const body = [];
      let bodyIndent = null;
      for (let j = i + 1; j < lines.length; j++) {
        const bl = lines[j];
        if (bl.trim().length === 0) {
          body.push("");
          continue;
        }
        const ind = indentOf(bl);
        if (ind <= keyIndent) break;
        if (bodyIndent === null) bodyIndent = ind;
        body.push(bl.slice(bodyIndent));
      }
      map.set(name, { body });
    } else {
      map.set(name, { inline: rest });
    }
  }
  return map;
}

/**
 * Scan one YAML file's text (workflow OR composite action) for an EXECUTED
 * publish command. Extracts every `run:` step body (inline quoted/plain,
 * literal `|`, folded `>`, plain multi-line scalar, and `*alias` references to
 * a `&anchor`ed command), then analyzes each.
 *
 * @param {string} text
 * @returns {Array<{ line: number, content: string, registryHint: boolean }>}
 */
export function scanWorkflowText(text) {
  const lines = text.split("\n");
  const offenders = [];
  const anchors = collectAnchors(lines);
  const indentOf = (s) => s.length - s.replace(/^\s+/, "").length;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Flow-style step map: `- { name: Publish, run: npm publish … }`. A `run:`
    // key preceded by `{` or `,` is a flow-mapping entry; its value runs to the
    // next UNQUOTED `,` or `}` (a `,`/`}` inside a quoted scalar is part of the
    // value). (A block-style `run:` at line start is NOT preceded by `{`/`,`, so
    // no double-count.)
    const flowKeyRe = /[{,]\s*(?:run|"run"|'run')\s*:\s*/g;
    let fm;
    while ((fm = flowKeyRe.exec(raw)) !== null) {
      let j = fm.index + fm[0].length;
      let inQ = null;
      let val = "";
      for (; j < raw.length; j++) {
        const ch = raw[j];
        if (inQ) {
          if (inQ === '"' && ch === "\\" && j + 1 < raw.length) {
            val += ch + raw[j + 1];
            j++;
            continue;
          }
          if (ch === inQ) {
            if (inQ === "'" && raw[j + 1] === "'") {
              val += "''";
              j++;
              continue;
            }
            inQ = null;
          }
          val += ch;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inQ = ch;
          val += ch;
          continue;
        }
        if (ch === "," || ch === "}") break;
        val += ch;
      }
      const v = unquoteInline(val.trim());
      if (v.length > 0) {
        const found = analyzeExecLine(v);
        if (found.banned) {
          offenders.push({ line: i + 1, content: val.trim(), registryHint: found.registryHint });
        }
      }
      flowKeyRe.lastIndex = Math.max(flowKeyRe.lastIndex, j);
    }

    // Tolerant run-key match: `run:` / `"run":` / `'run':`, optional `-` list
    // marker, spaces around the colon. Captures the leading indent and the
    // value text after the colon.
    const runKeyMatch = raw.match(
      /^(\s*)(?:-\s+)?(?:run|"run"|'run')\s*:\s?(.*)$/,
    );
    if (!runKeyMatch) continue;

    const keyIndent = indentOf(raw);
    // Skip a YAML anchor/tag immediately after the key.
    const afterRun = skipYamlAnchorAndTag(runKeyMatch[2]);
    // A value that is ONLY a trailing YAML comment (`run: # comment` then an
    // indented body) means the scalar is empty here — treat it as empty so we
    // fall through to the plain multi-line scalar collection instead of
    // analyzing the comment as an inline value.
    const afterTrim = afterRun.trim().startsWith("#") ? "" : afterRun.trim();

    // Block scalar indicator (`|`, `>`, with optional chomping/indent digit).
    // A trailing `# comment` after the indicator is legal YAML and must NOT
    // make us fall through to the inline path — the indented body below still
    // needs scanning. Indent + chomp indicators may appear in either order
    // (`|2-`, `|-2`, `>+8`).
    const blockMatch = afterTrim.match(
      /^([|>])(?:[+-]?\d*|\d*[+-]?)\s*(?:#.*)?$/,
    );
    if (blockMatch) {
      const folded = blockMatch[1] === ">";
      // Collect body lines: more-indented than the run key, until a line at or
      // below keyIndent breaks out (blank lines are kept as body).
      const body = [];
      let j = i + 1;
      let bodyIndent = null;
      for (; j < lines.length; j++) {
        const bl = lines[j];
        if (bl.trim().length === 0) {
          body.push({ text: "", line: j + 1 });
          continue;
        }
        const ind = indentOf(bl);
        if (ind <= keyIndent) break;
        if (bodyIndent === null) bodyIndent = ind;
        body.push({ text: bl.slice(bodyIndent), line: j + 1 });
      }
      i = j - 1;

      let bodyForAnalysis = body;
      if (folded) {
        // Folded scalar: consecutive non-blank lines join with a single space
        // (a blank line is a paragraph break). Map back to the first physical
        // line of each joined run so offender line numbers stay meaningful.
        bodyForAnalysis = foldBody(body);
      }
      for (const off of analyzeRunBody(bodyForAnalysis)) offenders.push(off);
      continue;
    }

    // YAML alias: `run: *name` (optional trailing YAML comment) resolves to the
    // `&name`-anchored command.
    const aliasMatch = afterTrim.match(/^\*([A-Za-z0-9_-]+)\s*(?:#.*)?$/);
    if (aliasMatch && anchors.has(aliasMatch[1])) {
      const anc = anchors.get(aliasMatch[1]);
      if (anc.inline !== undefined) {
        const found = analyzeExecLine(unquoteInline(anc.inline));
        if (found.banned) {
          offenders.push({ line: i + 1, content: afterTrim, registryHint: found.registryHint });
        }
      } else if (anc.body) {
        const body = anc.body.map((t) => ({ text: t, line: i + 1 }));
        for (const off of analyzeRunBody(body)) offenders.push(off);
      }
      continue;
    }

    // Inline run: plain / 'single' / "double" quoted.
    if (afterTrim.length > 0) {
      const inlineText = unquoteInline(afterTrim);
      const found = analyzeExecLine(inlineText);
      if (found.banned) {
        offenders.push({
          line: i + 1,
          content: afterTrim,
          registryHint: found.registryHint,
        });
      }
      continue;
    }

    // Plain MULTI-LINE scalar: `run:` with nothing after it, then an indented
    // continuation. Collect the more-indented lines as the body (a plain scalar
    // continuation is joined by spaces in YAML, but for publish-shape detection
    // we analyze each physical line; the FOLDed/space-joined form is also
    // covered because `npm` then `publish` on separate lines would otherwise
    // slip — so we additionally fold the body to catch a split command name).
    const body = [];
    let j = i + 1;
    let bodyIndent = null;
    for (; j < lines.length; j++) {
      const bl = lines[j];
      if (bl.trim().length === 0) {
        body.push({ text: "", line: j + 1 });
        continue;
      }
      const ind = indentOf(bl);
      if (ind <= keyIndent) break;
      if (bodyIndent === null) bodyIndent = ind;
      body.push({ text: bl.slice(bodyIndent), line: j + 1 });
    }
    // Only treat it as a plain multi-line scalar if there WAS an indented body.
    if (body.some((b) => b.text.trim().length > 0)) {
      i = j - 1;
      // Analyze both the per-line form AND the folded (space-joined) form so a
      // command name split across lines (`npm` / `publish`) is still caught. A
      // de-dup guard keeps a single-line publish from being reported twice
      // (once per form).
      const seen = new Set();
      const collect = (bodyLines) => {
        for (const off of analyzeRunBody(bodyLines)) {
          const key = `${off.line}:${off.content}`;
          if (seen.has(key)) continue;
          seen.add(key);
          offenders.push(off);
        }
      };
      collect(body);
      collect(foldBody(body));
    }
  }

  return offenders;
}

/**
 * Fold a literal-collected body (post base-indent strip) per YAML folded-scalar
 * rules: consecutive non-blank lines become ONE logical line joined by spaces;
 * a blank line ends the current run. The joined line carries the source line
 * number of its FIRST physical line.
 *
 * @param {Array<{ text: string, line: number }>} body
 * @returns {Array<{ text: string, line: number }>}
 */
function foldBody(body) {
  const out = [];
  let buf = null;
  let startLine = 0;
  for (const { text, line } of body) {
    if (text.trim().length === 0) {
      if (buf !== null) {
        out.push({ text: buf, line: startLine });
        buf = null;
      }
      continue;
    }
    if (buf === null) {
      buf = text;
      startLine = line;
    } else {
      buf += " " + text.trim();
    }
  }
  if (buf !== null) out.push({ text: buf, line: startLine });
  return out;
}

/**
 * Strip a single surrounding pair of matching quotes from an inline `run:`
 * value (`'…'` or `"…"`), tolerating an optional trailing YAML comment after
 * the closing quote (`run: "npm publish" # comment`). Plain (unquoted) values
 * are returned as-is; if the text after the closing quote is neither empty nor
 * a comment, the value is returned unchanged (the quote-aware tokenizer
 * downstream handles it).
 *
 * @param {string} s
 * @returns {string}
 */
function unquoteInline(s) {
  if (s.length < 2 || (s[0] !== '"' && s[0] !== "'")) return s;
  const q = s[0];
  let i = 1;
  let out = "";
  while (i < s.length) {
    const ch = s[i];
    if (q === '"') {
      // YAML double-quoted: `\"`/`\\`/etc. escape the next char.
      if (ch === "\\" && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        const after = s.slice(i + 1).trim();
        return after === "" || after.startsWith("#") ? out : s;
      }
    } else {
      // YAML single-quoted: `''` is an escaped single quote.
      if (ch === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        const after = s.slice(i + 1).trim();
        return after === "" || after.startsWith("#") ? out : s;
      }
    }
    out += ch;
    i++;
  }
  // Unterminated quote — leave the original for the downstream tokenizer.
  return s;
}

/**
 * List YAML files (*.yml, *.yaml) directly inside a directory.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function listYamlFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.(ya?ml)$/.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

/**
 * Recursively find local composite-action manifests (action.yml / action.yaml)
 * anywhere under the given actions directory.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function listCompositeActionFiles(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && /^action\.ya?ml$/.test(e.name)) {
        found.push(p);
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * Scan every workflow file under workflowsDir AND every local composite action
 * under actionsDir.
 *
 * @param {string} [workflowsDir=WORKFLOWS_DIR]
 * @param {string} [actionsDir=ACTIONS_DIR]
 * @returns {{ ok: boolean, offenders: Array<{ file: string, line: number, content: string, registryHint: boolean }> }}
 */
export function scanWorkflows(workflowsDir = WORKFLOWS_DIR, actionsDir = ACTIONS_DIR) {
  const offenders = [];
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

  const relName = (absPath) => {
    if (absPath.startsWith(repoRoot)) return absPath.slice(repoRoot.length);
    return absPath.split("/").pop();
  };

  const scanFile = (absPath) => {
    let text;
    try {
      text = readFileSync(absPath, "utf8");
    } catch {
      return;
    }
    const fileName = relName(absPath);
    for (const hit of scanWorkflowText(text)) {
      offenders.push({ file: fileName, ...hit });
    }
  };

  for (const absPath of listYamlFiles(workflowsDir)) scanFile(absPath);

  // Composite actions (recursive). Guard against actionsDir === workflowsDir.
  try {
    const isDir = statSync(actionsDir).isDirectory();
    if (isDir && actionsDir !== workflowsDir) {
      for (const absPath of listCompositeActionFiles(actionsDir)) scanFile(absPath);
    }
  } catch {
    /* no actions dir → nothing to scan */
  }

  return { ok: offenders.length === 0, offenders };
}

// CLI entry — only when run directly (not when imported by tests).
const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { ok, offenders } = scanWorkflows();
  if (ok) {
    console.log(
      "ok: no GitHub Actions workflow or local composite action executes a " +
        "registry publish (npm/pnpm/yarn/bun publish, yarn npm publish, or a " +
        "curl PUT/upload to the cinatra registry). This gate is CONSERVATIVE — " +
        "it decomposes each run body into candidate simple commands and biases " +
        "to FLAG a manager+publish adjacency, so the shell-evasion space is " +
        "collapsed (a false positive is fixed by the author; a false negative " +
        "would defeat the gate). Extensions publish only through the " +
        "marketplace.\n" +
        "Accepted limitations (genuinely statically undecidable / out of " +
        "literal-run scope): var-indirection of the command-name first token " +
        "(${PM} publish / $PM publish), eval/base64-decoded commands, external/" +
        "3rd-party actions, reusable workflows in other repos, arbitrary " +
        "invoked script files, command-launcher utilities (find -exec / xargs " +
        "/ parallel / timeout / watch), and Windows backslash-path manager " +
        "invocations on a POSIX shell (`C:\\\\…\\\\npm.cmd publish` — the " +
        "backslash is shell-ambiguous; a forward-slash path IS caught) are NOT " +
        "parsed — the marketplace proxy + credential broker re-validate publish " +
        "authority server-side, which is the real control.",
    );
    process.exit(0);
  }
  console.error(
    "ERROR: a GitHub Actions workflow / composite action EXECUTES a registry publish.\n" +
      "Extensions publish ONLY through the marketplace proxy; nothing may run\n" +
      "`npm/pnpm/yarn/bun publish` (incl. behind flags/exec/-c/group/compound\n" +
      "wrappers), `yarn npm publish`, or a curl PUT/upload against Verdaccio /\n" +
      "registry.cinatra.ai. This gate is CONSERVATIVE and biases to flag; if\n" +
      "this is a false positive (e.g. a publish-shaped string that does not\n" +
      "execute), reword the step or move the instruction into an echo/comment.\n" +
      "Remove the executed publish step (an ECHOED instruction is fine).\n",
  );
  for (const { file, line, content, registryHint } of offenders) {
    const tag = registryHint ? " [targets cinatra registry]" : "";
    console.error(`  ${file}:${line}${tag}`);
    console.error(`    ${content}`);
  }
  process.exit(1);
}
