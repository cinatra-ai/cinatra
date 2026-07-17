"use client";

// Publisher islands for the crumb-contributions bus (cinatra#1737).
//
// <CrumbContributions/> is rendered by a route's SERVER component — strictly
// AFTER its authorization gates (publishing must never precede the gate; the
// entries carry entity names) — and publishes the route's resolved crumb
// labels to the bus the AppShell consumes. A server component cannot write a
// client bus, hence this tiny island (the chat-shell-bus pattern generalized).
//
// <CrumbContributionsClear/> is rendered by the negative surfaces (the 404
// boundary and /not-authorized): visiting one wipes the parked snapshot, so a
// previously-authorized label can never survive into a later unauthorized
// visit.
//
// There is deliberately NO unmount clear on the publisher: the ratified
// soft-nav seeding (/teams/X → /teams/X/settings shows the intermediate name
// immediately) depends on the snapshot outliving its route; replacement
// happens on the next route's publish, fencing via (pathname, epoch) scoping
// in the bus.

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import {
  clearCrumbContributions,
  publishCrumbContributions,
  type CrumbContribution,
} from "@/lib/breadcrumb-contributions";
import { useCrumbEpoch } from "@/components/crumb-epoch-context";

export function CrumbContributions({
  entries,
}: {
  readonly entries: readonly CrumbContribution[];
}) {
  const pathname = usePathname();
  // The session/org fence, provided by the root layout — see
  // crumb-epoch-context.tsx. Server publishers never pass identity down; the
  // island stamps whatever the CURRENT shell epoch is.
  const epoch = useCrumbEpoch();
  // Key the effect on the serialized entries: RSC re-renders hand the client
  // component a fresh array identity each pass; serializing keeps the publish
  // idempotent instead of re-firing per render.
  const serialized = JSON.stringify(entries);
  useEffect(() => {
    publishCrumbContributions(
      pathname,
      epoch,
      JSON.parse(serialized) as CrumbContribution[],
    );
  }, [pathname, epoch, serialized]);
  return null;
}

export function CrumbContributionsClear() {
  useEffect(() => {
    clearCrumbContributions();
  }, []);
  return null;
}
