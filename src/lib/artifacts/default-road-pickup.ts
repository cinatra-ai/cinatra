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
import {
  fileMatchesBindingPattern,
  fileNameTitle,
  firstLineTitle,
} from "@cinatra-ai/agents/artifact-binding";
import { decodeUtf8Exact } from "./run-folder";
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
// FILES TAKE THE ROAD TOO (cinatra#3030, epic #3023 W6; item 0.22). A file the
// run left in its `outputs` folder is picked up beside the end-node outputs:
// under a binding that NAMES it (`fileFrom`, or one member of a `filePattern`
// fan-out — item 0.27), which is where it "lands under its declared extension",
// and on the default road otherwise, where the ladder types it exactly as it
// types an output's value. Bytes that are not UTF-8 text are a RECORDED refusal,
// never a lossy re-encode — this road carries text, and W8 is the slice that
// gives bytes a road of their own.
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

/** The reserved ledger id prefix for an EMITTED FILE (cinatra#3030, item 0.22).
 *  It carries a `:`, which an OAS node id and an EndNode output name cannot, so
 *  a file's default-road row can never collide with an `end_node_binding` /
 *  `materialize_tool` row of the same run, nor with an end-node output's own
 *  default-road row. */
export const RUN_FILE_LEDGER_OUTPUT_ID_PREFIX = "cinatra:run-file:";

/** The reserved ledger id for one emitted file. */
export function runFileLedgerOutputId(relPath: string): string {
  return `${RUN_FILE_LEDGER_OUTPUT_ID_PREFIX}${relPath}`;
}

/** The last rung of the target ladder: the form nothing else can home. */
export const BINARY_BASE_MIME = "application/octet-stream";

/** The reserved ledger id for one end-node output. */
export function defaultRoadLedgerOutputId(outputName: string): string {
  return `${DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX}${outputName}`;
}

/** Why an output or a file took no road. */
export type DefaultRoadSkip =
  | "below_floor"
  | "bound"
  | "empty"
  | "duplicate_bytes"
  /** cinatra#3030: the file's bytes are not UTF-8 text. A RECORDED refusal —
   *  `Buffer.toString("utf8")` substitutes U+FFFD for every byte it cannot
   *  decode and never fails, so writing it would store bytes the agent never
   *  wrote under an artifact nobody could tell from a good one. */
  | "not_utf8"
  /** cinatra#3030: the file was gone by the time the pickup read the folder. */
  | "file_missing"
  /** cinatra#3030: the run folder refused the read (a link, a cap, an escape). */
  | "file_refused";

/** One visible outcome per end-node output the pickup looked at. */
export type DefaultRoadPickupOutcome = {
  ok: boolean;
  /** Which half of the pickup produced this outcome (cinatra#3030). */
  source?: "end_node_output" | "file";
  /** The file's path relative to the run's outputs folder, on the file half. */
  relPath?: string;
  /** The end-node output name, or the emitted file's path. */
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
    /** `end_node_binding` is the path a file lands on when a binding NAMED it
     *  (cinatra#3030) — the same path a bound output takes. */
    path: "default_road" | "end_node_binding";
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
  /**
   * Read ONE emitted file's bytes out of the run's outputs folder
   * (cinatra#3030). Host-side, because only the process the folder lives with
   * can see it. Every refusal comes back as a value: a file that is gone by the
   * time the pickup reads is a recorded verdict, never a run failure.
   */
  readRunFile?: (input: {
    relPath: string;
  }) => Promise<
    { ok: true; bytes: Uint8Array } | { ok: false; reason: "file_missing" | "file_refused"; error: string }
  >;
  /** Record that the pickup has READ this run's folder — the receipt the
   *  retention tier's grace period runs from (item 0.21). */
  markPickedUp?: (input: { files: number }) => Promise<void>;
  /** The ladder's own seams (the model rung, its switch, its cache). */
  ladder?: LadderDeps;
};

/**
 * One emitted file, carried BY REFERENCE (cinatra#3030, item 0.22): the pickup
 * is handed a path and a size, never bytes, and reads the folder itself.
 */
export type RunFileRef = { relPath: string; byteLength: number };

