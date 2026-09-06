"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the REVIEW-COMPOSER family of the
// in-conversation lifecycle drawing (cinatra#3159, epic #3155 W3).
//
// Renders the REAL `ComposerFocusRow` — the shipped row above the review floor,
// exported from its own owner module the same way W0 exported `SuggestionChips`
// — fed by the REAL `useComposerFocusBinding` inside the REAL
// `LifecycleComposerFocusProvider`. So the assertions in
// tests/e2e/design/conformance/contract.ts run against the shipped three
// readings, the shipped control and the shipped control NAMES rather than
// against a stand-in.
//
// WHY THE ROW AND NOT THE CARD. The row is the piece of §I a harness can mount
// as the product mounts it. The card as a whole draws no DOM before an
// authorised server resolve, and its decision floor may not be composed outside
// the card at all — the one-card gate bans a page-direct decision composition,
// and rightly, since a second place that composes the floor is a second place
// "approved" could come to mean something different. The row has neither
// constraint: it is a props-only component over a binding the shipped hook
// computes.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind here:
// no fetch wrapper, no route stub, no seeded server answer. A gate registers
// with a comment action that is never called, because no assertion in this
// family sends a comment — §I's row is about WHERE a typed message would go, and
// the sending is the floor's own surface.
//
// WHAT THE HARNESS HOLDS. Which open review the reader chose, and nothing else
// — §I's own state, put into the SHIPPED store before the mount renders. Which
// reading each row is drawn in, which control it offers and what that control is
// named are all computed by `resolveComposerTarget` and the shipped row. The
// harness never names a reading and never names an outcome.
//
// THE MOUNT IS NAMED, NOT THE MANIFEST SURFACE, for the reason the fixture-data
// file gives in full: one drawn row stands for several manifest surfaces, so the
// binding from mount to surface lives in the driver map, on the test side.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import { useMemo, type ReactElement } from "react";

import { PromptField } from "@cinatra-ai/sdk-ui";
import {
  LifecycleCardSurfaceProvider,
  LifecycleComposerFocusProvider,
  createComposerFocusStore,
  useComposerFocusBinding,
  type ComposerCommentAction,
  type ComposerFocusStore,
} from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ComposerFocusRow } from "@cinatra-ai/agents/review-gate-card";

import {
  LIFECYCLE_CHAT_COMPOSER_MOUNT,
  LIFECYCLE_CHAT_COMPOSER_PLACEHOLDER,
  LIFECYCLE_COMPOSER_ROW_FIXTURES,
  LIFECYCLE_COMPOSER_UNBOUND_GROUP_MOUNT,
  LIFECYCLE_COMPOSER_UNBOUND_GROUP_ROWS,
  type LifecycleComposerRowFixture,
  type LifecycleComposerRowMount,
} from "./lifecycle-composer-fixture-data";

/**
 * The comment path a gate registers with.
 *
 * Never called by any assertion in this family: the row is about WHERE a typed
 * message would go, and the sending is the floor's own surface. Registering a
 * path is what makes a gate eligible, so the path has to exist; what it would
 * do is not this family's contract.
 */
const NEVER_CALLED_COMMENT: ComposerCommentAction = async () => ({
  ok: true,
  message: "",
});

/**
 * A gate the reader has open.
 *
 * Registering is what makes a gate eligible, and it is the SHIPPED hook that
 * registers — the same call the review card makes. `draws` is only about which
 * of the reader's open reviews this mount shows a row for: a second open review
 * is a fact about the reader's transcript, not a second thing on screen.
 */
function OpenGate({ gate, draws }: { gate: string; draws: boolean }): ReactElement | null {
  const binding = useComposerFocusBinding({
    ref: gate,
    // §I's row is about WHERE a typed message goes. A gate that would refuse the
    // comment draws no row at all, and that absence is the card's own pinned
    // behaviour rather than this family's surface.
    eligible: true,
    comment: NEVER_CALLED_COMMENT,
  });
  if (!draws) return null;
  return <ComposerFocusRow binding={binding} />;
}

/**
 * One drawn row, with the reader's open reviews behind it.
 *
 * The reader's choice is put into the SHIPPED store at creation, before any
 * render, so the store answers the first paint the way it would answer a reader
 * who had already pressed. Nothing about the reading is asserted here.
 */
function ComposerRowFixture({ fixture }: { fixture: LifecycleComposerRowFixture }): ReactElement {
  const store = useMemo<ComposerFocusStore>(() => {
    const created = createComposerFocusStore();
    if (fixture.chosenGate !== null) created.focus(fixture.chosenGate);
    return created;
  }, [fixture.chosenGate]);

  return (
    <div data-surface-id={fixture.mount} className="flex flex-col gap-4">
      {/* The IN-THREAD host: §I's row is drawn where a composer is. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleComposerFocusProvider store={store}>
          {fixture.gates.map((gate, index) => (
            <OpenGate key={gate} gate={gate} draws={index === 0} />
          ))}
        </LifecycleComposerFocusProvider>
      </LifecycleCardSurfaceProvider>
    </div>
  );
}

function rowFixture(mount: LifecycleComposerRowMount): LifecycleComposerRowFixture {
  const found = LIFECYCLE_COMPOSER_ROW_FIXTURES.find((fixture) => fixture.mount === mount);
  if (!found) throw new Error(`no composer-row fixture for mount "${mount}"`);
  return found;
}

/**
 * The review-composer family, one mount per drawn row.
 *
 * The two UNBOUND readings are wrapped in one group mount because §I draws them
 * as ONE example — "waiting to be told which review, or given back" — and the
 * manifest gives that example its own surface.
 */
export function LifecycleComposerFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      <ComposerRowFixture fixture={rowFixture("composer-row-bound")} />
      <ComposerRowFixture fixture={rowFixture("composer-row-acting")} />
      <div
        data-surface-id={LIFECYCLE_COMPOSER_UNBOUND_GROUP_MOUNT}
        className="flex flex-col gap-6"
      >
        {LIFECYCLE_COMPOSER_UNBOUND_GROUP_ROWS.map((mount) => (
          <ComposerRowFixture key={mount} fixture={rowFixture(mount)} />
        ))}
      </div>
      <ChatComposerFixture />
    </div>
  );
}

/**
 * The conversation's chat box — §I's ONE primary input.
 *
 * The REAL `PromptField` with the two declarations the conversation column makes
 * on it: `primary`, which is what gives it the heavier edge a card's subordinate
 * note field never takes, and the conformance id that names the role it plays.
 * Nothing else about the column is reimplemented around it, and the field's own
 * behaviour is not this surface's contract — the manifest gives it no field, no
 * action and no state.
 */
function ChatComposerFixture(): ReactElement {
  return (
    <div data-surface-id={LIFECYCLE_CHAT_COMPOSER_MOUNT} className="max-w-xl">
      <PromptField
        primary
        conformanceId="chat-composer-primary"
        placeholder={LIFECYCLE_CHAT_COMPOSER_PLACEHOLDER}
        storageKey="conformance-chat-composer"
        rows={1}
        showStatusMessage={false}
        onSubmit={() => {
          /* §I's contract here is the input's STANDING, not what it sends. */
        }}
      />
    </div>
  );
}
