/**
 * The drawn floor for a run whose declared artifact output did not materialize.
 *
 * The ratified run-surface drawing fixes exactly one reading for a target that
 * did not resolve, and it is a sanitized one:
 *
 *   "Whenever a target does not resolve to a type renderer, it renders the
 *    floor - a sanitized, telemetry-safe one-line diagnostic (package - slot -
 *    reason, never a raw error or manifest value) - so the surface never shows
 *    an empty panel where a target should be."
 *
 * and it draws that line character for character as
 *
 *   review target unavailable - package "@acme/support", slot "detail",
 *   reason "requires-rebuild"
 *
 * (an em dash and typographic quotes on the surface; ASCII in this comment so
 * the file reads the same in every terminal). The reason is a STABLE TOKEN, not
 * the producer's sentence: `requires-rebuild` names a class, it does not quote
 * a stack.
 *
 * Before this module, a run that failed at materialization persisted the
 * materializer's own sentence into `agent_runs.error` and the run-progress card
 * drew it verbatim - package internals, binding names and provider text on a
 * conversation surface, which is a reading no section of the drawing gives.
 * The composer here replaces it: the run row carries the floor,
 * the raw detail keeps going to the server log (execution.ts already writes one
 * `[artifact-materializer]` warn line per failed output, which is where an
 * operator reads the cause), and the card draws the floor and nothing else.
 *
 * Both directions live here because both surfaces need them: the server
 * composes the message, and the client must also reduce a row written BEFORE
 * this change - a raw sentence in an old row must not draw raw either.
 */

/** The closed set of reasons this floor can name. Never free text. */
export type RunFailureFloorReason =
  | "output-not-produced"
  | "binding-resolution-failed"
  | "binding-invalid"
  | "materializer-failed";

/** One failed declared output, reduced to the drawing's triple. */
export type RunFailureFloorEntry = {
  readonly package: string;
  readonly slot: string;
  readonly reason: RunFailureFloorReason;
};

/** The shape `run-artifact-materializer` reports a failed outcome in. */
export type MaterializationFailureOutcome = {
  readonly ok?: unknown;
  readonly outputId?: unknown;
  readonly nodeId?: unknown;
  readonly extension?: unknown;
  readonly bindingResolution?: unknown;
  readonly error?: unknown;
};

/** Named where a token is genuinely not known - never a blank in the line. */
const UNKNOWN_TOKEN = "unknown";

/**
 * Per-token ceiling. A package name and a binding id are short by construction;
 * this is the guard against a manifest value that is not, so one pathological
 * string can never turn the floor into a wall of text.
 */
const FLOOR_TOKEN_MAX_CHARS = 64;

/**
 * Upper bound on the composed `agent_runs.error`. Inherited from the sentence
 * this replaces (cinatra#2486): enough for every failing output's floor line on
 * a realistic binding set, short enough that a pathological binding set can
 * never bloat the row.
 */
export const RUN_FAILURE_FLOOR_MAX_CHARS = 2_000;

/**
 * The headline the pre-floor sentence opened with. Kept ONLY so a row written
 * before this change can still be recognized and reduced on read.
 */
const LEGACY_MATERIALIZATION_HEADLINE = "artifact materialization failed";

const EM_DASH = "—";
const LEFT_QUOTE = "“";
const RIGHT_QUOTE = "”";

const FLOOR_LINE_PATTERN = new RegExp(
  `^review target unavailable ${EM_DASH} package ${LEFT_QUOTE}(.*?)${RIGHT_QUOTE}, ` +
    `slot ${LEFT_QUOTE}(.*?)${RIGHT_QUOTE}, reason ${LEFT_QUOTE}(.*?)${RIGHT_QUOTE}$`,
);

const FLOOR_REASONS: ReadonlySet<string> = new Set<RunFailureFloorReason>([
  "output-not-produced",
  "binding-resolution-failed",
  "binding-invalid",
  "materializer-failed",
]);

/**
 * The closed lexical shape a floor token may have. A package name, a declared
 * output id and a reason token are all IDENTIFIERS by construction - scoped
 * package names, binding ids, the materializer's three synthetic ids
 * ("(binding-resolution)" and friends) and the drawn reason tokens all fit this
 * charset, and none of them contains whitespace.
 *
 * This is the guard that makes the module's promise true for EVERY input rather
 * than only for well-formed ones: prose cannot satisfy it, so a value that is
 * really a producer sentence (an unparsed legacy fragment, a mis-set outcome
 * field, a value read back off a row) can never be drawn as a token.
 * Anything that does not fit is reduced to `unknown` - a floor that names less
 * is still a floor; a floor that quotes a stack is not one.
 */
const FLOOR_TOKEN_CHARSET = /^[A-Za-z0-9@._:/()+~-]+$/;