/**
 * A binding whose content source is a FILE — structurally the file half of
 * `ArtifactOutputBinding`, restated here so this module keeps its own shape and
 * the agents package's grammar type never has to cross into it.
 */
export type RunFileBinding = {
  /** The annotated output's name — the ledger identity root. */
  outputId: string;
  /** The EndNode component the annotation lives on. */
  nodeId: string | null;
  /** The extension the file LANDS UNDER (acceptance item 2). */
  extension: string;
  /** The exact declared type the binding pinned (`@scope/pkg:local-id`), when it
   *  pinned one — honoured fail-closed rather than dropped. */
  objectTypeId?: string | null;
  /** The declared form, when the binding states one; null leaves it to the ladder. */
  declaredMime?: string | null;
  /** Title from the file's first line rather than its name (item 0.27). */
  titleFromFirstLine?: boolean;
  /** ONE named file. XOR `filePattern`. */
  fileFrom?: string;
  /** One artifact per matching file (item 0.27). XOR `fileFrom`. */
  filePattern?: string;
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
  /** The files the run left in its outputs folder, by reference (cinatra#3030).
   *  Absent or empty ⇒ the file half does not run and no receipt is written. */
  runFiles?: readonly RunFileRef[];
  /** The run package's FILE-sourced bindings (item 0.22). Resolved here, because
   *  only this process can see the run folder. */
  fileBindings?: readonly RunFileBinding[];
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
  const names =
    outputs !== null && typeof outputs === "object" ? Object.keys(outputs) : [];
  // cinatra#3030: a run that declared NO end-node output can still have emitted
  // files, so the road runs whenever either half has something to look at.
  const runFiles = input.runFiles ?? [];
  if (names.length === 0 && runFiles.length === 0) return [];

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
    const content = readOutputContent(
      (outputs as Record<string, unknown>)[name],
    );
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

  // =========================================================================
  // THE FILE HALF (cinatra#3030, epic #3023 W6; items 0.22 and 0.27).
  //
  //   0.22: "bound, when a binding names it as its content source [...] or on
  //   the default road otherwise"
  //   0.27: "one artifact per member or per matching file, identity by
  //   position, duplicates included, a title from [...] the first line of a
  //   text member or the file name"
  //
  // A file is read HERE, where the folder lives, and never travels as bytes:
  // the outbox and every caller carry a path and a size. Every refusal is a
  // recorded outcome — a file that is gone, a file the folder refuses, and a
  // file that is not UTF-8 text are all facts on the run's own record, never a
  // reason to fail an otherwise-successful run.
  // =========================================================================
  const fileBindings = input.fileBindings ?? [];
  let filesRead = 0;

  /** The binding that claims one file, and the ledger identity it lands under.
   *  A NAMED file wins over a pattern, and the pattern's member identity is the
   *  file's POSITION among the pattern's own matches — the `output[index]` shape
   *  the ledger already reserves for a fanned-out member. */
  const claimFor = (
    relPath: string,
  ): { binding: RunFileBinding; ledgerOutputId: string } | null => {
    for (const binding of fileBindings) {
      if (binding.fileFrom !== undefined && binding.fileFrom === relPath) {
        return { binding, ledgerOutputId: binding.outputId };
      }
    }
    for (const binding of fileBindings) {
      const pattern = binding.filePattern;
      if (pattern === undefined) continue;
      const matches = runFiles
        .map((f) => f.relPath)
        .filter((candidate) => fileMatchesBindingPattern(pattern, candidate));
      const index = matches.indexOf(relPath);
      if (index >= 0) {
        return { binding, ledgerOutputId: `${binding.outputId}[${index}]` };
      }
    }
    return null;
  };

  for (const file of runFiles) {
    const claim = claimFor(file.relPath);
    const ledgerOutputId = claim?.ledgerOutputId ?? runFileLedgerOutputId(file.relPath);
    const fileSkip = (
      reason: DefaultRoadSkip,
      bytes: number,
      error?: string,
    ): DefaultRoadPickupOutcome => ({
      ok: false,
      source: "file",
      relPath: file.relPath,
      outputId: file.relPath,
      ledgerOutputId,
      rung: null,
      mime: null,
      extension: null,
      skipped: reason,
      ...(error === undefined ? {} : { error }),
      bytes,
    });

    if (deps.readRunFile === undefined) {
      outcomes.push(
        fileSkip("file_refused", file.byteLength, "no run-folder reader is wired into the pickup"),
      );
      continue;
    }
    const read = await deps.readRunFile({ relPath: file.relPath });
    if (!read.ok) {
      outcomes.push(fileSkip(read.reason, file.byteLength, read.error));
      continue;
    }
    filesRead += 1;
    const bytes = read.bytes;
    if (bytes.byteLength === 0) {
      outcomes.push(fileSkip("empty", 0));
      continue;
    }
    // NOT UTF-8 IS A REFUSAL, NEVER A LOSSY WRITE. This road carries text; a
    // picture left in the outputs folder waits for the slice that brings
    // pictures rather than becoming an artifact holding bytes nobody wrote.
    const text = decodeUtf8Exact(Buffer.from(bytes));
    if (text === null) {
      outcomes.push(
        fileSkip(
          "not_utf8",
          bytes.byteLength,
          `run-folder file "${file.relPath}" is ${bytes.byteLength} bytes that are not UTF-8 text; ` +
            "this road carries text, and a non-text file is refused rather than transcoded",
        ),
      );
      continue;
    }
    // A BOUND file is never skipped for the document floor or for duplicate
    // bytes: the binding is an explicit promise, and two files an agent wrote
    // are two files. Only the DEFAULT road applies those two rungs.
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (claim === null) {
      if (!isAtOrAboveDocumentFloor(bytes)) {
        outcomes.push(fileSkip("below_floor", bytes.byteLength));
        continue;
      }
      if (seenHashes.has(hash)) {
        outcomes.push(fileSkip("duplicate_bytes", bytes.byteLength));
        continue;
      }
      seenHashes.set(hash, file.relPath);
    }

    let verdict: DetectionVerdict;
    try {
      verdict = await detectOutputForm(
        {
          orgId: input.orgId,
          bytes,
          declaredMime: claim?.binding.declaredMime ?? null,
          fileName: file.relPath,
        },
        ladderDeps,
      );
    } catch (err) {
      outcomes.push({
        ok: false,
        source: "file",
        relPath: file.relPath,
        outputId: file.relPath,
        ledgerOutputId,
        rung: null,
        mime: null,
        extension: null,
        error: `the detection ladder failed: ${err instanceof Error ? err.message : String(err)}`,
        bytes: bytes.byteLength,
      });
      continue;
    }

    try {
      // THE TARGET. A BOUND file lands under the BINDING'S OWN extension —
      // acceptance item 2, "a bound file lands under its declared extension" —
      // and its form is the binding's when it declared one, the ladder's
      // otherwise. An UNBOUND file walks the same target ladder an end-node
      // output walks.
      const mime = claim?.binding.declaredMime ?? verdict.mime;
      let target: DefaultRoadTarget | null = null;
      if (claim !== null) {
        target = await deps.resolveTarget({
          orgId: input.orgId,
          mime,
          declaredKindExtension: claim.binding.extension,
        });
        if (target === null) {
          outcomes.push({
            ok: false,
            source: "file",
            relPath: file.relPath,
            outputId: file.relPath,
            ledgerOutputId,
            rung: verdict.rung,
            mime,
            extension: claim.binding.extension,
            error:
              `the binding's extension "${claim.binding.extension}" does not accept "${mime}" ` +
              `for file "${file.relPath}"`,
            bytes: bytes.byteLength,
          });
          continue;
        }
        // A DECLARED TYPE IS HONOURED OR THE FILE IS REFUSED (cinatra#1454's
        // discriminator, convergence round). Landing the file under a type the
        // binding did not name would file an agent's promise as something else.
        if (
          typeof claim.binding.objectTypeId === "string" &&
          claim.binding.objectTypeId.length > 0 &&
          claim.binding.objectTypeId !== target.objectTypeId
        ) {
          outcomes.push({
            ok: false,
            source: "file",
            relPath: file.relPath,
            outputId: file.relPath,
            ledgerOutputId,
            rung: verdict.rung,
            mime,
            extension: claim.binding.extension,
            error:
              `the binding declares object type "${claim.binding.objectTypeId}", but extension ` +
              `"${claim.binding.extension}" resolved "${target.objectTypeId}" for file ` +
              `"${file.relPath}"`,
            bytes: bytes.byteLength,
          });
          continue;
        }
      } else {
        if (input.declaredKindExtension !== null) {
          target = await deps.resolveTarget({
            orgId: input.orgId,
            mime,
            declaredKindExtension: input.declaredKindExtension,
          });
        }
        if (target === null) {
          target = await deps.resolveTarget({
            orgId: input.orgId,
            mime,
            declaredKindExtension: null,
          });
        }
        if (target === null && mime !== BINARY_BASE_MIME) {
          target = await deps.resolveTarget({
            orgId: input.orgId,
            mime: BINARY_BASE_MIME,
            declaredKindExtension: null,
          });
        }
        if (target === null) {
          outcomes.push({
            ok: false,
            source: "file",
            relPath: file.relPath,
            outputId: file.relPath,
            ledgerOutputId,
            rung: verdict.rung,
            mime,
            extension: null,
            error: `no installed base accepts "${mime}"`,
            bytes: bytes.byteLength,
          });
          continue;
        }
      }
      if (ownership === null) {
        ownership = await deps.resolveOwnership({
          templateId: input.templateId,
          runId: input.runId,
          orgId: input.orgId,
        });
        agentName = (await deps.readRunTitleParts(input.templateId)).agentName;
      }
      // A FILE IS NAMED BY ITSELF (item 0.27). Its first line when the binding
      // asked for one and there is one, its own name otherwise — a name the
      // agent chose, never one this road invented.
      const title =
        claim?.binding.titleFromFirstLine === true
          ? firstLineTitle(text) || fileNameTitle(file.relPath)
          : fileNameTitle(file.relPath);
      const written = await deps.write({
        runId: input.runId,
        orgId: input.orgId,
        createdBy: input.createdBy,
        outputId: ledgerOutputId,
        nodeId: claim?.binding.nodeId ?? null,
        path: claim === null ? "default_road" : "end_node_binding",
        extension: target.extension,
        title,
        mime,
        content: text,
        ownership,
        resolvedTarget: {
          objectTypeId: target.objectTypeId,
          acceptedFileMimeTypes: target.acceptedFileMimeTypes,
        },
        mimeDescription: claim === null ? "the detected file form" : "the bound file's form",
        detection: verdict,
      });
      if (!written.ok) {
        outcomes.push({
          ok: false,
          source: "file",
          relPath: file.relPath,
          outputId: file.relPath,
          ledgerOutputId,
          rung: verdict.rung,
          mime,
          extension: target.extension,
          error: written.error,
          bytes: bytes.byteLength,
        });
        continue;
      }
      outcomes.push({
        ok: true,
        source: "file",
        relPath: file.relPath,
        outputId: file.relPath,
        ledgerOutputId,
        rung: verdict.rung,
        mime,
        extension: target.extension,
        artifactId: written.artifactId,
        representationRevisionId: written.representationRevisionId,
        deduped: written.deduped,
        bytes: bytes.byteLength,
      });
    } catch (err) {
      outcomes.push({
        ok: false,
        source: "file",
        relPath: file.relPath,
        outputId: file.relPath,
        ledgerOutputId,
        rung: verdict.rung,
        mime: verdict.mime,
        extension: null,
        error: err instanceof Error ? err.message : String(err),
        bytes: bytes.byteLength,
      });
    }
  }

  // THE PICKUP RECEIPT (item 0.21: "deleted after pickup plus a grace period").
  // Written once the pickup has READ the folder, whatever each file's verdict
  // was: the grace period runs from the reading, not from the writing, so a file
  // nothing could type is still collected on time. The folder itself is left
  // alone — the retention tier deletes it, never the pickup.
  if (filesRead > 0 && deps.markPickedUp !== undefined) {
    await deps.markPickedUp({ files: filesRead }).catch(() => undefined);
  }

  return outcomes;
}

export { DOCUMENT_FLOOR_BYTES };
