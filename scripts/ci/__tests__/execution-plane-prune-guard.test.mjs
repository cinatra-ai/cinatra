// THE SHARED-DAEMON PRUNE GUARD (cinatra#3327).
//
// WHAT WAS BROKEN. The batteries matrix of execution-plane-e2e.yml opened every
// leg with `sudo docker system prune -af`, unguarded. On the GitHub-hosted pool
// that was free: each leg owns its own daemon there, so the prune reclaimed
// nothing but the image's own preloaded layers. On a self-hosted runner the
// four legs share ONE docker daemon, and the prune of whichever leg started
// last removed the images the other three had just BUILT — the worker image,
// the L0 sandbox image and the broker bundle, all built by the harness BEFORE
// `compose up`. Compose then found the tags gone, fell back to a registry pull
// of a bare name, and every battery died the same way:
//
//   pull access denied for cinatra-exec-worker, repository does not exist
//
// Best-effort disk hygiene destroyed the inputs of the jobs it ran beside. The
// same four batteries had been green one at a time on the same machine, which
// is the signature of a cross-job collision rather than a defect in the
// batteries.
//
// THE RULE THIS FILE PINS. A step that mutates state SHARED by every job of a
// runner — a docker prune of any kind, a `down --rmi`, a delete of the
// preinstalled toolchains — runs on a GitHub-hosted runner and nowhere else,
// because only there is the machine this job's own and thrown away after it.
// The guard is the runner's OWN environment and nothing else, EXACTLY:
//
//   if: ${{ runner.environment == 'github-hosted' }}
//
// the identical clause build-image.yml has carried on its identical step since
// cinatra#3267. Exactly, not "contains": `runner.environment == 'github-hosted'
// || true` contains the required text and prunes on every runner there is.
//
// TWO ARMS, because pinning one site is a pin the next site walks around:
//
//   1. THE NAMED SITE. The batteries job's reclaim step carries the guard and
//      says beside it why — a guard with no reason next to it is the edit this
//      file exists to prevent.
//
//   2. THE DISCOVERED SITES. Every destructive docker verb under .github,
//      found by WALKING the tree rather than by consulting a hand-kept list.
//      A hand-kept list is how this defect got in: the sibling map in
//      exec-image-runner-routing.test.mjs enumerates five workflows carrying a
//      guarded host-mutation step, and execution-plane-e2e.yml — which carried
//      an UNguarded one — was never one of them. A list only pins the sites
//      somebody already thought of.
//
// WHAT THE SCANNER BELOW SUPPORTS, stated rather than left to be discovered
// (this repo carries no YAML parser dependency, so the scanner reads indented
// text the way the sibling workflow-shape guards under scripts/ci/__tests__
// already do). Its supported syntax, each case pinned by a fixture in the
// third describe block:
//
//   - `steps:` with or without a trailing YAML comment.
//   - A step's OWN mapping keys only. `name:`, `if:`, `uses:` and `run:` are
//     read at the step's key column and nowhere else, so a line inside a `run:`
//     block scalar — a heredoc that prints the text `if: ...`, say — can never
//     be mistaken for the step's guard.
//   - EXECUTABLE content only. The destructive-verb scan reads the `run:` body
//     and nothing else: not the step name, not comments, not an `echo` that
//     merely names a command. Shell line continuations are joined first, and a
//     command list is split on `;`, `&&` and `||` so a verb after a separator
//     is still seen.
//   - `docker`, `sudo docker`, `/usr/bin/docker` and `docker-compose`, with
//     global flags (`--context default`, `-H ...`) between the binary and its
//     subcommand.
//
// A construct outside that list is a construct this file does not see. That is
// why the discovered set is ALSO pinned to the sites that exist today: a
// scanner that quietly stops matching reds here instead of passing empty.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GITHUB_DIR = join(REPO_ROOT, ".github");

const BATTERIES_WORKFLOW = ".github/workflows/execution-plane-e2e.yml";
const BATTERIES_TEXT = readFileSync(join(REPO_ROOT, BATTERIES_WORKFLOW), "utf8");

/** The one guard a shared-state mutation may carry, and the whole of it. */
const REQUIRED_GUARD = "runner.environment == 'github-hosted'";

/** The reclaim step of the batteries job, by its own name. */
const RECLAIM_STEP = "Free runner disk for the image builds";