/**
 * Reduce any value to a token that is safe to draw and safe to ship in
 * telemetry: no control characters, no whitespace, no quote marks that could
 * break the line's own grammar, nothing but the identifier charset above, no
 * unbounded length, and never an empty string.
 */
function sanitizeFloorToken(value: unknown, fallback: string = UNKNOWN_TOKEN): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, "").trim();
  if (cleaned.length === 0) return fallback;
  if (!FLOOR_TOKEN_CHARSET.test(cleaned)) return fallback;
  return cleaned.length > FLOOR_TOKEN_MAX_CHARS
    ? `${cleaned.slice(0, FLOOR_TOKEN_MAX_CHARS - 1)}…`
    : cleaned;
}

/**
 * The reason token for one failed outcome, decided by POSITIVE markers the
 * materializer already sets - never by matching on the error text, which is the
 * value this whole module exists to keep off the surface.
 */
function floorReasonForOutcome(outcome: MaterializationFailureOutcome): RunFailureFloorReason {
  const outputId = typeof outcome.outputId === "string" ? outcome.outputId : "";
  if (typeof outcome.bindingResolution === "string" || outputId === "(binding-resolution)") {
    return "binding-resolution-failed";
  }
  if (outputId === "(binding-validation)") return "binding-invalid";
  if (outputId === "(materializer)") return "materializer-failed";
  return "output-not-produced";
}

/**
 * The drawing's sentence, character for character.
 *
 * The `reason` is deliberately typed WIDER than this module's own closed set:
 * the drawn floor is shared with the artifact-review target floor, whose reason
 * token (`requires-rebuild`, drawn in the spec's own example) is minted by the
 * renderer-resolution producer rather than by the materializer. One formatter,
 * so the two producers can never drift into two different sentences.
 */
export function formatRunFailureFloorLine(entry: {
  readonly package: string;
  readonly slot: string;
  readonly reason: string;
}): string {
  return (
    `review target unavailable ${EM_DASH} ` +
    `package ${LEFT_QUOTE}${entry.package}${RIGHT_QUOTE}, ` +
    `slot ${LEFT_QUOTE}${entry.slot}${RIGHT_QUOTE}, ` +
    `reason ${LEFT_QUOTE}${entry.reason}${RIGHT_QUOTE}`
  );
}

/** Reduce the materializer's failed outcomes to one floor entry each. */
export function runFailureFloorFromOutcomes(
  failures: ReadonlyArray<MaterializationFailureOutcome>,
): RunFailureFloorEntry[] {
  return failures.map((outcome) => ({
    package: sanitizeFloorToken(outcome.extension),
    slot: sanitizeFloorToken(outcome.outputId),
    reason: floorReasonForOutcome(outcome),
  }));
}

/**
 * The message a failed run persists into `agent_runs.error`: one floor line per
 * failed output and nothing else. Bounded - a binding set large enough to pass
 * the ceiling is truncated at a line boundary rather than mid-sentence, because
 * half a floor line is not a floor line.
 */
export function composeRunFailureFloorMessage(
  failures: ReadonlyArray<MaterializationFailureOutcome>,
): string {
  const lines = runFailureFloorFromOutcomes(failures).map(formatRunFailureFloorLine);
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (length + cost > RUN_FAILURE_FLOOR_MAX_CHARS) break;
    kept.push(line);
    length += cost;
  }
  return kept.join("\n");
}

/** Read back a message this module composed. */
function parseComposedFloorMessage(error: string): RunFailureFloorEntry[] | null {
  const lines = error.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const entries: RunFailureFloorEntry[] = [];
  for (const line of lines) {
    const match = FLOOR_LINE_PATTERN.exec(line.trim());
    if (match === null) return null;
    const [, pkg, slot, reason] = match;
    if (!FLOOR_REASONS.has(reason)) return null;
    // A line only READS as a composed floor line if its quoted fields are
    // tokens. A failure that merely resembles the shape (or a row whose tokens
    // were written before the charset guard existed) is NOT claimed here: the
    // answer is `null`, so the surface falls through to the reading that
    // failure class already had rather than drawing its own text as a token.
    if (!FLOOR_TOKEN_CHARSET.test(pkg) || !FLOOR_TOKEN_CHARSET.test(slot)) return null;
    if (pkg.length > FLOOR_TOKEN_MAX_CHARS || slot.length > FLOOR_TOKEN_MAX_CHARS) return null;
    entries.push({ package: pkg, slot, reason: reason as RunFailureFloorReason });
  }
  return entries;
}

/** `\s` for exactly ONE character - a fixed-size test, never a scan. */
const SINGLE_WHITESPACE = /^\s$/;

