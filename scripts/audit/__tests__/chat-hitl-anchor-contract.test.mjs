// THE DESIGN-CONTRACT DRIFT ALARM, from both sides (cinatra#2826, epic #2784 S9m).
//
// The alarm exists because three artifacts describe the same cards and none of
// them can see the other two: the design PIN the acceptance manifest declares,
// the EXECUTABLE DOM expectations the suites assert, and the ANCHORS a capture
// is graded against. A pin bumped on its own leaves every green check asserting
// yesterday's drawing, and nothing anywhere goes red.
//
// What is held here:
//
//   1. THE REAL CONTRACT is ratified right now — the recorded pin matches the
//      manifest's, and the recorded digest matches the one recomputed from the
//      live capture requirements.
//   2. A CHANGED PIN WITHOUT A RE-RATIFIED DIGEST FAILS, which is the issue's
//      acceptance criterion stated exactly. It fails twice over — the mirrored
//      pin no longer matches, and the digest was taken over the old pin — and
//      the second half is the one that cannot be satisfied by copying a string.
//   3. EVERY OTHER INPUT MOVING FAILS TOO: a renamed anchor, a changed host
//      cell, a changed capture requirement.
//   4. THE CLI REFUSES IT, not just the library, and refuses it before it can
//      report anything else as clean.
//
//   node --test is not used here; this runs in the root vitest project, which
//   already includes scripts/audit/__tests__.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_OWNED_CAPTURE_CONTROLS,
  ANCHOR_CONTRACT_PATH,
  ANCHOR_CONTRACT_KINDS,
  anchorDigestInputs,
  auditAnchorContract,
  canonicalJson,
  captureAnchorExpectations,
  computeAnchorDigest,
  isAgentOwnedCaptureControl,
  loadAnchorContract,
} from "../lib/anchor-contract.mjs";
import {
  CAPTURE_HOSTS,
  CAPTURE_STATES,
  captureHostAdmissibility,
  captureRequirementsFor,
} from "../lib/chat-hitl-capture-recorder.mjs";
import { CARD_KINDS } from "../../ci/lib/capture-record-contract.mjs";
import { MANIFEST_PATH } from "../chat-hitl-acceptance-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-acceptance-gate.mjs");

const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const contract = () => loadAnchorContract();
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// 1. The contract as it stands
// ---------------------------------------------------------------------------

