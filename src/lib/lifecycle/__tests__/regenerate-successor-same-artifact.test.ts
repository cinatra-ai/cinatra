// REGENERATE FILES A NEW REVISION OF THE **SAME** ARTIFACT (cinatra#3080, fix leg 8).
//
// WHAT THE NINTH ROUND FOUND. A real run's Regenerate settled gate `d6301eed`
// — pinned on artifact `90dbf854` / revision `588f62bb` — and raised its
// successor `096296ae` pinned on artifact `d8eca6bd` / revision `f2434774`. A
// DIFFERENT artifact. The reviewer decided on one thing and the successor
// carried another, with no lineage on the artifact itself joining them.
//
// THE DRAWING, IN ITS OWN WORDS. "Regenerate runs the same producing step again
// from the words in the note field, files a NEW REVISION OF THE SAME ARTIFACT,
// and settles this gate superseded beneath a successor over that same artifact;
// nothing is interpreted and no new work is planned." (Agent run & review §VI.)
// And earlier in the same section: "Regenerate sends the work back to be made
// again from the words in the note field, settles this gate as superseded, and
// raises its successor over the new revision."
//
// WHERE IT IS KEPT. The generic completer re-files the repair run's production
// onto the reviewed artifact before it submits the repair response, so the
// successor is a new revision of the same artifact by construction; the repair
// dispatch integration suite pins that on the real store. The lineage validator
// below keeps its own rules for every artifact alike: a new revision of the
// reviewed artifact is accepted, and a successor identical to the base is not.

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateRepairLineage,
  type ChangesRequestedRequest,
  type RepairResponse,
} from "../lifecycle-repair";

const BASE_ARTIFACT = "90dbf854-artifact";
const BASE_REVISION = "588f62bb-revision";
const NEW_REVISION = "f2434774-revision";

const request: ChangesRequestedRequest = {
  gateId: "d6301eed",
  decisionId: "repair-1",
  idempotencyKey: "idem-1",
  baseTarget: { artifactId: BASE_ARTIFACT, representationRevisionId: BASE_REVISION },
  expectedBaseRevisionId: BASE_REVISION,
  findings: [{ id: "f1", message: "Tighten the opening paragraph." }],
  continuationMode: "checkpointed",
  continuationAddress: null,
};

function responseWith(successor: { artifactId: string; representationRevisionId: string }): RepairResponse {
  return {
    gateId: request.gateId,
    baseTarget: request.baseTarget,
    successorTarget: successor,
    findingOutcomes: [{ findingId: "f1", applied: true }],
    changeSummary: "Opening paragraph tightened.",
    producerProvenance: { runId: null, agentId: null },
  };
}

describe("§VI — Regenerate's successor is a new revision of the SAME artifact", () => {
  it("ACCEPTS a successor that is a new revision of the reviewed artifact", () => {
    const r = validateRepairLineage({
      request,
      response: responseWith({
        artifactId: BASE_ARTIFACT,
        representationRevisionId: NEW_REVISION,
      }),
      currentBaseRevisionId: BASE_REVISION,
    });
    expect(r).toEqual({ ok: true });
  });

  it("still refuses a successor identical to the base — a repair produces a NEW revision", () => {
    const r = validateRepairLineage({
      request,
      response: responseWith({
        artifactId: BASE_ARTIFACT,
        representationRevisionId: BASE_REVISION,
      }),
      currentBaseRevisionId: BASE_REVISION,
    });
    expect(r).toMatchObject({ ok: false, code: "successor-equals-base" });
  });
});

// THE GENERIC COMPLETER NAMES NO ARTIFACT TYPE (cinatra#3080). The completer
// that turns a repair run's work into the successor claims only what the run
// FILED through the host's two generic filing roads — the create road and the
// revision-append road — and nothing else: a capture or snapshot row the host
// writes on its own is no filing of the run. Read from the source text (the same
// technique as the agents package's structural pins): the invariant is a module
// constant, a query operand and the absence of any one-type branch, with no
// runtime to drive for any of them.
const COMPLETER_SOURCE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages/agents/src/lifecycle-repair-producer-completion-store.ts",
);

function completerSource(): string {
  return readFileSync(COMPLETER_SOURCE, "utf8");
}

describe("the generic completer claims a run's own filings and names no artifact type", () => {
  it("names the run's filing roads once, in RUN_FILING_EMITTERS: exactly the create road and the append road", () => {
    const source = completerSource();
    const declared = source.match(/const RUN_FILING_EMITTERS\b[^=]*=\s*\[([^\]]*)\]/);
    expect(declared).not.toBeNull();
    const literals = [...(declared?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(literals).toEqual(["artifact_revision_append", "createSemanticArtifact"]);
  });

  it("claims a production only through those roads", () => {
    expect(completerSource()).toContain(
      "inArray(artifactProducedOutbox.emitter, RUN_FILING_EMITTERS)",
    );
  });

  it("names no cms in any case", () => {
    expect(completerSource()).not.toMatch(/cms/i);
  });

  it("imports nothing from the one-type production bridge", () => {
    expect(completerSource()).not.toContain("lifecycle-repair-cms-production-bridge");
  });
});
