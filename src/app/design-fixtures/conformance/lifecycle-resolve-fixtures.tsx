"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the RESOLVE-BACKED lifecycle cards
// (cinatra#3164, epic #3155 W8): §VII's verification card, §IV's review-state
// ladder, and the §VIII decision floor the suggestion chips ride on.
//
// MOUNTED THROUGH THE ENUMERATED ADAPTER, NOT BESIDE IT. The cards are NOT
// composed here. This route hands the raw wire payload to `RenderableViewCard`
// — the ONE renderable-view dispatch the conversation itself calls, which
// validates the payload and dispatches it to the one component registered for
// that kind — inside the shipped `LifecycleCardSurfaceProvider` host
// declaration. That is deliberate and it is the whole reason this file names no
// card: the one-card doctrine counts rendered instances, and a harness that
// composed a card of its own would be exactly the second callsite the gate
// exists to refuse. Going through the registry also makes the harness more
// faithful, not less: it is the same parse, the same dispatch and the same card
// the chat thread draws.
//
// THE ONE SUBSTITUTION, DOCUMENTED AT ITS MOUNT. These cards render NO DOM until
// an authorized resolve answers, and the harness has no session. So the suite's
// driver (tests/e2e/design/conformance/contract.ts) answers the card's OWN
// resolve request with a protocol-typed envelope from
// ./lifecycle-resolve-fixture-data, and nothing else is substituted anywhere:
// the answer goes through the shipped parse, and every drawn consequence — the
// rung of the ladder, whether any DOM exists at all, the floor's controls and
// their disabled reason, every value on the verification reading — is the
// shipped component's. The substitution lives in the TEST, so this route ships
// no answer of its own: opened outside the suite these mounts issue the same
// real request every host issues and draw nothing, which is the honest reading
// off a session.
//
// Kept OFF the pixel-diffed /design-fixtures index page (the same convention as
// every other conformance fixture): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import { type ReactElement } from "react";

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { RenderableViewCard } from "@cinatra-ai/chat/renderer";
import {
  LIFECYCLE_VIEW_RESOLVE_PATH,
  LifecycleCardSurfaceProvider,
} from "@cinatra-ai/agents/lifecycle-card-runtime";

import {
  LIFECYCLE_RESOLVE_FIXTURES,
  LIFECYCLE_RESOLVE_PATH,
  type LifecycleResolveFixture,
} from "./lifecycle-resolve-fixture-data";

/**
 * The seeded path and the SHIPPED path are the same path — checked twice, and
 * neither check is decorative. The annotation is a compile-time equality (the
 * shipped constant is a string literal type), and the mount-time throw is what
 * catches a path that moved in a build this harness did not typecheck against:
 * a driver seeding a stale path would answer nothing, every card would draw
 * nothing, and the whole family would fail as "not mounted" instead of saying
 * what actually moved.
 */
const HARNESS_RESOLVE_PATH: typeof LIFECYCLE_VIEW_RESOLVE_PATH = LIFECYCLE_RESOLVE_PATH;
if (LIFECYCLE_VIEW_RESOLVE_PATH !== HARNESS_RESOLVE_PATH) {
  throw new Error(
    "conformance harness: the seeded lifecycle resolve path no longer matches the shipped one",
  );
}

function LifecycleResolveFixtureMount({
  fixture,
}: {
  fixture: LifecycleResolveFixture;
}): ReactElement {
  return (
    <div
      data-surface-id={fixture.mount}
      // The seam this mount is read through, named on the mount itself.
      data-resolve-path={HARNESS_RESOLVE_PATH}
      className="flex flex-col gap-4"
    >
      <LifecycleCardSurfaceProvider host={fixture.host}>
        {/* The raw wire payload, exactly as a turn carries it: a kind, a version
            and an opaque ref, and nothing else. Validation and dispatch are the
            registry's. */}
        <RenderableViewCard
          data={{
            viewType: fixture.kind,
            schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
            ref: fixture.ref,
          }}
        />
      </LifecycleCardSurfaceProvider>
    </div>
  );
}

/**
 * One mount per manifest surface this wave covers on the resolve seam: the three
 * verification outcomes and the same card read in a conversation, §IV's four
 * review states, and the decision floor of §VIII.
 */
export function LifecycleResolveFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {LIFECYCLE_RESOLVE_FIXTURES.map((fixture) => (
        <LifecycleResolveFixtureMount key={fixture.mount} fixture={fixture} />
      ))}
    </div>
  );
}