describe("the anchor contract is ratified at the manifest's design pin", () => {
  it("passes against the real manifest and the live capture requirements", () => {
    expect(auditAnchorContract({ anchorContract: contract(), manifest: manifest() })).toEqual([]);
  });

  it("mirrors the manifest's pin rather than declaring its own", () => {
    expect(contract().specCommit).toBe(manifest().specCommit);
  });

  it("records DOM expectations for every ruled kind", () => {
    const dom = contract().domExpectations;
    for (const kind of ANCHOR_CONTRACT_KINDS) {
      expect(dom.carriage[kind], `${kind} carriage`).toBeTruthy();
      expect(dom.hostParity[kind], `${kind} host parity`).toBeTruthy();
    }
  });

  it("names the mandatory conversation host in every kind's parity row", () => {
    const parity = contract().domExpectations.hostParity;
    for (const kind of ANCHOR_CONTRACT_KINDS) {
      const row = parity[kind];
      const recorded = Object.keys(row.hosts).includes("chat_thread");
      expect(recorded || row.owed.includes("chat_thread"), kind).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A changed design pin fails the manifest gate
// ---------------------------------------------------------------------------

describe("a changed design pin without a re-ratified anchor digest fails", () => {
  it("refuses the moved pin AND the digest taken over the old one", () => {
    const moved = { ...manifest(), specCommit: "design@0000000000000000000000000000000000000000 specs/app-lifecycle-cards.html" };
    const violations = auditAnchorContract({ anchorContract: contract(), manifest: moved });
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations.join("\n")).toContain("the design pin moved");
    expect(violations.join("\n")).toContain("the anchor digest is stale");
  });

  it("copying the pin across is NOT re-ratification — the digest still fails", () => {
    const movedPin = "design@0000000000000000000000000000000000000000 specs/app-lifecycle-cards.html";
    const moved = { ...manifest(), specCommit: movedPin };
    const mirrored = { ...contract(), specCommit: movedPin };
    const violations = auditAnchorContract({ anchorContract: mirrored, manifest: moved });
    expect(violations.join("\n")).not.toContain("the design pin moved");
    expect(violations.join("\n")).toContain("the anchor digest is stale");
  });

  it("a genuine re-ratification at the new pin passes", () => {
    const movedPin = "design@0000000000000000000000000000000000000000 specs/app-lifecycle-cards.html";
    const moved = { ...manifest(), specCommit: movedPin };
    const reratified = {
      ...contract(),
      specCommit: movedPin,
      digest: computeAnchorDigest(
        anchorDigestInputs({
          specCommit: movedPin,
          domExpectations: contract().domExpectations,
          captureAnchors: captureAnchorExpectations(),
          // the fourth input, recorded by the adoption road: a re-ratification
          // that left it out would produce a digest over three of the four.
          anchorsUnresolvedAtPin: contract().anchorsUnresolvedAtPin,
        }),
      ),
    };
    expect(auditAnchorContract({ anchorContract: reratified, manifest: moved })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The other two inputs
// ---------------------------------------------------------------------------

describe("every digest input is really an input", () => {
  it("a RENAMED anchor invalidates the digest", () => {
    const drifted = clone(contract());
    drifted.domExpectations.carriage.artifact_review_gate.ownerAnchors = [
      '[data-conformance-id="review-card"]',
    ];
    expect(
      auditAnchorContract({ anchorContract: drifted, manifest: manifest() }).join("\n"),
    ).toContain("the anchor digest is stale");
  });

  // The added cell must be one the contract does NOT already record, or the
  // clone is byte-identical and the discriminator proves nothing. The subject
  // has moved twice for exactly that reason: `verification_summary` stopped
  // being it when S9e (cinatra#2789) landed its run-card and gate-region
  // mounts, and `trigger_schedule_proposal` stopped being it when S9d
  // (cinatra#2788) landed the same two. `recommendation_hold` is what is left —
  // a typed interrupt with no gate-region cell recorded on any row.
  it("a HOST CELL CHANGED on the parity row invalidates the digest", () => {
    // It used to ADD `page_gate_region` to this row, because that cell was the
    // one `recommendation_hold` did not have. cinatra#2790 (S9f) gave it all
    // four, so adding is no longer a mutation at all — the assertion would pass
    // vacuously against an unchanged document. Changing a cell that IS there
    // exercises the same input by the same path, and cannot go quiet the way an
    // add did once the row filled up.
    const drifted = clone(contract());
    drifted.domExpectations.hostParity.recommendation_hold.hosts.chat_thread = "composition";
    expect(
      auditAnchorContract({ anchorContract: drifted, manifest: manifest() }).join("\n"),
    ).toContain("the anchor digest is stale");
  });

  it("a CHANGED capture requirement invalidates the digest", () => {
    const live = captureAnchorExpectations();
    const changed = clone(live);
    const host = Object.keys(changed)[0];
    changed[host]["*"] = [...changed[host]["*"], '[data-something-new] frame present  canonical'];
    expect(
      auditAnchorContract({
        anchorContract: contract(),
        manifest: manifest(),
        captureAnchors: changed,
      }).join("\n"),
    ).toContain("the anchor digest is stale");
  });

  it("a contract with no digest at all is refused rather than skipped", () => {
    const withoutDigest = clone(contract());
    delete withoutDigest.digest;
    expect(
      auditAnchorContract({ anchorContract: withoutDigest, manifest: manifest() }).join("\n"),
    ).toContain("records no sha256");
  });

  it("a manifest with no design pin is refused", () => {
    const withoutPin = clone(manifest());
    delete withoutPin.specCommit;
    expect(
      auditAnchorContract({ anchorContract: contract(), manifest: withoutPin }).join("\n"),
    ).toContain("no `specCommit`");
  });
});

// ---------------------------------------------------------------------------
// 4. The digest itself
// ---------------------------------------------------------------------------

describe("the digest is a digest, not a formatting fingerprint", () => {
  it("canonical JSON is key-order independent and array-order sensitive", () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe(canonicalJson({ b: [1, 2], a: 1 }));
    expect(canonicalJson({ b: [1, 2] })).not.toBe(canonicalJson({ b: [2, 1] }));
  });

  it("the same inputs always produce the same digest", () => {
    const inputs = anchorDigestInputs({
      specCommit: "pin",
      domExpectations: contract().domExpectations,
      captureAnchors: captureAnchorExpectations(),
    });
    expect(computeAnchorDigest(inputs)).toBe(computeAnchorDigest(clone(inputs)));
  });

  it("the note says how many inputs the digest really has, and names them all", () => {
    // The note is what a reader consults before touching this file, so a stale
    // input count there sends them to re-ratify over the wrong inputs. The
    // definition sentence is held to the shape the engine actually hashes:
    // once anchorsUnresolvedAtPin is recorded it is an input like the others.
    const definition = contract().note.slice(0, contract().note.indexOf("Moving the design pin"));
    const recorded = Array.isArray(contract().anchorsUnresolvedAtPin);
    expect(definition).toContain(recorded ? "exactly four inputs" : "exactly three inputs");
    expect(definition).toContain("specCommit");
    expect(definition).toContain("domExpectations");
    expect(definition).toContain("chat-hitl-capture-recorder.mjs");
    if (recorded) expect(definition).toContain("anchorsUnresolvedAtPin");
  });

  it("the recorded digest is the one the inputs really produce", () => {
    expect(contract().digest).toBe(
      computeAnchorDigest(
        anchorDigestInputs({
          specCommit: manifest().specCommit,
          domExpectations: contract().domExpectations,
          captureAnchors: captureAnchorExpectations(),
          anchorsUnresolvedAtPin: contract().anchorsUnresolvedAtPin,
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The CLI refuses it too
// ---------------------------------------------------------------------------

describe("the entrypoint carries the alarm", () => {
  it("prints the recomputed digest without writing anything", () => {
    const before = readFileSync(ANCHOR_CONTRACT_PATH, "utf8");
    const run = spawnSync(process.execPath, [GATE, "--print-anchor-digest"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("recomputed  :");
    expect(readFileSync(ANCHOR_CONTRACT_PATH, "utf8")).toBe(before);
  });

  it("a stale anchor contract makes the gate exit 1, ahead of every other claim", () => {
    // The gate reads its own paths, so the drift is staged in a COPY of the tree
    // rather than by mutating the repo's committed contract.
    const dir = mkdtempSync(join(tmpdir(), "anchor-drift-"));
    const staleContract = clone(contract());
    staleContract.digest = "f".repeat(64);
    const stalePath = join(dir, "chat-hitl-anchor-contract.json");
    writeFileSync(stalePath, JSON.stringify(staleContract));
    const violations = auditAnchorContract({
      anchorContract: JSON.parse(readFileSync(stalePath, "utf8")),
      manifest: manifest(),
    });
    expect(violations.join("\n")).toContain("the anchor digest is stale");

    // …and the live entrypoint, on the real tree, gets past the anchor arm — so
    // the arm is wired in and is not the thing failing today.
    const run = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
    expect(run.stderr).not.toContain("anchor-contract violation");
  });
});

// ---------------------------------------------------------------------------
// 5. The fifth kind is inside the alarm (cinatra#2930, lifecycle-b W3)
// ---------------------------------------------------------------------------
//
// `agent_hitl_screen` was ruled a kind before it had a card and is drawn now.
// It is covered here the way the other four are — and the two host cells that
// have no reachable subject record their REASON where their anchors would be,
// so making one capturable later, or changing why it is not, moves the digest
// exactly as renaming an anchor does.

describe("the fifth kind is covered by the same alarm", () => {
  const KIND = "agent_hitl_screen";

  it("is one of the ruled kinds", () => {
    expect([...ANCHOR_CONTRACT_KINDS]).toContain(KIND);
  });

  it("records the anchors a capture of it is graded against, on the hosts it can be photographed on", () => {
    const anchors = captureAnchorExpectations();
    expect(anchors.chat_thread[`${KIND}|pending`]).toEqual(
      expect.arrayContaining([expect.stringContaining('[data-conformance-id="hitl-screen-fields"]')]),
    );
    expect(anchors.run_card[`${KIND}|pending`]).toEqual(
      expect.arrayContaining([expect.stringContaining(`[data-lifecycle-card="${KIND}"]`)]),
    );
  });

  it("records the reason where a cell has no reachable subject", () => {
    const anchors = captureAnchorExpectations();
    for (const host of ["site_widget", "page_gate_region"]) {
      for (const state of ["pending", "decided"]) {
        expect(anchors[host][`${KIND}|${state}`], `${host}|${state}`).toEqual([
          expect.stringContaining("composition-only"),
        ]);
      }
    }
  });

  it("a composition-only cell quietly made capturable does NOT stay ratified", () => {
    const anchors = captureAnchorExpectations();
    const loosened = JSON.parse(JSON.stringify(anchors));
    loosened.site_widget[`${KIND}|pending`] = ["[data-conversation-list] frame present  canonical"];
    const digest = computeAnchorDigest(
      anchorDigestInputs({
        specCommit: manifest().specCommit,
        domExpectations: contract().domExpectations,
        captureAnchors: loosened,
      }),
    );
    expect(digest).not.toBe(contract().digest);
  });

  it("the settled reading of this kind is an absence, and the digest carries that", () => {
    const anchors = captureAnchorExpectations();
    const decided = anchors.chat_thread[`${KIND}|decided`].join("\n");
    expect(decided).toContain(`[data-lifecycle-card="${KIND}"] frame absent`);
    expect(decided).not.toContain(`[data-lifecycle-card="${KIND}"] frame present`);
  });
});

// ---------------------------------------------------------------------------
// 6. An agent card's own controls are not anchors of this contract (cinatra#3677)
// ---------------------------------------------------------------------------
//
// The governed drawings draw the core lifecycle screens and the one generic
// input card, never an agent card's own buttons. Four capture requirements
// named such buttons and could never resolve in a governed drawing, which kept
// design-anchor-resolution red on main. The contract leaves exactly those four
// out of the cells of the kind that owns each, and records everything else the
// recorder computes, unchanged.

describe("an agent card's own controls are not anchors of this contract", () => {
  const SKILL_CONTROLS = [
    '[data-skill-action="confirm"]',
    '[data-skill-action="adjust"]',
    '[data-skill-action="skip"]',
  ];
  const SCHEDULE_CONFIRM = '[data-action="confirm-schedule-proposal"]';
  const FOUR = [...SKILL_CONTROLS, SCHEDULE_CONFIRM];
  // The serialized shape `captureAnchorExpectations` records, spelled here so
  // the comparison below does not borrow the code it checks.
  const serialized = (spec) =>
    [spec.selector, spec.scope ?? "frame", spec.expect ?? "present", spec.within ?? "", spec.tier ?? "canonical"].join(" ");

  it("names exactly the four controls, each under the kind that owns it, as a frozen list", () => {
    expect(AGENT_OWNED_CAPTURE_CONTROLS).toEqual({
      recommendation_hold: SKILL_CONTROLS,
      trigger_schedule_proposal: [SCHEDULE_CONFIRM],
    });
    expect(Object.isFrozen(AGENT_OWNED_CAPTURE_CONTROLS)).toBe(true);
    for (const list of Object.values(AGENT_OWNED_CAPTURE_CONTROLS)) expect(Object.isFrozen(list)).toBe(true);
  });

  it("records none of the four in any cell of the live capture anchors", () => {
    const anchors = captureAnchorExpectations();
    for (const [host, cells] of Object.entries(anchors)) {
      for (const [cell, entries] of Object.entries(cells)) {
        for (const entry of entries) {
          for (const selector of FOUR) {
            expect(entry.startsWith(`${selector} `), `${host} ${cell}: ${entry}`).toBe(false);
          }
        }
      }
    }
  });

  it("leaves out only those, and records every other requirement exactly as the recorder computes it", () => {
    const anchors = captureAnchorExpectations();
    expect(Object.keys(anchors).sort()).toEqual([...CAPTURE_HOSTS].sort());
    for (const host of CAPTURE_HOSTS) {
      expect(anchors[host]["*"]).toEqual(captureRequirementsFor(host).map(serialized));
      for (const kind of ANCHOR_CONTRACT_KINDS) {
        if (!captureHostAdmissibility(kind, host).capturable) continue;
        const owned = AGENT_OWNED_CAPTURE_CONTROLS[kind] ?? [];
        for (const state of CAPTURE_STATES) {
          const expected = captureRequirementsFor(host, kind, state)
            .filter((spec) => !owned.includes(spec.selector))
            .map(serialized);
          expect(anchors[host][`${kind}|${state}`], `${host} ${kind}|${state}`).toEqual(expected);
        }
      }
    }
  });

  it("excuses a control only in the cells of the kind that owns it", () => {
    for (const selector of SKILL_CONTROLS) {
      expect(isAgentOwnedCaptureControl("recommendation_hold", selector)).toBe(true);
      expect(isAgentOwnedCaptureControl("trigger_schedule_proposal", selector)).toBe(false);
    }
    expect(isAgentOwnedCaptureControl("trigger_schedule_proposal", SCHEDULE_CONFIRM)).toBe(true);
    expect(isAgentOwnedCaptureControl("recommendation_hold", SCHEDULE_CONFIRM)).toBe(false);
    for (const kind of ["artifact_review_gate", "verification_summary", "agent_hitl_screen", "constructor", "__proto__", null]) {
      for (const selector of FOUR) expect(isAgentOwnedCaptureControl(kind, selector)).toBe(false);
    }
  });

  it("never excuses an owner anchor, a ruled root, a card root or a host or state marker", () => {
    const carriage = contract().domExpectations.carriage;
    const recorded = Object.values(carriage).flatMap((row) => [...row.ownerAnchors, ...row.ruledRootAnchors]);
    const roots = Object.values(CARD_KINDS).map((spec) => spec.root);
    for (const selector of Object.values(AGENT_OWNED_CAPTURE_CONTROLS).flat()) {
      expect(recorded).not.toContain(selector);
      expect(roots).not.toContain(selector);
      expect(selector.startsWith("[data-lifecycle-card")).toBe(false);
      expect(selector.startsWith("[data-conformance-id")).toBe(false);
    }
  });

  it("records the unresolved set as EMPTY at the pin, present rather than absent", () => {
    expect(contract().anchorsUnresolvedAtPin).toEqual([]);
  });
});
