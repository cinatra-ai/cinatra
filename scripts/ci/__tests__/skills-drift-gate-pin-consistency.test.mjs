// PIN-CONSISTENCY guard for the skills-drift caller's coupled engine pins.
//
// The caller double-pins the reusable cinatra-ai/ci engine: the workflow ref
// (`uses: ...@<sha>`) and the `with.ref` engine-checkout input must name the
// SAME commit, or the caller runs one engine and checks out another. Both,
// plus the version comment's short SHA, advance in ONE commit.
//
// EXPECTED_PIN is deliberately a literal, the same pattern the sibling
// truthful-attribution-pin-consistency.test.mjs uses: a later advance reds
// here and sends the editor back to move the pair together rather than
// discovering the mismatch as a fail-closed gate arm in CI.
//
// This pin (cinatra-ai/ci e643ec2e) carries the fix for the acknowledgement
// step dying with "Argument list too long" on a long pull request body: the
// body now travels by file, never as a process argument.
//
// The caller's path is IMPORTED from skills-drift-watched-packages.mjs rather
// than spelled here, the same discipline the sibling derivation tests follow,
// so this file stays fully under the source-leak scanner.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GATE_CALLER } from "../skills-drift-watched-packages.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPECTED_PIN = "e643ec2ef8474bae81bd93fabb87de09a701c8ad";
const SUPERSEDED_PIN = "58cf9476819aa528b711d4cce59ee24049a728ce";

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const caller = fs.readFileSync(path.join(REPO_ROOT, GATE_CALLER), "utf8");

describe("skills-drift caller engine pins advance together", () => {
  it("pins the caller `uses:` to the expected cinatra-ai/ci commit", () => {
    const m = caller.match(
      new RegExp(`uses:\\s*cinatra-ai/ci/${escape(GATE_CALLER)}@([0-9a-f]{40})`),
    );
    expect(m, `no pinned uses: line in ${GATE_CALLER}`).not.toBeNull();
    expect(m[1]).toBe(EXPECTED_PIN);
  });

  it("pins the caller's `ref:` engine-checkout input to the same commit", () => {
    const m = caller.match(/\n\s*ref:\s*([0-9a-f]{40})/);
    expect(m, `no with.ref pin in ${GATE_CALLER}`).not.toBeNull();
    expect(m[1]).toBe(EXPECTED_PIN);
  });

  it("carries a version comment whose short SHA matches the pin", () => {
    const m = caller.match(new RegExp(`${escape(path.basename(GATE_CALLER))}@[0-9a-f]{40}\\s*#\\s*(\\S+)`));
    expect(m, `no version comment on the uses: line in ${GATE_CALLER}`).not.toBeNull();
    expect(m[1].endsWith(`.${EXPECTED_PIN.slice(0, 7)}`)).toBe(true);
  });

  it("leaves no reference to the superseded engine commit in the caller", () => {
    expect(caller.includes(SUPERSEDED_PIN)).toBe(false);
  });
});
