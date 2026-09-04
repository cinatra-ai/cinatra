// THE ARTIFACT EDIT CHANNEL — the author-facing WRITE contract for a display
// that edits its artifact in place (enabler 0.20 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3026 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "the code view is editable in place, and
// changes are saved immediately … The save unit is a change set, sent after a
// short idle pause or on leaving the view, one revision per saved change set.
// The save road is new — the store allocates the next revision today without an
// expected base — and takes the revision the editor opened as its base, so a
// save over a newer revision is refused and the editor reloads rather than
// overwriting; an unchanged save writes nothing; a failed save keeps the spinner
// and says why; saves in flight are serialised per editor. Editing needs write
// rights on the artifact and is recorded as an edit operation with the base and
// the new revision; the review card shows the same display read-only, and a
// review's pinned revision never moves under an edit."
//
// WHY IT IS A LEAF, AND WHY THE DISPLAY NEVER REACHES A HOST INTERNAL. A display
// lives in its own repository and may depend on this SDK and nothing else. It is
// handed an EDIT CAPABILITY on its props — a host-minted, serializable handle
// that either grants the edit and says where to send a change set, or refuses it
// with a named reason — and it sends the change set through `saveArtifactEdit`
// below. There is no other road: the display never learns a host route shape,
// never composes a URL of its own, and cannot edit an artifact the host did not
// hand it a capability for.
//
// SCHEMA-ONLY PLUS ONE CALL. Everything here is a type, an integer, a frozen
// sentence table or a pure function, except `saveArtifactEdit`, which posts the
// change set with the global `fetch`. It imports nothing, so it costs a display
// bundle nothing.
//
// THE HOST OWNS THE SAVE. `src/lib/artifacts/artifact-edit-save.ts` holds the
// compare-and-set append, the write-rights check and the audit row; this module
// only says what crosses between them. Nothing here reads or writes anything.

/**
 * The edit-channel ABI version. SEPARATE from the props-contract version and
 * from the content channel's: a display that understands props v1 and content
 * channel v1 may still be handed an edit channel of another version, and this
 * integer is what a future change to the save contract ratchets.
 */
export const ARTIFACT_EDIT_CHANNEL_VERSION = 1;

/**
 * THE IDLE PAUSE that bounds a change set, in milliseconds.
 *
 * The plan asks for "a short idle pause"; the number lives HERE, on the
 * contract, rather than inside one display, because the host stamps it onto
 * every capability it mints — so the pause is a property of the product's save
 * road and not of whichever display happens to draw the artifact. 900 ms is
 * long enough that ordinary typing (a keystroke every 100–250 ms) coalesces into
 * one revision per thought rather than one per word, and short enough that a
 * person who stops typing and looks at the indicator sees it settle rather than
 * wondering whether it will.
 */
export const ARTIFACT_EDIT_IDLE_PAUSE_MS = 900;

/**
 * The largest change set the channel carries, in UTF-8 bytes. Deliberately the
 * SAME number as the content channel's text cap: a display is handed at most
 * that many bytes to draw, so it can never legitimately send back more, and a
 * document the channel had to truncate must never be saved over its own full
 * text (the host refuses such a save by its own arithmetic; this is the
 * display's cheap first answer).
 */
export const ARTIFACT_EDIT_TEXT_CAP_BYTES = 256 * 1024;

/**
 * THE LEAVING BUDGET, in UTF-8 bytes of the request body.
 *
 * Leaving the view is one of the two things that bounds a change set, and the
 * document is often gone the instant after — an ordinary request dies with the
 * document that started it, so the LAST change set of a session is exactly the
 * one most likely to be lost. A request marked to outlive its document survives
 * that, but every browser bounds how much it will carry that way, and the
 * bound is shared across every such request the page has in flight; over it the
 * browser refuses the request outright. 64 KiB is the figure the platform names,
 * so a leaving change set larger than this is sent as an ORDINARY request
 * instead: a save that might complete beats one that cannot start.
 */
export const ARTIFACT_EDIT_KEEPALIVE_CAP_BYTES = 64 * 1024;

/** Why the host did not grant the edit. Named, never blank. */
export type ArtifactEditRefusal =
  /** The reader may see this artifact but may not write it. */
  | "no-write-rights"
  /** The surface is not the artifact's own page — a review target, a card, a
   *  list row. The plan's "the review card shows the same display read-only". */
  | "read-only-surface"
  /** The artifact's form is not one this channel can edit as text. */
  | "unsupported-form"
  /** There is no pinned revision to take as a base. */
  | "no-representation"
  /** The text was not carried in full (the content channel truncated it), so a
   *  save would write the prefix over the whole document. */
  | "content-truncated";

