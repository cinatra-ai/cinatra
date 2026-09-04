/**
 * THE ROW THE READER DID SEE KEEPS ITS PLACE IN THE TURN (cinatra#3062, fix leg 3).
 *
 * THE SENTENCE THIS MODULE EXISTS FOR, from the ratified drawing's section V:
 *
 *   "A row whose boxes were all left clear is not the same as a card the reader
 *    may not read. Absent (§IV) is no card DOM at all, and it is reserved for the
 *    reader who may not see the thing. A row the reader did see keeps its place
 *    in the turn and states, box by box, that no recommended skill was applied —
 *    otherwise the question, the answer and the fact that nothing was applied all
 *    vanish from the transcript together, and nothing on screen says any of it
 *    happened."
 *
 * WHAT WAS MEASURED, AND WHY A COMPONENT CANNOT REMEMBER IT ON ITS OWN. The
 * conversation's mount of this card draws NO DOM AT ALL until its own client
 * round trip lands — the card's own words for the run page's version of the same
 * defect: "a step drawn only after a round trip is a step drawn NEVER when that
 * round trip does not land". In a conversation that is not a first-paint
 * inconvenience, because the transcript RE-CREATES its turns: the page replaces
 * its whole message array whenever the server's copy of the thread grows, so the
 * card is REMOUNTED with no memory of the row it had just drawn. A live boot
 * measured exactly that: the settled row stood for twelve seconds after the one
 * Continue, disappeared for the next fifteen while a fresh mount re-read the
 * authority, and came back only when that read landed; a fresh page load drew no
 * row at all for twenty seconds. React state cannot close that, because the
 * state dies with the instance that is being replaced.
 *
 * So the reading the card DREW is remembered beside the component, keyed by the
 * run it is about, and a mount that has no answer yet redraws the row it already
 * showed this reader rather than emptying the turn.
 *
 * WHAT IT IS NOT. It is not an authority and it never becomes one:
 *
 *   · it is written ONLY from an answer the authority already gave THIS reader,
 *     in THIS browser, for THIS run — nothing is invented and nothing new is
 *     disclosed, because the row it redraws is the row that was on screen;
 *   · the authority's own answer REPLACES it the moment one lands, so a reading
 *     that has moved on is corrected by the same round trip that always
 *     corrected it — one read later, exactly as the wire path already behaves
 *     for a transport failure ("stay with the last authorized answer");
 *   · it grants no decision. Every press still goes to the decision path, which
 *     re-authorizes from scratch and refuses a decision the run has moved past —
 *     said on screen through the row's own refusal line;
 *   · `{ state: "none" }` is never remembered. That answer is the resolver's
 *     single indistinguishable "never held / not yours / cannot tell", and §IV's
 *     Absent reading belongs to the reader who never saw the row at all.
 *
 * WHERE IT LIVES. An in-memory map for the page session, mirrored best-effort
 * into `sessionStorage` so a RELOAD of the same conversation in the same browser
 * session keeps the row too — the reload is the other half of the same
 * measurement. Every storage touch is wrapped: a browser that refuses storage
 * simply has the in-memory half, and the card behaves exactly as it does today.
 */
import type { RunRecommendationHoldState } from "./run-recommendation-actions";

/** One key per run, namespaced so nothing else in the origin can collide. */
const STORAGE_PREFIX = "cinatra.recommendation-row-seen.";

/** The page session's own memory. Authoritative over the storage mirror: it is
 *  written by the very render that drew the row. */
const drawn = new Map<string, RunRecommendationHoldState>();

/** A state that DRAWS A ROW. `none` is not one, and neither is a payload this
 *  bundle cannot classify — a remembered reading must be one the card can draw. */
function drawsARow(state: unknown): state is RunRecommendationHoldState {
  if (state === null || typeof state !== "object") return false;
  const kind = (state as { state?: unknown }).state;
  return kind === "held" || kind === "confirmed" || kind === "skipped";
}

function storage(): Storage | null {
  try {
    // `window` is absent on the server render and `sessionStorage` throws in a
    // browser configured to refuse site data — both are "no mirror", never a
    // failure the card has to handle.
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Remember the reading this card just DREW for `runId`.
 *
 * Called with what the card draws, never with what it merely received: a `none`
 * answer and an unclassifiable payload are both ignored, so the memory can only
 * ever hold a row a reader was actually shown.
 */
export function rememberDrawnRecommendationReading(
  runId: string,
  state: RunRecommendationHoldState | null,
): void {
  if (!runId || !drawsARow(state)) return;
  drawn.set(runId, state);
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(`${STORAGE_PREFIX}${runId}`, JSON.stringify(state));
  } catch {
    // A full or refused storage costs the reload half and nothing else.
  }
}

/**
 * The last reading this reader was shown for `runId`, or `null` when they have
 * been shown none. The in-memory half wins; the storage mirror answers a mount
 * that follows a reload.
 */
export function recallDrawnRecommendationReading(
  runId: string,
): RunRecommendationHoldState | null {
  if (!runId) return null;
  const live = drawn.get(runId);
  if (live !== undefined) return live;
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(`${STORAGE_PREFIX}${runId}`);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!drawsARow(parsed)) return null;
    // Promoted into the page session's own map so the next mount costs no parse.
    drawn.set(runId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Drop every remembered reading. For suites only — a page never forgets on
 *  purpose, because forgetting is the defect this module exists to prevent. */
export function resetDrawnRecommendationReadings(): void {
  drawn.clear();
  const store = storage();
  if (store === null) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing to clear that this process can reach.
  }
}
