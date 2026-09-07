import "server-only";
import { createHash } from "node:crypto";
import {
  DOCUMENT_FLOOR_BYTES,
  detectOutputForm,
  isAtOrAboveDocumentFloor,
  type DetectionRung,
  type DetectionVerdict,
  type LadderDeps,
} from "./output-detection-ladder";
import type { ScopeDerivedOwnership } from "./run-artifact-materializer";

// ---------------------------------------------------------------------------
// THE DEFAULT ROAD (cinatra#3029, epic #3023 — plan item 0.17 / section 3).
//
// "the pickup at terminal success, once per emitted file and once per end-node
//  output at or above the document floor that no binding names; content from the
//  output's value or the file's bytes, typed by the detection ladder; the agent's
//  declared kind when it accepts the form, else the base extension for the form
//  by the upload's exactly-one rule, else the binary base; a ledger row per
//  output or file with the deciding rung, a produced event, a match run for
//  meaning."
//
// THIS SLICE STOPS SHORT OF FILES — item 0.22 (emitted files) is W6, #3030.
// Only END-NODE OUTPUTS take the road here.
//
// It replaces the retired response-text derivation: the run's final response
// TEXT is not an output and takes no road (acceptance item 3); a datum below the
// document floor takes no road (item 2); bytes every rung refuses land under the
// binary base (item 4); and NOTHING is dropped with an advisory any more — the
// "not captured" notification retires with the old road.
//
// NEVER THROWS. The pickup runs on the terminal-success path beside the
// declarative binding rung, but it is NOT part of the #2486 materialization-
// honesty gate: a declared binding that fails is a broken promise and fails the
// run; an UNDECLARED output the default road could not file is a visible
// per-output outcome on the run's own record, never a run failure.
// ---------------------------------------------------------------------------

/** The reserved ledger id prefix. It carries a `:`, which an OAS node id and an
 *  EndNode output name cannot, so a default-road ledger row can never collide
 *  with an `end_node_binding` / `materialize_tool` row of the same run. */
export const DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX = "cinatra:end-node-output:";

/** The last rung of the target ladder: the form nothing else can home. */
export const BINARY_BASE_MIME = "application/octet-stream";

/** The reserved ledger id for one end-node output. */
export function defaultRoadLedgerOutputId(outputName: string): string {
  return `${DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX}${outputName}`;
}

/** Why an output took no road. */
export type DefaultRoadSkip =
  | "below_floor"
  | "bound"
  | "empty"
  | "duplicate_bytes";

/** One visible outcome per end-node output the pickup looked at. */
export type DefaultRoadPickupOutcome = {
  ok: boolean;
  /** The end-node output name. */
  outputId: string;
  /** The reserved ledger id this output writes under. */
  ledgerOutputId: string;
  /** The ladder's deciding rung, null when the output took no road. */
  rung: DetectionRung | null;
  /** The form the ladder named, null when the output took no road. */
  mime: string | null;
  /** The base the form resolved to, null when the output took no road. */
  extension: string | null;
  artifactId?: string;
  representationRevisionId?: string;
  deduped?: boolean;
  skipped?: DefaultRoadSkip;
  error?: string;
  /** Bytes considered (the floor decision's own number). */
  bytes: number;
};

/** The resolved write target for a form. */
export type DefaultRoadTarget = {
  extension: string;
  objectTypeId: string;
  acceptedFileMimeTypes: string[];
};

export type DefaultRoadPickupDeps = {
  /**
   * The per-output ladder of section 3 BELOW the binding rung: the agent's
   * declared kind when it accepts the form, else the base extension for the
   * form by the upload's exactly-one rule, else the binary base. `null` when
   * nothing accepts the form (the caller then records a visible outcome).
   */
  resolveTarget: (input: {
    orgId: string;
    mime: string;
    declaredKindExtension: string | null;
  }) => Promise<DefaultRoadTarget | null>;
  /** THE ONE WRITE PATH (`writeClaimedArtifact`). */
  write: (input: {
    runId: string;
    orgId: string;
    createdBy: string | null;
    outputId: string;
    nodeId: string | null;
    path: "default_road";
    extension: string;
    title: string;
    mime: string;
    content: string;
    ownership: ScopeDerivedOwnership;
    resolvedTarget: { objectTypeId: string; acceptedFileMimeTypes: string[] };
    mimeDescription: string;
    /** The ladder's recorded verdict — one ledger row per item carries it. */
    detection: DetectionVerdict;
  }) => Promise<
    | { ok: true; artifactId: string; representationRevisionId: string; deduped: boolean }
    | { ok: false; error: string }
  >;
  resolveOwnership: (input: {
    templateId: string;
    runId: string;
    orgId: string;
  }) => Promise<ScopeDerivedOwnership>;
  readRunTitleParts: (templateId: string) => Promise<{ agentName: string | null }>;
  /** The ladder's own seams (the model rung, its switch, its cache). */
  ladder?: LadderDeps;
};