/**
 * Split an outcome head of the old shape `outputId [extension]` in ONE linear
 * pass, and answer null when the head does not have that shape.
 *
 * WHY THIS IS NOT A PATTERN. The head is producer text - it arrives from
 * whatever sentence the pre-floor materializer persisted - so the cost of
 * taking it apart may depend on its LENGTH and on nothing the producer
 * chooses. The pattern this replaces, `^(\S+)\s*\[([^\]]*)\]$`, cannot promise
 * that: `\S` also matches `[`, so the id and the opening bracket compete for
 * the same characters, and a head that opens brackets and never closes one
 * makes the engine try the bracket at every position and re-scan the tail from
 * each - quadratic in the length of a string the producer chose.
 *
 * The scan below answers the SAME split. Greedy `\S+` prefers the longest id,
 * so the bracket that opens right after the head whitespace run wins when
 * there is one, and otherwise the LAST `[` inside the leading non-space run
 * does; the bracket content may not contain `]`, so the opening bracket must
 * also sit after every other `]` in the head. Each of those is one bounded
 * lookup, so the whole split is linear and its result is character for
 * character what the pattern answered.
 */
function splitBracketedHead(head: string): { outputId: string; extension: string } | null {
  const closeAt = head.length - 1;
  // `\[([^\]]*)\]$` needs at least "x[]" - a closing bracket at the end and a
  // non-empty id before the opening one.
  if (closeAt < 2 || head[closeAt] !== "]") return null;
  const lastOtherClose = head.lastIndexOf("]", closeAt - 1);
  let idEnd = 0;
  while (idEnd < head.length && !SINGLE_WHITESPACE.test(head[idEnd])) idEnd += 1;
  if (idEnd === 0) return null; // `\S+` needs at least one non-space character
  let afterSpace = idEnd;
  while (afterSpace < head.length && SINGLE_WHITESPACE.test(head[afterSpace])) afterSpace += 1;
  const openAt =
    afterSpace > idEnd && head[afterSpace] === "["
      ? afterSpace
      : head.lastIndexOf("[", idEnd - 1);
  if (openAt < 1 || openAt <= lastOtherClose) return null;
  return {
    outputId: head.slice(0, openAt === afterSpace ? idEnd : openAt),
    extension: head.slice(openAt + 1, closeAt),
  };
}

/**
 * Reduce a row written BEFORE this change. The old sentence carried the detail
 * as `outputId [extension]: raw reason`, joined by "; ", after the first "): ".
 * Only the outputId and the extension are read out of it; the raw reason is
 * discarded, never mapped, because mapping it would be reading the very text
 * the floor exists to suppress.
 */
function parseLegacyMaterializationMessage(error: string): RunFailureFloorEntry[] {
  const detailAt = error.indexOf("): ");
  if (detailAt === -1) {
    return [{ package: UNKNOWN_TOKEN, slot: UNKNOWN_TOKEN, reason: "output-not-produced" }];
  }
  const detail = error.slice(detailAt + 3);
  // "; " was the old composer's delimiter BETWEEN outcomes, but the raw reason
  // it embedded is unrestricted text and may contain "; " itself. So a fragment
  // is only accepted as an outcome when its head is genuinely an outcome head -
  // an identifier-shaped output id, optionally followed by a bracketed
  // identifier-shaped package. A fragment that is really a tail of somebody's
  // error sentence fails that test and is DROPPED, never drawn: the floor names
  // fewer targets rather than quoting a stack in a slot.
  const entries: RunFailureFloorEntry[] = [];
  for (const raw of detail.split("; ")) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const colonAt = part.indexOf(": ");
    const head = (colonAt === -1 ? part : part.slice(0, colonAt)).trim();
    const bracket = splitBracketedHead(head);
    const outputId = bracket === null ? head : bracket.outputId;
    const extension = bracket === null ? null : bracket.extension;
    if (!FLOOR_TOKEN_CHARSET.test(outputId)) continue;
    if (outputId.length > FLOOR_TOKEN_MAX_CHARS) continue;
    entries.push({
      package: sanitizeFloorToken(extension),
      slot: sanitizeFloorToken(outputId),
      reason: floorReasonForOutcome({ outputId }),
    });
  }
  return entries.length > 0
    ? entries
    : [{ package: UNKNOWN_TOKEN, slot: UNKNOWN_TOKEN, reason: "output-not-produced" }];
}

/**
 * The one entry point a surface calls: given a failed run's persisted `error`,
 * answer the floor entries to draw, or `null` when this failure is not a
 * materialization failure at all (a provider key error, an unreachable toolbox,
 * a transport failure) - those classes keep their own readings and are not
 * this leg's to change.
 *
 * Never returns raw text in any field, on either road.
 */
export function runFailureFloorForDisplay(error: string | null | undefined): RunFailureFloorEntry[] | null {
  if (typeof error !== "string") return null;
  const trimmed = error.trim();
  if (trimmed.length === 0) return null;
  const composed = parseComposedFloorMessage(trimmed);
  if (composed !== null) return composed;
  if (!trimmed.startsWith(LEGACY_MATERIALIZATION_HEADLINE)) return null;
  return parseLegacyMaterializationMessage(trimmed);
}