/**
 * A whole-line YAML comment. The structural scan is blind to these: a change
 * that comments the real guard out and leaves the expected text in a comment
 * must not read as a guard, and a comment that merely NAMES a destructive verb
 * (this file's own neighbours do) must not read as a call site.
 */
const isComment = (line) => /^\s*#/.test(line);

const indentOf = (line) => line.length - line.trimStart().length;

/** `'x'` / `"x"` / bare — the scalar's text, without its quotes. */
function scalar(text) {
  const trimmed = text.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/**
 * The guard as GitHub evaluates it: the `${{ }}` wrapper removed and the
 * whitespace flattened, so it can be compared for EQUALITY. Anything appended
 * to the condition — `|| true`, `|| github.event_name == 'schedule'` — changes
 * this string and reds the assertion, which is the point.
 */
function normalizeGuard(guard) {
  if (guard === null || guard === undefined) return null;
  const unwrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(guard.trim());
  return (unwrapped ? unwrapped[1] : guard).replace(/\s+/g, " ").trim();
}

/**
 * One step's own mapping keys, and the body of its `run:` block. Keys are read
 * ONLY at the step's key column (the column just past the `- `); everything
 * deeper belongs to the block scalar or nested mapping it sits in and is never
 * read as a key.
 */
function parseStep(lines) {
  const dash = /^\s*-\s+/.exec(lines[0])[0];
  const keyIndent = dash.length;

  let name = null;
  let guard = null;
  let uses = null;
  const runLines = [];
  let inRun = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = index === 0 ? " ".repeat(keyIndent) + lines[0].slice(dash.length) : lines[index];
    const indent = indentOf(raw);

    if (indent > keyIndent) {
      if (inRun) runLines.push(raw);
      continue;
    }

    inRun = false;
    const key = /^([A-Za-z_][\w-]*):\s*([\s\S]*)$/.exec(raw.trim());
    if (!key) continue;
    const [, keyName, rest] = key;
    if (keyName === "name" && name === null) name = scalar(rest);
    else if (keyName === "if" && guard === null) guard = rest.trim();
    else if (keyName === "uses" && uses === null) uses = scalar(rest);
    else if (keyName === "run") {
      inRun = true;
      // `run: docker system prune` on one line is executable content too.
      if (rest.trim() && !/^[|>]/.test(rest.trim())) runLines.push(rest.trim());
    }
  }

  return { name, guard, uses, runLines, text: lines.join("\n") };
}

/**
 * Every step of one YAML text — workflow job steps and composite-action steps
 * alike. A step begins at a list item indented exactly as the first item under
 * its own `steps:` key; anything deeper belongs to the step it sits in.
 */
function stepsOf(text) {
  const steps = [];
  let current = null;
  let stepIndent = null;
  let inSteps = false;

  const flush = () => {
    if (current) steps.push(parseStep(current));
    current = null;
  };

  for (const raw of text.split("\n")) {
    if (isComment(raw) || raw.trim() === "") continue;
    const indent = indentOf(raw);

    // A trailing YAML comment on the structural key must not hide the block.
    if (/^\s*steps:\s*(#.*)?$/.test(raw)) {
      flush();
      inSteps = true;
      stepIndent = null;
      continue;
    }
    if (!inSteps) continue;

    const isItem = /^\s*-\s+\S/.test(raw);

    if (stepIndent === null) {
      if (!isItem) {
        inSteps = false;
        continue;
      }
      stepIndent = indent;
    } else if (indent < stepIndent || (!isItem && indent <= stepIndent)) {
      flush();
      inSteps = false;
      stepIndent = null;
      continue;
    }

    if (isItem && indent === stepIndent) {
      flush();
      current = [];
    }
    if (!current) continue;
    current.push(raw);
  }
  flush();

  return steps;
}

/**
 * The commands a step's `run:` body actually executes: continuations joined,
 * shell comments dropped, command lists split on their separators, and the
 * segments that only PRINT a command removed. Reading executable content alone
 * is what keeps `echo "docker system prune"` from reading as a call site.
 */
function commandsOf(step) {
  const joined = [];
  let pending = "";
  for (const raw of step.runLines) {
    const line = raw.replace(/(^|\s)#.*$/, "$1").trim();
    if (!line) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    joined.push(`${pending}${line}`.trim());
    pending = "";
  }
  if (pending.trim()) joined.push(pending.trim());

  return joined
    .flatMap((command) => command.split(/;|&&|\|\||\|/))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !/^(echo|printf|:)\b/.test(segment));
}

/** A docker global flag that swallows the token after it. */
const GLOBAL_FLAG_WITH_VALUE =
  /^(--context|--host|-H|--config|--log-level|-l|--tlscacert|--tlscert|--tlskey)$/;

/**
 * The docker subcommand one shell segment runs, or null when the segment does
 * not invoke docker at all. Leading `sudo`/`env`-style prefixes and docker's
 * own global flags are stepped over so `sudo docker --context default system
 * prune -af` is seen for what it is.
 */
function dockerSubcommand(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^(sudo|env|command|time|nice|-E|-n|--)$/.test(tokens[index])) {
    index += 1;
  }
  if (!/(^|\/)docker(-compose)?$/.test(tokens[index] ?? "")) return null;
  index += 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    index += GLOBAL_FLAG_WITH_VALUE.test(tokens[index]) ? 2 : 1;
  }
  return tokens.slice(index).join(" ");
}

