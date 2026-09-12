#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE DESIGN SERVER'S PORT, DERIVED PER RUNNER SLOT (cinatra#3416).
//
// WHY THIS EXISTS. The pixel-diff job of design-visual-verify boots ONE
// standalone server and points Playwright at it by port. While that port was a
// single literal shared by every job, two jobs of this workflow running at the
// same time on ONE self-hosted machine — different runner processes, so
// different jobs — contended for it. The later job's port-reclaim step
// (cinatra#3383) then did exactly what it was told: it killed the process
// holding the port, which was the EARLIER job's live server, and bound the port
// itself. From that moment the earlier job's Playwright step was talking to a
// server belonging to another run. The seed capability is minted per run, so
// that server refused the seeded-fixture POST at the presented-capability fence
// and answered the bare 404 the fence contract requires — a red on a pull
// request that changed nothing, always near the end of a long run, because a
// long run is the one still alive when a peer job reaches its reclaim step.
//
// THE INVARIANT THAT FIXES IT. A runner process runs at most ONE job at a time,
// so two jobs that overlap in time are always on different runner slots. Give
// every runner slot its own port and no two live jobs can ever want the same
// one; the reclaim step then only ever frees a leftover of an EARLIER job on
// the SAME slot, which is the case it was written for.
//
// DETERMINISTIC, NEVER PROBED. The port is read before the build, so the public
// URLs baked into the bundle name the same port the server later binds. A probe
// for a free port would be a promise about a moment, and the build that follows
// it takes minutes.
// ---------------------------------------------------------------------------
import { pathToFileURL } from "node:url";

/** The port the job has always used, and the bottom of the per-slot window. */
export const DESIGN_SERVER_PORT_BASE = 3101;

/** How many runner slots one machine may host before the window wraps. */
export const DESIGN_SERVER_PORT_SLOTS = 64;

/**
 * The slot a runner name denotes: its trailing index. A fleet names its runners
 * with one ("...-runner-4"); a hosted runner may carry none, and gets slot 0 —
 * correct, because a hosted runner owns its whole machine and nothing else on
 * it can want the port.
 */
export function runnerSlotIndex(runnerName) {
  if (typeof runnerName !== "string") return 0;
  const match = /(\d+)\s*$/.exec(runnerName.trim());
  if (match === null) return 0;
  return Number(match[1]) % DESIGN_SERVER_PORT_SLOTS;
}

/** The port this job's design server binds. */
export function designServerPort(env = process.env) {
  return DESIGN_SERVER_PORT_BASE + runnerSlotIndex(env.RUNNER_NAME);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) process.stdout.write(`${designServerPort()}\n`);
