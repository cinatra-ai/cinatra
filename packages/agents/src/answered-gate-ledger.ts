/**
 * THE ANSWERED-GATE LEDGER of one run panel mount (cinatra#3080).
 *
 * Each gate submit that suppresses its gate arms the ledger and takes a
 * token. The ledger holds:
 *  - `pair`: the gate of the last armed submit (renderer and review task),
 *    with the tokens of the submits of that same gate, or null;
 *  - `claims`: for each review task that names one gate
 *    (`reviewTaskIdNamesOneGate`), the tokens of the submits that answered it.
 *    A shared `setup-<runId>` id and a blank id are never claimed.
 *
 * Duplicate submits of one gate are expected (a double click, chat plus form;
 * see hitl-gate-submit.ts), and the server answers the loser with a blocked
 * result. So a submit that fails (blocked or thrown) releases only what its
 * own token added: its token on the pair and its claim on its review task.
 * The pair is released only when no submit of its gate holds it, and a review
 * task leaves `claims` only when no submit holds it. A losing duplicate submit
 * therefore never takes back the suppression of an accepted one, and a late
 * failure of one submit never clears the pair of a later submit of another
 * gate.
 *
 * Pure and framework-free: the panel keeps one ledger in a ref and passes
 * `pair` and `claims` to `applyJustSubmittedSuppression`.
 */
import { reviewTaskIdNamesOneGate, type JustSubmittedGate } from "./run-surface-status";

export type ArmedAnsweredGate = JustSubmittedGate & { readonly holders: Set<number> };

export type AnsweredGateLedger = {
  pair: ArmedAnsweredGate | null;
  readonly claims: Map<string, Set<number>>;
  readonly claimOfToken: Map<number, string>;
  nextToken: number;
};

export function createAnsweredGateLedger(): AnsweredGateLedger {
  return { pair: null, claims: new Map(), claimOfToken: new Map(), nextToken: 1 };
}

/**
 * Arm the pair and claim the review task for one submit; returns its token.
 * A submit of the gate the pair already names joins the pair's holders; a
 * submit of another gate replaces the pair.
 */
export function armAnsweredGate(ledger: AnsweredGateLedger, gate: JustSubmittedGate): number {
  const token = ledger.nextToken;
  ledger.nextToken += 1;
  const current = ledger.pair;
  if (
    current !== null &&
    current.xRenderer === gate.xRenderer &&
    current.reviewTaskId === gate.reviewTaskId
  ) {
    current.holders.add(token);
  } else {
    ledger.pair = {
      xRenderer: gate.xRenderer,
      reviewTaskId: gate.reviewTaskId,
      holders: new Set([token]),
    };
  }
  if (reviewTaskIdNamesOneGate(gate.reviewTaskId)) {
    let holders = ledger.claims.get(gate.reviewTaskId);
    if (holders === undefined) {
      holders = new Set();
      ledger.claims.set(gate.reviewTaskId, holders);
    }
    holders.add(token);
    ledger.claimOfToken.set(token, gate.reviewTaskId);
  }
  return token;
}

/**
 * Undo what the submit with this token added: its token on the pair (the pair
 * is released when no holder is left) and its claim on its review task. A
 * token released before, or armed before the last reset or a replacing arm,
 * leaves the pair alone.
 */
export function releaseAnsweredGate(ledger: AnsweredGateLedger, token: number): void {
  const pair = ledger.pair;
  if (pair !== null && pair.holders.delete(token) && pair.holders.size === 0) {
    ledger.pair = null;
  }
  const reviewTaskId = ledger.claimOfToken.get(token);
  if (reviewTaskId === undefined) return;
  ledger.claimOfToken.delete(token);
  const holders = ledger.claims.get(reviewTaskId);
  if (holders === undefined) return;
  holders.delete(token);
  if (holders.size === 0) ledger.claims.delete(reviewTaskId);
}

/** The render-time clear: the next gate is drawn, so the pair is released; claims stay. */
export function clearAnsweredPair(ledger: AnsweredGateLedger): void {
  ledger.pair = null;
}

/** Re-check: release the pair and every claim. Tokens keep counting up. */
export function resetAnsweredGates(ledger: AnsweredGateLedger): void {
  ledger.pair = null;
  ledger.claims.clear();
  ledger.claimOfToken.clear();
}
