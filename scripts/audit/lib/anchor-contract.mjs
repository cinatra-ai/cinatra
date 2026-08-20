/**
 * THE DESIGN-CONTRACT DRIFT ALARM (cinatra#2826, epic #2784 S9m).
 *
 * WHAT DRIFTS, AND WHY NOBODY NOTICES. Three artifacts describe the same cards
 * and none of them can see the other two: the DESIGN PIN the acceptance manifest
 * declares (`specCommit`), the EXECUTABLE DOM expectations the suites assert
 * (owner anchors, ruled root declarations, the render-observed host parity), and
 * the ANCHORS A CAPTURE is graded against. A design page moves, the pin is
 * bumped, and every green check keeps asserting yesterday's anchors against
 * today's drawing — silently, because nothing binds the three together.
 *
 * WHAT THIS IS. One machine-readable anchor contract
 * (`scripts/audit/chat-hitl-anchor-contract.json`) carrying a DIGEST taken over
 * exactly those three inputs. The gate recomputes it from live sources and
 * refuses a mismatch, so:
 *
 *   · moving the design pin invalidates the digest — the pin is a digest INPUT,
 *     read from the manifest rather than from the anchor file, so bumping it
 *     alone can never stay green;
 *   · renaming an anchor, adding a host cell or weakening an observation
 *     invalidates it too;
 *   · changing what a capture must observe invalidates it, because the capture
 *     requirements are recomputed LIVE from the recorder contract.
 *
 * RE-RATIFICATION IS THE ONLY WAY BACK, and it is deliberately a human edit: the
 * entrypoint can PRINT the recomputed digest (`--print-anchor-digest`) but never
 * writes one. The new value lands in the diff, where a reviewer sees that the
 * anchor contract was re-examined at the new pin rather than mechanically
 * refreshed. There is no regeneration mode, for the same reason the acceptance
 * manifest has none: these are claims a person makes.
 *
 * THE OTHER HALF OF THE BINDING lives in the TypeScript suite
 * (`src/lib/lifecycle/__tests__/anchor-contract-binding.test.ts`), which asserts
 * the recorded `domExpectations` deep-equal the EXECUTABLE ones. Together the
 * two close both directions: the code cannot move without the file, and the file
 * cannot move without the digest.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_HOSTS,
  CAPTURE_STATES,
  captureRequirementsFor,
} from "./chat-hitl-capture-recorder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ANCHOR_CONTRACT_PATH = join(__dirname, "..", "chat-hitl-anchor-contract.json");

/** The kinds the anchor contract covers — the protocol package's closed set. */
export const ANCHOR_CONTRACT_KINDS = Object.freeze([
  "artifact_review_gate",
  "recommendation_hold",
  "trigger_schedule_proposal",
  "verification_summary",
]);

/**
 * Deterministic JSON — object keys sorted at every depth, arrays left in the
 * order their contract declares. A digest over unsorted JSON would change when a
 * key moved, which is formatting, not drift.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The anchors a CAPTURE is graded against, recomputed live from the recorder
 * contract — one entry per (host, kind, state), plus the host's own frame-wide
 * set. This is the third digest input, and it is never read from the anchor
 * file: a requirement that changed must move the digest.
 */
export function captureAnchorExpectations() {
  const out = {};
  for (const host of CAPTURE_HOSTS) {
    out[host] = { "*": captureRequirementsFor(host).map(selectorOf) };
    for (const kind of ANCHOR_CONTRACT_KINDS) {
      for (const state of CAPTURE_STATES) {
        out[host][`${kind}|${state}`] = captureRequirementsFor(host, kind, state).map(selectorOf);
      }
    }
  }
  return out;
}

/** One requirement, reduced to the claim it makes about the DOM. */
function selectorOf(spec) {
  return [
    spec.selector,
    spec.scope ?? "frame",
    spec.expect ?? "present",
    spec.within ?? "",
    spec.tier ?? "canonical",
  ].join(" ");
}

/**
 * The digest inputs, assembled. `specCommit` comes from the MANIFEST — the pin
 * the program declares — so the anchor file's own copy of it is a readable
 * mirror rather than the authority.
 */
export function anchorDigestInputs({ specCommit, domExpectations, captureAnchors }) {
  return { specCommit, domExpectations, captureAnchors };
}

export function computeAnchorDigest(inputs) {
  return createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

export function loadAnchorContract(path = ANCHOR_CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Judge the anchor contract against the manifest's pin, its own recorded DOM
 * expectations and the live capture requirements.
 *
 * Pure over injected values so the pinned tests drive the same validator CI runs.
 */
export function auditAnchorContract({
  anchorContract = loadAnchorContract(),
  manifest,
  captureAnchors = captureAnchorExpectations(),
} = {}) {
  const violations = [];
  const pin = manifest?.specCommit;
  if (typeof pin !== "string" || pin.length === 0) {
    violations.push("the acceptance manifest declares no `specCommit` — there is no design pin to bind to");
    return violations;
  }
  if (typeof anchorContract?.specCommit !== "string" || anchorContract.specCommit.length === 0) {
    violations.push("the anchor contract declares no `specCommit`");
    return violations;
  }
  if (anchorContract.specCommit !== pin) {
    violations.push(
      `the design pin moved: the manifest pins\n      ${pin}\n    and the anchor contract still reads\n      ${anchorContract.specCommit}\n    ` +
        "— re-ratify the anchor contract at the new pin (see --print-anchor-digest)",
    );
  }
  const dom = anchorContract.domExpectations;
  if (!dom || typeof dom !== "object" || !dom.carriage || !dom.hostParity) {
    violations.push("the anchor contract records no `domExpectations.carriage` / `.hostParity`");
    return violations;
  }
  for (const kind of ANCHOR_CONTRACT_KINDS) {
    if (!dom.carriage[kind]) violations.push(`the anchor contract records no carriage anchors for "${kind}"`);
    if (!dom.hostParity[kind]) violations.push(`the anchor contract records no host parity for "${kind}"`);
  }
  if (typeof anchorContract.digest !== "string" || !/^[0-9a-f]{64}$/.test(anchorContract.digest)) {
    violations.push("the anchor contract records no sha256 `digest`");
    return violations;
  }
  const recomputed = computeAnchorDigest(
    anchorDigestInputs({ specCommit: pin, domExpectations: dom, captureAnchors }),
  );
  if (recomputed !== anchorContract.digest) {
    violations.push(
      `the anchor digest is stale: recorded ${anchorContract.digest}, recomputed ${recomputed} ` +
        "— the design pin, the executable DOM expectations or the capture requirements moved; " +
        "re-examine the anchors and record the new digest",
    );
  }
  return violations;
}
