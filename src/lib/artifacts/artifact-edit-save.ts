// ---------------------------------------------------------------------------
// THE EDITOR'S SAVE ROAD (enabler 0.20 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3026). §8.1 places it here: "a NEW SAVE ROAD in the host beside
// `representation-store.ts`, which allocates revisions without an expected base
// today … the save road takes the base revision and refuses a stale save".
//
// THE ENABLER'S SENTENCES THIS MODULE OWNS, one arm each:
//
//   "takes the revision the editor opened as its base, so a save over a newer
//    revision is REFUSED and the editor RELOADS rather than overwriting"
//        → the base is compared before anything is written, and a refusal
//          answers with the newer revision's own text so the editor can reload.
//   "an unchanged save WRITES NOTHING"
//        → the change set is compared with the base's text first; equal text
//          returns `unchanged` without touching the blob store or the table.
//   "a failed save KEEPS THE SPINNER AND SAYS WHY"
//        → every refusal is a NAMED outcome carrying its own sentence; nothing
//          here throws at a display.
//   "Editing needs WRITE RIGHTS on the artifact"
//        → the first question asked, before a byte is read.
//   "recorded as an edit operation with the base and the new revision"
//        → the ledger rows ride the append's own transaction.
//
// PORTS, NOT IMPORTS. Every effect this road has — the rights check, the two
// reads, the byte write, the append — arrives as a port, so the decisions above
// are provable without a database and the real wiring is one small module
// (`artifact-edit-save-ports.ts`) that this one never reaches for. Nothing here
// is server-only; the port module is.
// ---------------------------------------------------------------------------

import {
  ARTIFACT_EDIT_TEXT_CAP_BYTES,
  type ArtifactEditOutcome,
} from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

/** The forms the substrate admits, mirrored so this module imports no store. */
export type ArtifactEditForm = "file" | "connectorRef" | "dashboard";

/** The only forms an artifact this editor may write can be stored in. */
const EDITABLE_MIMES = new Set(["text/markdown", "text/x-markdown"]);

/** What the artifact holds right now. */
export interface ArtifactEditLatest {
  revisionId: string;
  revision: number;
  resourceId: string;
  mime: string;
  form: ArtifactEditForm;
}

export interface ArtifactEditSavePorts {
  /** Write rights on THIS artifact for THIS actor. Asked first, always. */
  mayWrite(): Promise<boolean>;
  /** The artifact's latest revision, or null when it holds nothing. */
  readLatest(input: { orgId: string; artifactId: string }): Promise<ArtifactEditLatest | null>;
  /** One revision's text, and whether the read had to cut it to the cap. */
  readText(input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
  }): Promise<{ text: string; truncated: boolean } | null>;
  /** Stream the change set into the store and return the resource that holds it. */
  writeBytes(input: {
    orgId: string;
    artifactId: string;
    text: string;
    mime: string;
    actor: string | null;
  }): Promise<{ resourceId: string }>;
  /** The compare-and-set append, with the edit's ledger rows in its transaction. */
  appendWithBase(input: {
    orgId: string;
    artifactId: string;
    baseRevisionId: string;
    baseRevision: number;
    resourceId: string;
    actor: string | null;
  }): Promise<
    { kind: "appended"; revisionId: string; revision: number } | { kind: "stale" } | { kind: "unknown-base" }
  >;
}

