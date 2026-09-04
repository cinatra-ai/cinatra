// ---------------------------------------------------------------------------
// The per-output ladder of the default road (Agents Lifecycle (C) item 0.17,
// section 3 "The default road, in one paragraph").
//
//   "Each output is written once, by the first rung that claims it: a binding on
//    that output, which names the extension; else the agent's declared
//    `produces`, when it names exactly one artifact-safe type whose accepted
//    forms include the output's detected form — the dependency wins PER OUTPUT,
//    never as a switch over the whole agent; [...] else the base extension for
//    the form the detection ladder (item 0.18) finds — markdown, plain text,
//    structured data, image, pdf, and the rest; and, when no rung can name the
//    form, the binary base, whose display is the download card."
//
// The BINDING rung is not here: a bound output never reaches the default road at
// all — the run materializer owns it and the capture excludes it by name
// (`selectEndNodeOutputPickupItems`'s `boundOutputNames`). What is here is the
// remaining three, PURE, so the whole ladder is table-testable without a
// registry, a database or a model.
//
// The third rung is the UPLOAD's exactly-one rule, called with the DETECTED
// form — not a second implementation of it. `resolveUploadArtifactTypeFromCandidates`
// is the one rule; this module supplies its candidates and reads its refusal.
// ---------------------------------------------------------------------------

import {
  resolveUploadArtifactTypeFromCandidates,
  type UploadArtifactTypeCandidate,
} from "./upload-artifact-type-map";

/** Which rung of the per-output ladder claimed the output. */
export type DefaultRoadTargetRung = "declared_kind" | "form_base" | "binary_base";

/** One candidate type, with the extension that DEFINES it. */
export type DefaultRoadTargetCandidate = {
  objectTypeId: string;
  /** The defining extension package — the ledger row's `extension` column and
   *  the producer assertion's scope. */
  extension: string;
  acceptMimes: readonly string[];
};

export type DefaultRoadTarget = {
  rung: DefaultRoadTargetRung;
  extension: string;
  objectTypeId: string;
  acceptedFileMimeTypes: string[];
  reason: string;
};

export type DefaultRoadTargetRefusal = {
  /**
   * `no_base_installed` — the detected form has no installed required-base home
   * at all. For `application/octet-stream` this is the BINARY BASE rung, and it
   * is the state this repository is in until the binary base exists (see the
   * named deviation on the pull request): the verdict is recorded, and no
   * artifact is minted under a type nothing owns.
   *
   * `ambiguous` — more than one required base accepts the form. Item 0.18: "Two
   * installed bases claiming one form is a packaging defect refused at install
   * (item 0.8), never a run-time guess."
   */
  reason: "no_base_installed" | "ambiguous";
  /** The rung the ladder had reached when it refused. */
  rung: DefaultRoadTargetRung;
  form: string;
  matched: string[];
  detail: string;
};

export type DefaultRoadTargetResult =
  | ({ ok: true } & DefaultRoadTarget)
  | ({ ok: false } & DefaultRoadTargetRefusal);

/** The form the binary base owns — the rung of last resort, whose display is
 *  the download card. */
export const BINARY_BASE_FORM = "application/octet-stream";

function acceptsForm(candidate: DefaultRoadTargetCandidate, form: string): boolean {
  const single: UploadArtifactTypeCandidate = {
    objectTypeId: candidate.objectTypeId,
    acceptMimes: candidate.acceptMimes,
  };
  return resolveUploadArtifactTypeFromCandidates(form, [single]).ok;
}

/**
 * Run the per-output ladder for ONE detected form.
 *
 * `declaredKinds` are the agent's declared `produces`, already resolved to
 * artifact-safe targets. `bases` are the installed REQUIRED-base artifact types
 * (`selectRequiredArtifactUploadCandidates`'s domain), each with its definer.
 */
export function resolveDefaultRoadTarget(input: {
  form: string;
  declaredKinds: readonly DefaultRoadTargetCandidate[];
  bases: readonly DefaultRoadTargetCandidate[];
}): DefaultRoadTargetResult {
  const form = (input.form.split(";", 1)[0] ?? "").trim().toLowerCase();
  const isBinary = form === BINARY_BASE_FORM;
  const rung: DefaultRoadTargetRung = isBinary ? "binary_base" : "form_base";

  // ---- Rung 2: the agent's declared kind, PER OUTPUT ----------------------
  // "when it names EXACTLY ONE artifact-safe type whose accepted forms include
  // the output's detected form" — two accepting kinds is not a guess to make,
  // it is a declaration the agent has to settle.
  const accepting = input.declaredKinds.filter((c) => acceptsForm(c, form));
  const distinctAccepting = Array.from(
    new Map(accepting.map((c) => [c.objectTypeId, c])).values(),
  );
  if (distinctAccepting.length === 1) {
    const chosen = distinctAccepting[0];
    return {
      ok: true,
      rung: "declared_kind",
      extension: chosen.extension,
      objectTypeId: chosen.objectTypeId,
      acceptedFileMimeTypes: [...chosen.acceptMimes],
      reason: `the agent's declared kind "${chosen.objectTypeId}" accepts ${form}`,
    };
  }

  // ---- Rung 3 / 4: the form's base, by the UPLOAD's exactly-one rule ------
  const byType = new Map(input.bases.map((b) => [b.objectTypeId, b]));
  const resolved = resolveUploadArtifactTypeFromCandidates(
    form,
    input.bases.map((b) => ({ objectTypeId: b.objectTypeId, acceptMimes: b.acceptMimes })),
  );
  if (resolved.ok) {
    const base = byType.get(resolved.objectTypeId)!;
    return {
      ok: true,
      rung,
      extension: base.extension,
      objectTypeId: base.objectTypeId,
      acceptedFileMimeTypes: [...base.acceptMimes],
      reason: isBinary
        ? `the binary base "${base.objectTypeId}" owns ${form}`
        : `the base for ${form} is "${base.objectTypeId}" by the exactly-one rule`,
    };
  }
  if (resolved.kind === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous",
      rung,
      form,
      matched: resolved.matched,
      detail:
        `two installed bases claim ${form} [${resolved.matched.join(", ")}] — a packaging ` +
        "defect refused at install, never a run-time guess",
    };
  }
  return {
    ok: false,
    reason: "no_base_installed",
    rung,
    form,
    matched: [],
    detail: isBinary
      ? `no installed required base owns ${form}: the binary base is not in the required set`
      : `no installed required base accepts ${form}`,
  };
}