export type DefaultRoadPickupInput = {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  createdBy: string | null;
  /** The run's structured EndNode outputs; null when the run declared none. */
  endNodeOutputs: Record<string, unknown> | null;
  /** The output names a declared binding already named (the binding rung). */
  boundOutputIds: readonly string[];
  /** The agent's declared kind, when it declares exactly one. */
  declaredKindExtension: string | null;
};

/** One end-node output's bytes plus the explicit statement it carries, if any. */
type OutputContent = {
  bytes: Uint8Array;
  /** The text the writer stores. */
  text: string;
  /** The explicit statement, when the value carries one (a data URI). */
  declaredMime: string | null;
  /** The value's own file name, when it carries one. Always null in this slice
   *  (files are W6, #3030) — kept so the ladder's name rung stays wired. */
  fileName: string | null;
};

const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(;charset=[\w-]+)?;base64,([A-Za-z0-9+/=\s]+)$/;

/** Content from the output's VALUE (the file half is W6). */
function readOutputContent(value: unknown): OutputContent | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const uri = DATA_URI.exec(value.trim());
    if (uri) {
      const bytes = new Uint8Array(Buffer.from(uri[3].replace(/\s+/g, ""), "base64"));
      return {
        bytes,
        // The bytes are carried to the writer as the data URI's own payload; the
        // writer stores UTF-8 text, so a binary payload keeps its base64 form.
        text: value,
        declaredMime: uri[1] ?? null,
        fileName: null,
      };
    }
    return {
      bytes: new TextEncoder().encode(value),
      text: value,
      declaredMime: null,
      fileName: null,
    };
  }
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== "string") return null;
  return {
    bytes: new TextEncoder().encode(text),
    text,
    declaredMime: null,
    fileName: null,
  };
}

/**
 * Run the default road over one terminally-successful run's end-node outputs.
 * NEVER throws: every refusal is a visible per-output outcome.
 */
