// Production-build launcher — the seam that makes the bundler selectable by env
// on a memory-constrained builder (cinatra#2607).
//
// WHY THIS EXISTS
//
// `next build` on a constrained host hits a NATIVE (non-V8) memory wall that no
// Node heap lever can clear: cinatra-cli#210 measured a build failure that
// survived raising the Docker VM from 4 GB to 14 GB and dropping 14 CPUs to 6,
// and cinatra#2606's `ARG NODE_OPTIONS` binds only V8's old space.
//
// Which bundler runs the build is the one choice that changes the SHAPE of that
// failure — measured on the constrained profile, Turbopack dies on native memory
// that none of the tested controls bounded, while webpack dies on the V8 heap,
// which `NODE_OPTIONS` does bound — and it is the one choice `next.config.ts`
// cannot express: Next 16.2 resolves the bundler in
// `next/dist/lib/bundler.js#parseBundlerArgs`, from CLI flags and private test
// env vars only, before the config is ever read. This launcher is that ARGV seam.
//
// It is a seam, NOT a cure. On the measured ~6 GB / 6-CPU profile this app's
// build exceeded the host on BOTH bundler paths; the doc below carries the whole
// matrix in numbers rather than leaving an operator to discover it in 20-minute
// increments.
//
// UNSET MEANS UNSET
//
// With `CINATRA_BUILD_BUNDLER` unset (or empty — a docker `ARG X=` forwards an
// empty string, not an absent var) this runs `next build` with exactly the argv
// it was given and prints nothing extra: the same argv, against the same
// resolved config, that `"build": "next build"` produced before. What DOES
// change unconditionally is the process tree — this launcher is an extra Node
// parent around Next — so the claim is "same build", not "same processes".
// The `next.config.ts` knob is likewise absent-by-default: the config only
// spreads it in when its env var is set.
//
// The knobs, their accepted values and the measured evidence for each are
// documented in docs/internals/workflows/constrained-host-builds.md.
//
// THE MEMORY FLOOR (cinatra#2633)
//
// Because no knob here is a cure, this launcher also carries the one thing that
// IS actionable: a preflight that measures the memory actually available to the
// build and says so, loudly, when it is below the documented floor. It WARNS and
// builds anyway — a builder that is under the floor may still finish (with swap,
// or on a future smaller tree), and a launcher that refused would be a gate this
// evidence does not support.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Accepted `CINATRA_BUILD_BUNDLER` values. "" / unset ⇒ the Next default. */
export const ACCEPTED_BUNDLERS = ["turbopack", "webpack"];

/**
 * Minimum builder memory, in GiB — the measured floor from cinatra#2633.
 *
 * Derived, not chosen — and it is the SMALLEST BOUND TESTED THAT COMPLETED, not
 * a proven true minimum. Cold builds in memory-capped containers with swap
 * disabled were reaped at 9 GiB and at 12 GiB (both during compile) and twice at
 * 16 GiB on this 14-core host (compile survived; the default 13 page-data
 * workers did not). A build completed at 16 GiB once the worker fan-out was cut
 * to the 3 a real 4-core builder would use. Nothing between 12 and 16 GiB was
 * tried, so the true minimum lies somewhere in that interval, and 16 GiB is not
 * sufficient on its own either — demand also scales with the builder's core
 * count. Every run, and the headroom argument, is in
 * docs/internals/workflows/constrained-host-builds.md ("Minimum builder memory").
 *
 * Keep this number, the `Dockerfile` build-stage comment and that doc section in
 * step; a unit test fails if the three ever disagree.
 */
export const MINIMUM_BUILDER_MEMORY_GIB = 16;
export const MINIMUM_BUILDER_MEMORY_BYTES = MINIMUM_BUILDER_MEMORY_GIB * 1024 ** 3;

/**
 * Normalize an env value the way a docker build-arg delivers it: an undeclared
 * var and a declared-but-empty one both mean "operator said nothing".
 */
