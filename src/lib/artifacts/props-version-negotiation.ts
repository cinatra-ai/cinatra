// PER-DISPLAY PROPS-VERSION NEGOTIATION (enabler 0.4 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "Per-display version negotiation:
// resolve the display, read its declared props version, then build the snapshot
// at that version."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "the version check is strict
// equality, so the day the host emits a new version every existing display goes
// dark at once. This turns a flag day into a per-extension ratchet."
//
// THE OLD RULE, EXACTLY. Both renderer seams compared the display's declared
// `propsApiVersion` to the host's with `!==` — the build-map loader
// (`artifact-renderer-loader.ts`) and the signed-bundle runtime admission
// (`runtime-renderer-descriptor.ts`, `checkAbi`). Publishing props v2 would
// therefore have failed EVERY v1 display in the fleet in one deploy, whatever
// the display actually needed.
//
// THE NEW RULE. The host declares a WINDOW of props versions it can still build
// a snapshot at — `[HOST_MIN_SUPPORTED_PROPS_API_VERSION, HOST_PROPS_API_VERSION]`
// — and a display inside that window is admitted AT ITS OWN VERSION. The host
// then builds the snapshot at the negotiated version, which is the second half
// of the enabler's sentence and the half that makes the first half safe: a v1
// display admitted under a v2 host must be handed a v1 snapshot, not a v2 one
// it cannot read.
//
// TWO REFUSALS, HELD APART, because they are different facts about the fleet:
//   `too-new` — the display declares a version this host cannot build. The
//               extension is ahead of the deployment; upgrading the host fixes
//               it, and NOTHING about the display is wrong.
//   `retired` — the display declares a version below the window's floor. The
//               host has dropped that snapshot shape; the extension must move.
// Both still floor the display (the never-blank contract is untouched), and
// both still degrade under the existing `abi-incompatible` failure class, so no
// caller's taxonomy widens. What changes is that they are now DIFFERENT reasons
// and only one of them can ever be caused by a host deploy.
//
// PURE. No React, no DB, no server-only: the whole ratchet is unit-testable.

import { ARTIFACT_RENDERER_PROPS_API_VERSION } from "@/lib/artifacts/artifact-renderer-props";

/** The newest props-contract version this host can build a snapshot at. */
export const HOST_PROPS_API_VERSION = ARTIFACT_RENDERER_PROPS_API_VERSION;

/**
 * The OLDEST props-contract version this host still builds.
 *
 * It is 1 today, and it is a SEPARATE constant from the newest on purpose:
 * retiring a snapshot shape is a deliberate act with a fleet cost, and it must
 * be visible as its own edit with its own gate run — never a side effect of
 * bumping the newest.
 */
export const HOST_MIN_SUPPORTED_PROPS_API_VERSION = 1;

/** Why a declared display version cannot be negotiated. */
export type PropsVersionRefusal = "too-new" | "retired" | "malformed";

export type PropsVersionNegotiation =
  | { ok: true; version: number }
  | { ok: false; reason: PropsVersionRefusal };

/** Every version in the host's window, oldest first — for exhaustive tests. */
export function hostSupportedPropsApiVersions(): number[] {
  const out: number[] = [];
  for (let v = HOST_MIN_SUPPORTED_PROPS_API_VERSION; v <= HOST_PROPS_API_VERSION; v += 1) {
    out.push(v);
  }
  return out;
}

/**
 * NEGOTIATE the props version for ONE display, from the version the display
 * itself declares.
 *
 * The returned `version` is the version the host must BUILD THE SNAPSHOT AT —
 * the display's own, never the host's newest. A display that declares nothing
 * usable is refused with a named reason rather than defaulted: defaulting would
 * hand an unknown display a shape it never agreed to.
 */
export function negotiatePropsApiVersion(
  declared: number | null | undefined,
  window?: { min?: number; max?: number },
): PropsVersionNegotiation {
  const min = window?.min ?? HOST_MIN_SUPPORTED_PROPS_API_VERSION;
  const max = window?.max ?? HOST_PROPS_API_VERSION;
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (declared > max) return { ok: false, reason: "too-new" };
  if (declared < min) return { ok: false, reason: "retired" };
  return { ok: true, version: declared };
}

/**
 * The boolean the two renderer seams need, so neither has to re-derive the
 * window. A seam that only reports "compatible or not" keeps its own taxonomy;
 * a seam that wants the reason calls `negotiatePropsApiVersion` directly.
 */
export function isPropsApiVersionSupported(
  declared: number | null | undefined,
  window?: { min?: number; max?: number },
): boolean {
  return negotiatePropsApiVersion(declared, window).ok;
}