/**
 * THE EDIT CAPABILITY, as it arrives on a display's props.
 *
 * DISCRIMINATED, and REFUSAL IS FIRST-CLASS. A display switches on `kind`: it
 * never infers "may edit" from anything else on the snapshot, and it never
 * treats a missing field as permission. Every surface that mounts a display says
 * which of the two this is — the artifact page mints `editable` for a writer,
 * and every other surface mints `read-only` with the reason — so a display drawn
 * on a review card is read-only BY CONSTRUCTION rather than by remembering to be.
 */
export type ArtifactEditCapability =
  | {
      kind: "editable";
      /** The channel ABI version this capability was minted at. */
      channelVersion: number;
      /** The artifact this capability is sealed to. */
      artifactId: string;
      /** THE BASE — the revision the editor opened, and the revision every save
       *  under this capability names. The host refuses a save whose base is no
       *  longer the artifact's latest. */
      baseRevisionId: string;
      /** Where the change set goes. Host-authorized and host-composed; the
       *  display posts here and composes no address of its own. */
      saveUrl: string;
      /** The idle pause that bounds a change set, stamped by the host. */
      idlePauseMs: number;
      /** The largest change set this capability admits, in UTF-8 bytes. */
      capBytes: number;
    }
  | {
      kind: "read-only";
      channelVersion: number;
      reason: ArtifactEditRefusal;
    };

/** The change set, exactly as it crosses to the host. */
export interface ArtifactEditRequest {
  channelVersion: number;
  /** The revision the editor opened — the expected base of the append. */
  baseRevisionId: string;
  /** The whole document as the editor now holds it. A change set is the
   *  document's new text, not a patch: the store keeps whole revisions, so a
   *  patch would only move the merge into the display. */
  text: string;
}

/** Why a save the host understood was refused. */
export type ArtifactEditRefusedReason =
  | "no-write-rights"
  | "over-cap"
  | "unsupported-form"
  | "no-representation"
  | "unknown-base"
  | "malformed";

/** Why a save never reached an answer. */
export type ArtifactEditFailureReason = "transport" | "malformed-answer" | "server";

/**
 * WHAT ONE SAVE ANSWERED. Total: every save ends on exactly one of these, and a
 * display draws its indicator from the outcome alone.
 *
 *   `saved`     — one new revision holds the change set. The check.
 *   `unchanged` — the text equals the base's, so NOTHING was written. Also the
 *                 check: the document on screen is the document that is stored.
 *   `stale`     — the artifact moved on under the editor. The save was REFUSED,
 *                 never written over, and the newer revision comes back with the
 *                 answer so the editor can reload rather than overwrite.
 *   `refused`   — the host understood the save and would not perform it.
 *   `failed`    — no answer at all, or one that could not be read.
 */
export type ArtifactEditOutcome =
  | { outcome: "saved"; revisionId: string; revision: number }
  | { outcome: "unchanged"; revisionId: string }
  | {
      outcome: "stale";
      /** The revision the artifact actually holds now — the editor's new base. */
      latestRevisionId: string;
      latestRevision: number;
      /** That revision's text, so the editor reloads in place. */
      text: string;
      /** True when the host had to cut that text to the cap. */
      truncated: boolean;
    }
  | { outcome: "refused"; reason: ArtifactEditRefusedReason }
  | { outcome: "failed"; reason: ArtifactEditFailureReason };

/**
 * THE SENTENCE A READER IS TOLD, one per outcome that is not a success.
 *
 * They live on the CONTRACT, not inside a display, for the same reason the idle
 * pause does: what the product says when a save does not go through is the
 * product's answer, and two displays must never explain the same refusal in two
 * different ways. The drawing reports them through the application's toast
 * surface — the display carries its indicator and nothing else.
 */
const REFUSAL_SENTENCES: Record<ArtifactEditRefusedReason, string> = {
  "no-write-rights":
    "This change has not been saved — you do not have rights to edit this artifact.",
  "over-cap":
    "This change has not been saved — the document is larger than the editor can store.",
  "unsupported-form":
    "This change has not been saved — this artifact is not a text document the editor can store.",
  "no-representation":
    "This change has not been saved — this artifact has no stored revision to save over.",
  "unknown-base":
    "This change has not been saved — the revision it was made against is no longer stored.",
  malformed: "This change has not been saved — the change set could not be read.",
};