/**
 * A verb that removes state the whole daemon shares. Every one of them can take
 * an image, a container, a network or a volume belonging to a job running
 * beside this one on the same machine. A per-project `down` is NOT here: it
 * names its own compose project and touches nothing else. `--rmi` is, because
 * the images a project's services were built from are shared by tag.
 */
function isDestructiveCommand(segment) {
  const rest = dockerSubcommand(segment);
  if (rest === null) return false;
  if (/^(system|image|container|network|volume|builder|buildx)\s+prune\b/.test(rest)) return true;
  if (/^rmi\b/.test(rest)) return true;
  if (/\bdown\b[\s\S]*\s--rmi\b/.test(rest)) return true;
  return false;
}

const isDestructiveStep = (step) => commandsOf(step).some(isDestructiveCommand);

/** Every YAML file under .github — workflows and composite actions alike. */
function githubYamlFiles() {
  return readdirSync(GITHUB_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath ?? entry.path, entry.name)))
    .map((path) => path.split(sep).join("/"))
    .sort();
}

/** Every step under .github whose own `run:` body runs a destructive verb. */
function destructiveSites() {
  const sites = [];
  for (const file of githubYamlFiles()) {
    for (const step of stepsOf(readFileSync(join(REPO_ROOT, file), "utf8"))) {
      if (!isDestructiveStep(step)) continue;
      sites.push({ file, name: step.name, guard: step.guard });
    }
  }
  return sites;
}

/**
 * The comments ATTACHED to one named step: the contiguous block directly above
 * its list item, plus the comments inside the step itself. Adjacency is the
 * contract — a reason written somewhere else in the job is not a reason written
 * beside the step, and would keep reading as one if the real one were deleted.
 */
function commentsAttachedTo(text, stepName) {
  const lines = text.split("\n");
  const item = new RegExp(`^\\s*-\\s+name:\\s*(['"]?)${stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1\\s*$`);
  const start = lines.findIndex((line) => item.test(line));
  if (start === -1) return null;

  const attached = [];
  for (let index = start - 1; index >= 0; index -= 1) {
    if (isComment(lines[index])) attached.unshift(lines[index]);
    else break;
  }
  const itemIndent = indentOf(lines[start]);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent < itemIndent) break;
    if (indent === itemIndent && /^\s*-\s+\S/.test(line)) break;
    if (isComment(line)) attached.push(line);
  }
  return attached.join("\n");
}

const reclaimStep = () => stepsOf(BATTERIES_TEXT).find((step) => step.name === RECLAIM_STEP);

describe("the batteries reclaim step never prunes a concurrent job's images", () => {
  it("guards the step on the runner's own environment, and on nothing else", () => {
    const step = reclaimStep();
    expect(step, `${BATTERIES_WORKFLOW} — "${RECLAIM_STEP}"`).toBeTruthy();
    // EQUALITY, not containment: an appended `|| true` (or any `vars.` escape
    // hatch nobody sets) contains the required text and prunes anyway.
    expect(normalizeGuard(step.guard), RECLAIM_STEP).toBe(REQUIRED_GUARD);
  });

  it("still prunes on the hosted road, which is what the step is for", () => {
    // The fix is a guard, not a deletion: the hosted pool keeps the ~25-30 GB
    // reclaim the image builds were given it for. A step that no longer prunes
    // at all would satisfy a guard assertion and quietly reintroduce the ENOSPC
    // this step was added to prevent.
    expect(commandsOf(reclaimStep()).some(isDestructiveCommand)).toBe(true);
  });

  it("writes beside the step why the self-hosted road skips it", () => {
    const attached = commentsAttachedTo(BATTERIES_TEXT, RECLAIM_STEP);
    expect(attached, `${BATTERIES_WORKFLOW} — "${RECLAIM_STEP}"`).toBeTruthy();
    expect(attached).toContain("self-hosted");
    expect(attached).toContain("another job");
  });
});

