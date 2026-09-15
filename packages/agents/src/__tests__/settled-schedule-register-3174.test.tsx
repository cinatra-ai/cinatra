// @vitest-environment jsdom
/**
 * THE TURN'S SETTLED-SCHEDULE REGISTER COUNTS MOUNTS (cinatra#3174, convergence).
 *
 * Criteria 1 and 2 both hang off one question the container asks: is a settled
 * schedule card drawn in this turn? The card answers it, because only the card
 * resolves the reading - and the register is where that answer lands.
 *
 * WHAT THIS FILE PINS, and why it exists at all. The first version of the hook
 * keyed the report on the card's own WIRE REF. Two mounts carrying the same ref
 * - a view appended twice into one turn - then shared one entry, and the first
 * of them to unmount answered `false` for the other: the container was handed
 * back a turn that still draws a settled schedule card, and the run-progress
 * panel and the next-screen card came back beside it. The key is now the ref
 * AND the mount's own id, so every mount is counted once and answers only for
 * itself.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/settled-schedule-register-3174.test.tsx
 */
import React, { useCallback, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  SettledScheduleRegisterProvider,
  useReportSettledSchedule,
} from "../lifecycle-card-runtime";

afterEach(cleanup);

/** Stands in for the card: it reports its reading and draws nothing else. */
function Reporter({ cardId, settled }: { cardId: string; settled: boolean }) {
  useReportSettledSchedule(cardId, settled);
  return <div data-testid="reporter" data-card-id={cardId} />;
}

/**
 * The container's own half, written exactly as the conversation turn writes it:
 * a SET keyed by whatever the report names, with the identity check that keeps
 * the state object stable when nothing changed.
 */
function Turn({
  cards,
}: {
  cards: ReadonlyArray<{ key: string; cardId: string; settled: boolean }>;
}) {
  const [reported, setReported] = useState<ReadonlySet<string>>(() => new Set<string>());
  const register = useCallback((id: string, settled: boolean) => {
    setReported((current) => {
      if (current.has(id) === settled) return current;
      const next = new Set(current);
      if (settled) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return (
    <div data-testid="turn" data-settled-count={reported.size}>
      <SettledScheduleRegisterProvider register={register}>
        {cards.map((c) => (
          <Reporter key={c.key} cardId={c.cardId} settled={c.settled} />
        ))}
      </SettledScheduleRegisterProvider>
    </div>
  );
}

const count = (root: HTMLElement) =>
  Number(root.querySelector('[data-testid="turn"]')!.getAttribute("data-settled-count"));

const SAME_REF = "schedule-ref-3174";

describe("the settled-schedule register", () => {
  it("counts two mounts of the SAME wire ref as two", async () => {
    const { container } = render(
      <Turn
        cards={[
          { key: "a", cardId: SAME_REF, settled: true },
          { key: "b", cardId: SAME_REF, settled: true },
        ]}
      />,
    );
    await waitFor(() => expect(count(container)).toBe(2));
  });

  it("gives the turn back only the mount that left - never the other's", async () => {
    const { container, rerender } = render(
      <Turn
        cards={[
          { key: "a", cardId: SAME_REF, settled: true },
          { key: "b", cardId: SAME_REF, settled: true },
        ]}
      />,
    );
    await waitFor(() => expect(count(container)).toBe(2));

    // One of the two duplicated views is removed from the turn. The other is
    // still on screen, still settled - so the turn is still carrying one.
    rerender(<Turn cards={[{ key: "a", cardId: SAME_REF, settled: true }]} />);
    await waitFor(() => expect(count(container)).toBe(1));
  });

  it("gives the turn back when the card leaves the settled reading", async () => {
    const { container, rerender } = render(
      <Turn cards={[{ key: "a", cardId: SAME_REF, settled: true }]} />,
    );
    await waitFor(() => expect(count(container)).toBe(1));
    rerender(<Turn cards={[{ key: "a", cardId: SAME_REF, settled: false }]} />);
    await waitFor(() => expect(count(container)).toBe(0));
  });

  it("is a no-op where no container declared a register", () => {
    // The run page and the review page declare none; a card there must report
    // into nothing rather than throw.
    const { container } = render(<Reporter cardId={SAME_REF} settled={true} />);
    expect(container.querySelector('[data-testid="reporter"]')).not.toBeNull();
  });
});