export interface ArtifactEditSaveInput {
  orgId: string;
  artifactId: string;
  /** The revision the editor opened. */
  baseRevisionId: string;
  /** The change set: the whole document as the editor now holds it. */
  text: string;
  actor: string | null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The refusal that answers with the newer revision, so the editor reloads. */
async function staleWithLatest(
  input: ArtifactEditSaveInput,
  latest: ArtifactEditLatest,
  ports: ArtifactEditSavePorts,
): Promise<ArtifactEditOutcome> {
  const newer = await ports.readText({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: latest.revisionId,
  });
  if (!newer) {
    // The refusal is right and the reload is impossible: say the save did not
    // go through rather than hand the editor an empty document to save back.
    return { outcome: "failed", reason: "server" };
  }
  return {
    outcome: "stale",
    latestRevisionId: latest.revisionId,
    latestRevision: latest.revision,
    text: newer.text,
    truncated: newer.truncated,
  };
}

/**
 * SAVE ONE CHANGE SET. Total: every path ends on exactly one outcome, and none
 * of them throws.
 */
export async function saveArtifactMarkdownEdit(
  input: ArtifactEditSaveInput,
  ports: ArtifactEditSavePorts,
): Promise<ArtifactEditOutcome> {
  // 1. WRITE RIGHTS, before a byte is read. A reader who may see the artifact
  //    but not write it must not be able to learn, from timing or from a named
  //    refusal, anything about the artifact's state.
  if (!(await ports.mayWrite())) {
    return { outcome: "refused", reason: "no-write-rights" };
  }

  // 2. The cap the channel carries. Refused here as well as in the display,
  //    because a display is not a boundary.
  if (byteLength(input.text) > ARTIFACT_EDIT_TEXT_CAP_BYTES) {
    return { outcome: "refused", reason: "over-cap" };
  }

  const latest = await ports.readLatest({ orgId: input.orgId, artifactId: input.artifactId });
  if (!latest) return { outcome: "refused", reason: "no-representation" };

  // 3. The editor writes text into a text document, and nothing else. A
  //    dashboard or a connector reference is a revision of something this road
  //    cannot author.
  if (latest.form !== "file" || !EDITABLE_MIMES.has(latest.mime.toLowerCase().split(";")[0].trim())) {
    return { outcome: "refused", reason: "unsupported-form" };
  }

  // 4. THE BASE. Asked before anything is written, so the ordinary stale case
  //    costs no bytes. The append's own compare-and-set is what makes the
  //    refusal TRUE under concurrency — this is the cheap, early half.
  if (latest.revisionId !== input.baseRevisionId) {
    return staleWithLatest(input, latest, ports);
  }

  const base = await ports.readText({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.baseRevisionId,
  });
  if (!base) return { outcome: "refused", reason: "unknown-base" };

  // 5. A DOCUMENT THE EDITOR ONLY EVER SAW A PREFIX OF IS NEVER SAVED BACK.
  //    The content channel truncates at its cap; saving what the editor holds
  //    would silently delete everything past the cut.
  if (base.truncated) return { outcome: "refused", reason: "over-cap" };

  // 6. AN UNCHANGED SAVE WRITES NOTHING — not a blob, not a resource row, not a
  //    revision, not a ledger row. The document on screen is the document that
  //    is stored, and the indicator says so with the same check a save does.
  if (base.text === input.text) {
    return { outcome: "unchanged", revisionId: input.baseRevisionId };
  }

  const { resourceId } = await ports.writeBytes({
    orgId: input.orgId,
    artifactId: input.artifactId,
    text: input.text,
    mime: latest.mime,
    actor: input.actor,
  });

  const appended = await ports.appendWithBase({
    orgId: input.orgId,
    artifactId: input.artifactId,
    baseRevisionId: input.baseRevisionId,
    baseRevision: latest.revision,
    resourceId,
    actor: input.actor,
  });

  if (appended.kind === "appended") {
    return { outcome: "saved", revisionId: appended.revisionId, revision: appended.revision };
  }
  if (appended.kind === "unknown-base") {
    return { outcome: "refused", reason: "unknown-base" };
  }

  // The index refused it: another save landed between the read above and this
  // insert. Re-read what the artifact holds NOW and answer with that, so the
  // editor reloads the revision it actually has to build on.
  const now = await ports.readLatest({ orgId: input.orgId, artifactId: input.artifactId });
  if (!now) return { outcome: "failed", reason: "server" };
  return staleWithLatest(input, now, ports);
}