export function readKnob(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

/**
 * Resolve the bundler flag for `next build`.
 *
 * Fail-closed: an unrecognised value throws instead of silently building with
 * the default. A typo that costs a 20-minute build and then reports the wrong
 * bundler is worse than no knob at all.
 *
 * @returns {{ flags: string[], bundler: string }}
 */
export function resolveBundlerFlags(env) {
  const raw = readKnob(env, "CINATRA_BUILD_BUNDLER");
  if (raw === "") return { flags: [], bundler: "" };
  const value = raw.toLowerCase();
  if (!ACCEPTED_BUNDLERS.includes(value)) {
    throw new Error(
      `CINATRA_BUILD_BUNDLER="${raw}" is not a recognised bundler. ` +
        `Accepted values: ${ACCEPTED_BUNDLERS.join(", ")} (or leave it unset for the Next default).`,
    );
  }
  // `--turbopack` is passed explicitly rather than elided so an operator who
  // pins the default gets the same "one bundler flag set" path Next validates,
  // and so the resolved bundler is visible in the build log either way.
  return { flags: [`--${value}`], bundler: value };
}

/**
 * The one-line summary printed when — and only when — the operator set at least
 * one knob. Returns null when every knob is unset, so an untouched build's
 * stdout is unchanged.
 */
export function buildKnobSummary(env) {
  const parts = [];
  const bundler = readKnob(env, "CINATRA_BUILD_BUNDLER");
  const cpus = readKnob(env, "CINATRA_BUILD_CPUS");
  if (bundler !== "") parts.push(`bundler=${bundler.toLowerCase()}`);
  if (cpus !== "") parts.push(`cpus=${cpus}`);
  if (parts.length === 0) return null;
  // NODE_OPTIONS is not ours (cinatra#2606 owns it) but it is the other half of
  // the memory picture, so echo it when the operator moved anything at all.
  const nodeOptions = readKnob(env, "NODE_OPTIONS");
  if (nodeOptions !== "") parts.push(`NODE_OPTIONS=${nodeOptions}`);
  return `[cinatra build] constrained-build knobs: ${parts.join(" ")}`;
}

/** Argv for `next`, given the process's own forwarded arguments. */
export function resolveNextArgs(env, forwarded) {
  return ["build", ...resolveBundlerFlags(env).flags, ...forwarded];
}

// ---------------------------------------------------------------------------
// Builder-memory preflight (cinatra#2633)
// ---------------------------------------------------------------------------

/** Read a file, or null when it is absent/unreadable — never throw into a build. */
function tryRead(readFile, file) {
  try {
    const raw = readFile(file);
    return raw === undefined || raw === null ? null : String(raw);
  } catch {
    return null;
  }
}

/**
 * One cgroup limit value in bytes, or null for "uncapped"/unparseable.
 *
 * cgroup v2 spells "no limit" as the literal `max`; cgroup v1 spells it as a
 * page-counter sentinel around 9.2e18. Both mean uncapped, not "enormous" — and
 * reading the v1 sentinel as a real number would silently disable this check on
 * every v1 host.
 */
function parseCgroupLimit(text) {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "max") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

/** A cgroup-relative path and all of its ancestors, tightest first. */
function cgroupPathChain(relative) {
  const parts = String(relative).split("/").filter(Boolean);
  const chain = [];
  for (let i = parts.length; i >= 0; i -= 1) chain.push(`/${parts.slice(0, i).join("/")}`);
  return chain;
}

/**
 * The cgroup memory limit that governs THIS process, in bytes, or null when the
 * build is not capped.
 *
 * `os.totalmem()` alone is not enough here, and reporting it alone would be a
 * lie in the case that matters most: inside a container it reads the HOST's
 * memory, because it calls sysinfo(2), which is not cgroup-aware. Every build
 * this repository ships runs in a container (`docker build`, the preview image,
 * CI), so the cap is usually the real number and the host total is the
 * flattering one.
 *
 * The limit is looked up along the process's own cgroup path, not only at the
 * cgroupfs root. With docker's default private cgroup namespace the path is `/`
 * and the two are the same file — but a nested runner or a systemd slice puts
 * the real cap on an ANCESTOR, and only the tightest limit on the chain binds.
 * A readable v2 hierarchy is authoritative: never fall through to a v1 file that
 * may not govern this process at all.
 *
 * `readFile` is injected so this is testable without a cgroupfs.
 */
export function readCgroupMemoryLimit(readFile = (p) => readFileSync(p, "utf8")) {
  const procSelf = tryRead(readFile, "/proc/self/cgroup");
  const lines = procSelf === null ? [] : procSelf.split("\n");
  const limits = [];

  // cgroup v2: the unified hierarchy is the `0::<path>` line.
  const v2Line = lines.find((line) => line.startsWith("0::"));
  let sawV2 = false;
  for (const relative of v2Line ? cgroupPathChain(v2Line.slice(3)) : ["/"]) {
    const text = tryRead(readFile, path.posix.join("/sys/fs/cgroup", relative, "memory.max"));
    if (text === null) continue;
    sawV2 = true;
    const value = parseCgroupLimit(text);
    if (value !== null) limits.push(value);
  }
  if (sawV2) return limits.length > 0 ? Math.min(...limits) : null;

  // cgroup v1: the controller list is field 2; the path is everything after it.
  const v1Line = lines.find((line) => line.split(":")[1]?.split(",").includes("memory"));
  for (const relative of v1Line ? cgroupPathChain(v1Line.split(":").slice(2).join(":")) : ["/"]) {
    const value = parseCgroupLimit(
      tryRead(readFile, path.posix.join("/sys/fs/cgroup/memory", relative, "memory.limit_in_bytes")),
    );
    if (value !== null) limits.push(value);
  }
  return limits.length > 0 ? Math.min(...limits) : null;
}

/** Bytes as a one-decimal GiB string — the unit the floor is stated in. */
export function formatGiB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * What this build actually has: the SMALLER of the machine's memory and the
 * container cap, plus which of the two it came from (so the warning can name the
 * thing an operator has to change).
 *
 * @returns {{ bytes: number, source: string } | null} null when neither is known.
 */
export function resolveBuilderMemory({ totalMemoryBytes, cgroupLimitBytes } = {}) {
  const usable = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
  const total = usable(totalMemoryBytes) ? totalMemoryBytes : null;
  const cap = usable(cgroupLimitBytes) ? cgroupLimitBytes : null;
  if (total === null && cap === null) return null;
  if (cap !== null && (total === null || cap <= total)) {
    return { bytes: cap, source: "container memory limit" };
  }
  return { bytes: total, source: "total system memory" };
}

/**
 * The loud, NON-FATAL preflight banner — or null when the builder is at or above
 * the floor, so a correctly-sized builder's log is untouched.
 *
 * Deliberately a warning and never an exit: the floor is the smallest size at
 * which a build was measured to COMPLETE, not a proof that everything below it
 * fails. Swap clears it; a smaller tree would too. Turning a measured floor into
 * a gate would block builds this evidence cannot condemn.
 */
export function builderMemoryWarning(memory, floorBytes = MINIMUM_BUILDER_MEMORY_BYTES) {
  if (!memory || memory.bytes >= floorBytes) return null;
  const rule = "=".repeat(78);
  return [
    "",
    rule,
    "  WARNING  this builder is BELOW the measured minimum memory for this build",
    rule,
    `  available to the build : ${formatGiB(memory.bytes)}  (${memory.source})`,
    `  measured floor         : ${formatGiB(floorBytes)}`,
    "",
    "  What this means. On the smallest builder where a cold production build of",
    "  this repository COMPLETED, it held 14.3 GiB of resident memory in ONE",
    "  process and 15.5 GiB across the whole build process tree. Every measured",
    "  run below that, with swap disabled, was reaped during compile and reported",
    "  exit 137 — which names a SIGKILL and never its cause, so it reads like a",
    "  crash rather than an out-of-memory.",
    "",
    "  What to do. Give the build more memory (on Docker Desktop / colima that is",
    "  the VM's memory setting, not the laptop's RAM); or give it swap, which a",
    "  bounded build can complete through and which CI adds deliberately; or pull",
    "  the released image instead of building. CINATRA_BUILD_CPUS bounds the",
    "  page-data worker fan-out and was decisive in THAT phase on this many-core",
    "  host, but nothing in this repository was found to make the COMPILE peak fit",
    "  a small builder. Every measurement is in",
    "  docs/internals/workflows/constrained-host-builds.md.",
    "",
    "  This is a WARNING, not a gate. The build continues.",
    rule,
    "",
  ].join("\n");
}

function main() {
  let args;
  try {
    args = resolveNextArgs(process.env, process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }

  const summary = buildKnobSummary(process.env);
  if (summary) console.log(summary);

  // Preflight BEFORE anything expensive: an operator who is going to lose this
  // build to the OOM reaper in ninety seconds should be told in the first line
  // of output, not left to decode exit 137 afterwards. stderr, so it survives a
  // log pipeline that keeps only the build's own stdout.
  const warning = builderMemoryWarning(
    resolveBuilderMemory({
      totalMemoryBytes: os.totalmem(),
      cgroupLimitBytes: readCgroupMemoryLimit(),
    }),
  );
  if (warning) console.error(warning);

  // Resolve Next's real JS entry and run it under THIS node, rather than the
  // `node_modules/.bin/next` shim: the shim is a POSIX shell script whose
  // Windows equivalent is a separate `.cmd`, so spawning it by path is not
  // portable. `bin.next` is read from Next's own package.json so a Next release
  // that moves its entry point cannot silently break this.
  let nextEntry;
  try {
    const requireFromBuildRoot = createRequire(path.join(process.cwd(), "package.json"));
    const nextPackagePath = requireFromBuildRoot.resolve("next/package.json");
    const binField = requireFromBuildRoot("next/package.json").bin;
    const relativeEntry = typeof binField === "string" ? binField : binField?.next;
    if (!relativeEntry) throw new Error("next's package.json declares no `bin.next` entry");
    nextEntry = path.resolve(path.dirname(nextPackagePath), relativeEntry);
  } catch (error) {
    console.error(
      `\nCould not resolve the \`next\` binary from ${process.cwd()}: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `Run the build from the repository root with dependencies installed.\n`,
    );
    process.exit(1);
    return;
  }

  const child = spawn(process.execPath, [nextEntry, ...args], {
    stdio: "inherit",
    env: process.env,
  });

  // Forward EVERY delivery, not just the first: a second Ctrl-C is how an
  // operator escalates a build that ignored the first one.
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone; its own exit event carries the status.
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    process.on(signal, () => forward(signal));
  }

  child.on("error", (error) => {
    console.error(`\nFailed to launch \`next build\`: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      // Die of the SAME signal so the parent shell sees a signalled build for
      // what it is — a SIGKILLed (host-reaped) build must not be reported as an
      // ordinary non-zero exit, and a SIGSEGV must not be flattened into 128.
      // Reset to the default disposition first, otherwise our own handler above
      // would swallow the re-raise.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      // Only reached if the signal was somehow not fatal (e.g. it is blocked):
      // fall back to the shell's 128+n convention.
      process.exit(128 + (signalNumber(signal) ?? 0));
    }
    process.exit(code ?? 1);
  });
}

/** The platform's number for a signal name, for the 128+n fallback above. */
function signalNumber(signal) {
  return os.constants?.signals?.[signal];
}

// Only run when executed directly — the exported helpers are unit-tested.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
