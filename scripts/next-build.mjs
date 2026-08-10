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

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Accepted `CINATRA_BUILD_BUNDLER` values. "" / unset ⇒ the Next default. */
export const ACCEPTED_BUNDLERS = ["turbopack", "webpack"];

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