const FAILURE_SENTENCES: Record<ArtifactEditFailureReason, string> = {
  transport: "This change has not been saved — the store could not be reached.",
  "malformed-answer": "This change has not been saved — the store's answer could not be read.",
  server: "This change has not been saved — the store could not store it.",
};

const STALE_SENTENCE =
  "This artifact moved to a newer revision while you were editing, so the save was refused rather than written over it. The newer revision is loaded here.";

/**
 * The sentence for an outcome, or null when there is nothing to say — a save
 * that went through, and a save that wrote nothing because nothing changed, are
 * both silent: the indicator already says it.
 */
/** Is `name` one of THIS table's own keys? `in` walks the prototype chain, so it
 *  answers yes to "toString" and "constructor" — names every object inherits and
 *  none of which is a reason this channel has a sentence for. A membership test
 *  that admits them would hand back a union member that is not in the union. */
function isOwnKey(table: Record<string, string>, name: unknown): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(table, name);
}

export function artifactEditMessage(outcome: ArtifactEditOutcome): string | null {
  switch (outcome.outcome) {
    case "saved":
    case "unchanged":
      return null;
    case "stale":
      return STALE_SENTENCE;
    case "refused":
      return REFUSAL_SENTENCES[outcome.reason] ?? REFUSAL_SENTENCES.malformed;
    case "failed":
      return FAILURE_SENTENCES[outcome.reason] ?? FAILURE_SENTENCES.server;
  }
}

/** Is this capability one that admits an edit? The ONE test a display makes. */
export function isArtifactEditGranted(
  capability: ArtifactEditCapability | null | undefined,
): capability is Extract<ArtifactEditCapability, { kind: "editable" }> {
  return (
    !!capability &&
    capability.kind === "editable" &&
    capability.channelVersion === ARTIFACT_EDIT_CHANNEL_VERSION &&
    typeof capability.saveUrl === "string" &&
    capability.saveUrl.length > 0 &&
    typeof capability.baseRevisionId === "string" &&
    capability.baseRevisionId.length > 0
  );
}

/** UTF-8 byte length, without reaching for Buffer (a display runs in a browser). */
export function artifactEditByteLength(text: string): number {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
  // A runtime with no TextEncoder is not one this channel expects; count the
  // worst case rather than under-reporting a payload the cap exists to bound.
  return text.length * 4;
}

/** The change set a capability and a text make. Pure. */
export function buildArtifactEditRequest(
  capability: Extract<ArtifactEditCapability, { kind: "editable" }>,
  text: string,
): ArtifactEditRequest {
  return {
    channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
    baseRevisionId: capability.baseRevisionId,
    text,
  };
}

/**
 * READ an outcome out of whatever the host answered. TOTAL and DEFENSIVE: a
 * shape this channel does not recognise becomes `failed / malformed-answer`,
 * never an invented success — an editor that drew a check on an answer it could
 * not read would tell a person their work is stored when nothing says so.
 */
export function readArtifactEditOutcome(value: unknown): ArtifactEditOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { outcome: "failed", reason: "malformed-answer" };
  }
  const body = value as Record<string, unknown>;
  switch (body.outcome) {
    case "saved":
      return typeof body.revisionId === "string" && typeof body.revision === "number"
        ? { outcome: "saved", revisionId: body.revisionId, revision: body.revision }
        : { outcome: "failed", reason: "malformed-answer" };
    case "unchanged":
      return typeof body.revisionId === "string"
        ? { outcome: "unchanged", revisionId: body.revisionId }
        : { outcome: "failed", reason: "malformed-answer" };
    case "stale":
      return typeof body.latestRevisionId === "string" &&
        typeof body.latestRevision === "number" &&
        typeof body.text === "string"
        ? {
            outcome: "stale",
            latestRevisionId: body.latestRevisionId,
            latestRevision: body.latestRevision,
            text: body.text,
            truncated: body.truncated === true,
          }
        : { outcome: "failed", reason: "malformed-answer" };
    case "refused":
      return isOwnKey(REFUSAL_SENTENCES, body.reason)
        ? { outcome: "refused", reason: body.reason as ArtifactEditRefusedReason }
        : { outcome: "failed", reason: "malformed-answer" };
    // THE CHANNEL PARSES EVERY OUTCOME IT DECLARES. A host that says a save
    // failed and why is telling the reader something this channel has a
    // sentence for; reading it as an answer that could not be parsed would
    // replace that sentence with the wrong one. A reason outside the closed set
    // is still unreadable — an unknown reason has no sentence to say.
    case "failed":
      return isOwnKey(FAILURE_SENTENCES, body.reason)
        ? { outcome: "failed", reason: body.reason as ArtifactEditFailureReason }
        : { outcome: "failed", reason: "malformed-answer" };
    default:
      return { outcome: "failed", reason: "malformed-answer" };
  }
}

