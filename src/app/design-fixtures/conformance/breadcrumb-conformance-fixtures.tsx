"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness mount for `breadcrumb-entity-resolution` — the
// surface conformance/app-components.json gained in the same publication that
// retired scheduling-trigger-tab, adopted by the cinatra#3057 pin
// reconciliation.
//
// The manifest declares two field bindings, one action and one state:
//
//   crumb-label       <- entity.displayName
//   crumb-placeholder <- entity.id
//   visit-unauthorized -> resolved-names-cleared
//   state: loading
//
// EVERY ONE OF THEM IS REAL CODE, not a drawing this repo has yet to build.
// The resolution road shipped with cinatra#1737/#1738: a route's server
// component publishes its authorized crumb labels onto the contributions bus
// (src/lib/breadcrumb-contributions.ts) AFTER its authorization gates, the
// AppShell selects the applicable entries for the current pathname and epoch,
// and src/lib/breadcrumb-trail.ts turns them into crumbs — falling back to
// `idSegmentPlaceholder(segment)` for an id-like segment nobody resolved,
// which is the floor rule that keeps title-cased hex off the screen. The
// negative surfaces (404, /not-authorized) render CrumbContributionsClear,
// which wipes the parked snapshot so a previously-authorized name can never
// survive into a later unauthorized visit.
//
// So this mount does NOT model the mechanism: it drives the real one. The
// trail below is built by the real `buildBreadcrumbTrail` from the real bus's
// own `selectCrumbContributions`, rendered through the real Breadcrumb
// primitives, and the `visit-unauthorized` action MOUNTS the very
// `CrumbContributionsClear` island the negative surfaces render, rather than
// repeating its body — so the clear happens through the shipped component and
// a regression inside it reds this surface. Only the two things a
// standalone harness boot cannot have are supplied locally: a session/org
// epoch, and a route to publish from.
//
// The seed is ANTI-LOOKALIKE by the seeded-fixture convention (cinatra#986):
// the display name shares no token with the id, so a driver that asserted the
// wrong source could not accidentally pass.
// ---------------------------------------------------------------------------

import { Fragment, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  CRUMB_CONTRIBUTIONS_EVENT,
  clearCrumbContributions,
  publishCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { breadcrumbCrumbKey, buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import { CrumbContributionsClear } from "@/components/crumb-contributions";

import {
  BREADCRUMB_ENTITY_DISPLAY_NAME,
  BREADCRUMB_ENTITY_PATH,
  BREADCRUMB_HARNESS_EPOCH,
} from "./breadcrumb-conformance-seed";

/** Subscribe to the real bus and re-read it the way the AppShell does. */
function useResolvedCrumbs(): ReturnType<typeof buildBreadcrumbTrail> {
  const read = useCallback(
    () =>
      buildBreadcrumbTrail(BREADCRUMB_ENTITY_PATH, {
        contributions: selectCrumbContributions(BREADCRUMB_ENTITY_PATH, BREADCRUMB_HARNESS_EPOCH),
      }),
    [],
  );
  const [crumbs, setCrumbs] = useState(read);
  useEffect(() => {
    const sync = () => setCrumbs(read());
    window.addEventListener(CRUMB_CONTRIBUTIONS_EVENT, sync);
    return () => window.removeEventListener(CRUMB_CONTRIBUTIONS_EVENT, sync);
  }, [read]);
  return crumbs;
}

/** The real Breadcrumb primitives, rendered from real crumbs. */
function Trail({
  crumbs,
  testId,
}: {
  crumbs: ReturnType<typeof buildBreadcrumbTrail>;
  testId: string;
}) {
  return (
    <Breadcrumb data-testid={testId}>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <Fragment key={breadcrumbCrumbKey(crumb, i)}>
            {i > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** The trail with nothing published for it — the unresolved floor. */
const UNRESOLVED_CRUMBS = buildBreadcrumbTrail(BREADCRUMB_ENTITY_PATH, { contributions: [] });

export function BreadcrumbEntityResolutionFixture() {
  const [outcome, setOutcome] = useState("idle");
  // Visiting a negative surface mounts the real clear island; the harness
  // reproduces that by mounting it, not by calling its body.
  const [visitedUnauthorized, setVisitedUnauthorized] = useState(false);
  const crumbs = useResolvedCrumbs();

  // The publish a gated route's server component performs, once, on mount.
  useEffect(() => {
    publishCrumbContributions(BREADCRUMB_ENTITY_PATH, BREADCRUMB_HARNESS_EPOCH, [
      { prefix: BREADCRUMB_ENTITY_PATH, label: BREADCRUMB_ENTITY_DISPLAY_NAME },
    ]);
    return () => clearCrumbContributions();
  }, []);

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="flex flex-col gap-6 p-4">
        <p className="text-sm font-medium text-muted-foreground">
          App shell — breadcrumb entity resolution (surface:
          breadcrumb-entity-resolution)
        </p>

        <div
          data-surface-id="breadcrumb-entity-resolution"
          data-variant="populated"
          data-outcome={outcome}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Resolved from the published contribution
              </span>
              <Trail crumbs={crumbs} testId="crumb-label" />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Nothing published for it — the id placeholder floor
              </span>
              <Trail crumbs={UNRESOLVED_CRUMBS} testId="crumb-placeholder" />
            </div>

            <div className="flex justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  // Mounts CrumbContributionsClear — the island the 404 and
                  // /not-authorized surfaces render — which performs the clear
                  // in its own layout effect.
                  setVisitedUnauthorized(true);
                  setOutcome("resolved-names-cleared");
                }}
              >
                Visit an unauthorized page
              </Button>
            </div>
          </div>

          {visitedUnauthorized ? <CrumbContributionsClear /> : null}
        </div>

        {/* While the gated route has not published yet, the crumb IS its
            placeholder — the trail never renders an empty or skeleton crumb,
            so the placeholder floor is the loading treatment. */}
        <div
          data-surface-id="breadcrumb-entity-resolution"
          data-variant="loading"
          data-testid="breadcrumb-entity-resolution-loading"
        >
          <Trail crumbs={UNRESOLVED_CRUMBS} testId="crumb-placeholder-loading" />
        </div>
      </CardContent>
    </Card>
  );
}
