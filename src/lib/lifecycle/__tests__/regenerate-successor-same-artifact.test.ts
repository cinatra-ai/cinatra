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
// SO THE LINEAGE VALIDATOR IS WHERE IT IS KEPT. `validateRepairLineage` is the
// one gate every repair response passes through before a successor gate is
// pinned, so the sentence is enforced there rather than trusted to each
// producer. A successor over a different artifact is refused unless the caller
// DECLARES it — and the only caller that may declare it is the CMS bridge,
// whose successor is a genuinely re-staged remote snapshot rather than a new
// revision of the reviewed work.

import { describe, expect, it } from "vitest";

import {
  validateRepairLineage,
  type ChangesRequestedRequest,
  type RepairResponse,
} from "../lifecycle-repair";

const BASE_ARTIFACT = "90dbf854-artifact";
const BASE_REVISION = "588f62bb-revision";
/** The revision the ninth round's repair actually produced, over its own new artifact. */
const OTHER_ARTIFACT = "d8eca6bd-artifact";
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

  it("REFUSES the ninth round's own shape — a successor over a different artifact", () => {
    const r = validateRepairLineage({
      request,
      response: responseWith({
        artifactId: OTHER_ARTIFACT,
        representationRevisionId: NEW_REVISION,
      }),
      currentBaseRevisionId: BASE_REVISION,
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: "successor-different-artifact" });
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

  it("ALLOWS a different artifact only where the HOST grants a re-staged successor", () => {
    // §VI's exception is the host's to grant, at its own in-host call site (the
    // CMS bridge), and it is passed BESIDE the response.
    expect(
      validateRepairLineage({
        request,
        response: responseWith({
          artifactId: OTHER_ARTIFACT,
          representationRevisionId: NEW_REVISION,
        }),
        currentBaseRevisionId: BASE_REVISION,
        restagedSuccessorPermitted: true,
      }),
    ).toEqual({ ok: true });
  });

  it("a PRODUCER cannot grant itself the exception — a response payload declaring it is still refused", () => {
    // THE CONVERGENCE FINDING THIS PINS (cinatra#3080, fix leg 8). For one round
    // the exception rode in `RepairResponse` — the payload a producing RUN
    // submits — so any producer could have declared its way past §VI's rule and
    // the refusal would have been documentary. The grant is now the host's
    // argument, and a response carrying the old word changes nothing.
    const forged = {
      ...responseWith({
        artifactId: OTHER_ARTIFACT,
        representationRevisionId: NEW_REVISION,
      }),
      successorIsRestagedArtifact: true,
    } as RepairResponse;
    expect(
      validateRepairLineage({
        request,
        response: forged,
        currentBaseRevisionId: BASE_REVISION,
      }),
    ).toMatchObject({ ok: false, code: "successor-different-artifact" });
  });
});