/**
 * SEND one change set, and answer with exactly one outcome.
 *
 * THE DISPLAY'S ONLY ROAD TO THE HOST. It posts to the address the capability
 * carries — never one it composed — and it never throws: a network that is not
 * there, a host that answered with a status this channel does not expect and an
 * answer that cannot be parsed are all OUTCOMES, because a throw inside a
 * display's save loop would leave the indicator lying about where the work is.
 *
 * SERIALISATION IS THE CALLER'S. One call is one change set; the editor holds
 * the queue that keeps two of them from being in flight at once (and the host
 * holds a lock of its own, so two editors cannot interleave either).
 */
export async function saveArtifactEdit(
  capability: ArtifactEditCapability,
  text: string,
  deps?: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    /** This change set is the one the reader is LEAVING on — the pause never
     *  elapsed, the view is going away, and the request must outlive the
     *  document that started it if the browser will carry it that way. */
    leaving?: boolean;
  },
): Promise<ArtifactEditOutcome> {
  if (!isArtifactEditGranted(capability)) {
    return { outcome: "refused", reason: "no-write-rights" };
  }
  if (artifactEditByteLength(text) > capability.capBytes) {
    return { outcome: "refused", reason: "over-cap" };
  }
  const send = deps?.fetch ?? (typeof fetch === "function" ? fetch : null);
  if (!send) return { outcome: "failed", reason: "transport" };

  const payload = JSON.stringify(buildArtifactEditRequest(capability, text));
  // A LEAVING SAVE OUTLIVES ITS DOCUMENT, within the budget the platform gives
  // such requests. Over that budget the browser refuses the request outright,
  // so an over-budget change set goes as an ordinary one and takes its chances
  // with the navigation rather than being certain to fail.
  const keepalive =
    deps?.leaving === true && artifactEditByteLength(payload) <= ARTIFACT_EDIT_KEEPALIVE_CAP_BYTES;

  let response: Response;
  try {
    response = await send(capability.saveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      credentials: "same-origin",
      ...(keepalive ? { keepalive: true } : {}),
      ...(deps?.signal ? { signal: deps.signal } : {}),
    });
  } catch {
    return { outcome: "failed", reason: "transport" };
  }

  // WHAT THE STATUS DECIDES, BEFORE THE BODY IS BELIEVED. A status this channel
  // did not ask for can never read as a success: an edge that answers 500, a
  // session that lapsed and answers 401, a proxy that answers 502 from a cache
  // can each carry a readable body, and one of them carrying the word "saved"
  // would draw the check over work nothing stored. The drawing: the indicator
  // "never reads as stored before it is".
  //
  // A DECISION THE HOST SPELLED OUT IS STILL HONOURED. A refusal and a stale
  // reload are answers, not faults, and a host is free to carry either under a
  // status that says so — so those two are read from the body whatever the
  // status is, and everything else under a failing status becomes the failure
  // the status names.
  // THE STATUS DECIDES FIRST, AND THE BODY ONLY THEN. The save road answers
  // EVERY outcome it has — saved, unchanged, stale, refused — on a success
  // status, and keeps its failing statuses for the cases that carry no outcome
  // at all. So a body under a failing status was not written by that road, and
  // reading one would be worse than ignoring it in both directions: a "saved"
  // from an edge or a cache draws the check over work nothing stored, and a
  // "stale" from a proxy makes the display DROP the change set waiting behind
  // it and replace the words on screen — destroying the reader's work on a
  // server fault. The drawing: the indicator "never reads as stored before it
  // is", and a refusal is the one thing that may move what is on screen.
  const fallback = (): ArtifactEditOutcome =>
    response.status === 401 || response.status === 403
      ? { outcome: "refused", reason: "no-write-rights" }
      : { outcome: "failed", reason: "server" };

  if (!response.ok) return fallback();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A success status with no readable body is an answer this channel cannot
    // read — never a success. The indicator keeps the spinner.
    return { outcome: "failed", reason: "malformed-answer" };
  }
  return readArtifactEditOutcome(body);
}