describe("every destructive docker call under .github is hosted-only", () => {
  it("finds the call sites by walking the tree, and finds the known ones", () => {
    // Anti-vacuity. A scanner that silently stopped matching would turn the arm
    // below into a green that proves nothing, so the discovery is pinned to the
    // sites that exist today: both reclaim steps, and nothing else.
    const sites = destructiveSites();
    expect(sites.map((site) => `${site.file} — ${site.name}`)).toEqual([
      ".github/workflows/build-image.yml — Free runner disk for the image build (default-runner only)",
      ".github/workflows/execution-plane-e2e.yml — Free runner disk for the image builds",
    ]);
  });

  it("guards each one on `github-hosted` and on nothing else", () => {
    for (const site of destructiveSites()) {
      expect(normalizeGuard(site.guard), `${site.file} — ${site.name}`).toBe(REQUIRED_GUARD);
    }
  });
});

describe("the scanner itself, over the constructs it claims to support", () => {
  const scan = (yaml) => stepsOf(yaml);

  it("does not read an `if:` printed inside a run body as the step's guard", () => {
    const [step] = scan(
      [
        "    steps:",
        "      - name: Reclaim",
        "        run: |",
        "          cat <<'EOF'",
        "          if: ${{ runner.environment == 'github-hosted' }}",
        "          EOF",
        "          sudo docker system prune -af",
      ].join("\n"),
    );
    expect(step.guard).toBeNull();
    expect(isDestructiveStep(step)).toBe(true);
  });

  it("still finds the steps under a `steps:` key that carries a trailing comment", () => {
    const [step] = scan(
      ["    steps: # cleanup", "      - name: Reclaim", "        run: sudo docker system prune -af"].join("\n"),
    );
    expect(step.name).toBe("Reclaim");
    expect(isDestructiveStep(step)).toBe(true);
  });

  it("sees a destructive verb behind docker's global flags and a line continuation", () => {
    const [flags, wrapped, separated] = scan(
      [
        "    steps:",
        "      - name: Context",
        "        run: docker --context default system prune -af",
        "      - name: Wrapped",
        "        run: |",
        "          sudo docker system \\",
        "            prune -af",
        "      - name: Separated",
        "        run: df -h / && /usr/bin/docker image prune -a",
      ].join("\n"),
    );
    expect(isDestructiveStep(flags)).toBe(true);
    expect(isDestructiveStep(wrapped)).toBe(true);
    expect(isDestructiveStep(separated)).toBe(true);
  });

  it("does not read a printed or commented command as a call site", () => {
    const [printed, commented, named] = scan(
      [
        "    steps:",
        "      - name: Printed",
        "        run: |",
        '          echo "docker system prune -af"',
        "      - name: Commented",
        "        run: |",
        "          # docker system prune -af",
        "          df -h /",
        "      - name: docker system prune -af",
        "        run: df -h /",
      ].join("\n"),
    );
    expect(isDestructiveStep(printed)).toBe(false);
    expect(isDestructiveStep(commented)).toBe(false);
    expect(isDestructiveStep(named)).toBe(false);
  });

  it("reads a `down --rmi` as destructive and a plain per-project `down` as not", () => {
    const [rmi, plain] = scan(
      [
        "    steps:",
        "      - name: Rmi",
        "        run: docker compose -p job down --rmi all",
        "      - name: Plain",
        "        run: docker compose -p job down -v",
      ].join("\n"),
    );
    expect(isDestructiveStep(rmi)).toBe(true);
    expect(isDestructiveStep(plain)).toBe(false);
  });

  it("normalizes a guard so an appended clause cannot pass as the required one", () => {
    expect(normalizeGuard("${{ runner.environment == 'github-hosted' }}")).toBe(REQUIRED_GUARD);
    expect(normalizeGuard("${{ runner.environment == 'github-hosted' || true }}")).not.toBe(REQUIRED_GUARD);
    expect(normalizeGuard(null)).toBeNull();
  });
});