export async function pickUpDefaultRoadOutputs(
  input: DefaultRoadPickupInput,
  deps: DefaultRoadPickupDeps,
): Promise<DefaultRoadPickupOutcome[]> {
  const outputs = input.endNodeOutputs;
  if (outputs === null || typeof outputs !== "object") return [];
  const names = Object.keys(outputs);
  if (names.length === 0) return [];

  const bound = new Set(input.boundOutputIds);
  // ONE model-rung cache per run: at most one call per DISTINCT ambiguous output.
  const ladderDeps: LadderDeps = {
    cache: new Map<string, DetectionVerdict>(),
    ...deps.ladder,
  };
  // Identical bytes within the run take the road ONCE.
  const seenHashes = new Map<string, string>();

  const outcomes: DefaultRoadPickupOutcome[] = [];
  let ownership: ScopeDerivedOwnership | null = null;
  let agentName: string | null = null;

  for (const name of names) {
    const ledgerOutputId = defaultRoadLedgerOutputId(name);
    const skip = (
      reason: DefaultRoadSkip,
      bytes: number,
    ): DefaultRoadPickupOutcome => ({
      ok: false,
      outputId: name,
      ledgerOutputId,
      rung: null,
      mime: null,
      extension: null,
      skipped: reason,
      bytes,
    });

    // The binding rung already named it — the default road does not run twice.
    if (bound.has(name)) {
      outcomes.push(skip("bound", 0));
      continue;
    }
    const content = readOutputContent(outputs[name]);
    if (content === null || content.bytes.byteLength === 0) {
      outcomes.push(skip("empty", 0));
      continue;
    }
    // The document floor: a datum below it takes no road.
    if (!isAtOrAboveDocumentFloor(content.bytes)) {
      outcomes.push(skip("below_floor", content.bytes.byteLength));
      continue;
    }
    const hash = createHash("sha256").update(content.bytes).digest("hex");
    if (seenHashes.has(hash)) {
      outcomes.push(skip("duplicate_bytes", content.bytes.byteLength));
      continue;
    }
    seenHashes.set(hash, name);

    let verdict: DetectionVerdict;
    try {
      verdict = await detectOutputForm(
        {
          orgId: input.orgId,
          bytes: content.bytes,
          declaredMime: content.declaredMime,
          fileName: content.fileName,
        },
        ladderDeps,
      );
    } catch (err) {
      outcomes.push({
        ok: false,
        outputId: name,
        ledgerOutputId,
        rung: null,
        mime: null,
        extension: null,
        error: `the detection ladder failed: ${err instanceof Error ? err.message : String(err)}`,
        bytes: content.bytes.byteLength,
      });
      continue;
    }

    try {
      // The per-output ladder of section 3 BELOW the binding rung, in order:
      // the agent's declared kind WHEN IT ACCEPTS THE FORM, else the base
      // extension for the form by the upload's exactly-one rule, else the
      // binary base.
      let target: DefaultRoadTarget | null = null;
      if (input.declaredKindExtension !== null) {
        target = await deps.resolveTarget({
          orgId: input.orgId,
          mime: verdict.mime,
          declaredKindExtension: input.declaredKindExtension,
        });
      }
      if (target === null) {
        target = await deps.resolveTarget({
          orgId: input.orgId,
          mime: verdict.mime,
          declaredKindExtension: null,
        });
      }
      if (target === null && verdict.mime !== BINARY_BASE_MIME) {
        target = await deps.resolveTarget({
          orgId: input.orgId,
          mime: BINARY_BASE_MIME,
          declaredKindExtension: null,
        });
      }
      if (target === null) {
        outcomes.push({
          ok: false,
          outputId: name,
          ledgerOutputId,
          rung: verdict.rung,
          mime: verdict.mime,
          extension: null,
          error: `no installed base accepts "${verdict.mime}"`,
          bytes: content.bytes.byteLength,
        });
        continue;
      }
      if (ownership === null) {
        ownership = await deps.resolveOwnership({
          templateId: input.templateId,
          runId: input.runId,
          orgId: input.orgId,
        });
        agentName = (await deps.readRunTitleParts(input.templateId)).agentName;
      }
      const written = await deps.write({
        runId: input.runId,
        orgId: input.orgId,
        createdBy: input.createdBy,
        outputId: ledgerOutputId,
        nodeId: null,
        path: "default_road",
        extension: target.extension,
        title: `${agentName ?? "Agent"} — ${name}`,
        mime: verdict.mime,
        content: content.text,
        ownership,
        resolvedTarget: {
          objectTypeId: target.objectTypeId,
          acceptedFileMimeTypes: target.acceptedFileMimeTypes,
        },
        mimeDescription: "the detected output form",
        detection: verdict,
      });
      if (!written.ok) {
        outcomes.push({
          ok: false,
          outputId: name,
          ledgerOutputId,
          rung: verdict.rung,
          mime: verdict.mime,
          extension: target.extension,
          error: written.error,
          bytes: content.bytes.byteLength,
        });
        continue;
      }
      outcomes.push({
        ok: true,
        outputId: name,
        ledgerOutputId,
        rung: verdict.rung,
        mime: verdict.mime,
        extension: target.extension,
        artifactId: written.artifactId,
        representationRevisionId: written.representationRevisionId,
        deduped: written.deduped,
        bytes: content.bytes.byteLength,
      });
    } catch (err) {
      outcomes.push({
        ok: false,
        outputId: name,
        ledgerOutputId,
        rung: verdict.rung,
        mime: verdict.mime,
        extension: null,
        error: err instanceof Error ? err.message : String(err),
        bytes: content.bytes.byteLength,
      });
    }
  }
  return outcomes;
}

export { DOCUMENT_FLOOR_BYTES };
