"use client";

// ---------------------------------------------------------------------------
// THE OPEN-IN-THE-CMS ROAD, ISLAND HALF (cinatra#3092).
//
// A CMS page display draws "Open in the CMS" as a plain new-tab link with the
// design action `open-in-cms -> cms-opened`. The card frames this document in a
// sandbox that withholds popups, so the browser drops that click. The sandbox
// stays as it is. Instead this host code, which runs inside the frame, takes
// the click and asks the card (outside the frame) to open the tab:
//
//   - ONE delegated click listener on this document, in the capture phase;
//   - it acts only on an anchor whose `data-action` names the `open-in-cms`
//     action, and only when the anchor's address, in parsed form, EQUALS an
//     address the island's server read from the pinned targets
//     (`island-open-link-addresses.ts`), handed here as props;
//   - then it prevents the default and posts `{ type, url }` to the parent at
//     this document's own origin, so only a card on the app's own origin
//     receives it. Inside the site widget the card is on a third-party page and
//     receives nothing: there the link stays as the sandbox leaves it.
//
// Every other anchor is untouched. The road is narrow on purpose: it serves the
// one action the design names for leaving to the CMS, and does not turn every
// new-tab link a display draws into a popup.
//
// Displays change nothing: on the artifact page they are mounted inline, this
// listener is not there, and their plain link works as it always has.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

import { islandOpenableAddress } from "./island-open-link-addresses";

/** The one message type this road posts. The card half of this literal lives in
 *  `packages/agents/src/review-gate-card.tsx` (`REVIEW_ISLAND_OPEN_IN_CMS_MESSAGE_TYPE`); both suites pin it. */
export const ISLAND_OPEN_IN_CMS_MESSAGE_TYPE = "cinatra.review-island.open-in-cms";

/** The design action this road serves. */
export const ISLAND_OPEN_IN_CMS_ACTION = "open-in-cms";

/** Is this anchor's design action the open-in-the-CMS action? The design writes
 *  an action as `<name> -> <outcome>`. */
export function isOpenInCmsAnchor(anchor: Element): boolean {
  const action = anchor.getAttribute("data-action");
  if (action === null) return false;
  return action.split("->")[0]?.trim() === ISLAND_OPEN_IN_CMS_ACTION;
}

// The addresses every mounted target of this document allows, counted per
// registration so that a target that unmounts takes only its own away.
const allowed = new Map<string, number>();
let listening: Document | null = null;

function onClick(event: MouseEvent): void {
  const start = event.target;
  if (!start || typeof (start as Node).nodeType !== "number") return;
  const element = (start as Node).nodeType === 1 ? (start as Element) : (start as Node).parentElement;
  const anchor = element?.closest("a[data-action]") ?? null;
  if (!anchor || !isOpenInCmsAnchor(anchor)) return;
  const view = anchor.ownerDocument.defaultView;
  // Not framed: nobody to ask, and nothing withholds the link.
  if (!view || view.parent === view) return;
  const address = islandOpenableAddress((anchor as HTMLAnchorElement).href);
  if (address === null || !allowed.has(address)) return;
  event.preventDefault();
  view.parent.postMessage({ type: ISLAND_OPEN_IN_CMS_MESSAGE_TYPE, url: address }, view.location.origin);
}

/**
 * Adds one target's addresses and starts the listener with the first one;
 * the returned function takes them away and stops it with the last one.
 */
export function registerIslandOpenInCmsAddresses(doc: Document, addresses: readonly string[]): () => void {
  const own = addresses
    .map((address) => islandOpenableAddress(address))
    .filter((address): address is string => address !== null);
  for (const address of own) allowed.set(address, (allowed.get(address) ?? 0) + 1);
  if (listening === null) {
    doc.addEventListener("click", onClick, true);
    listening = doc;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const address of own) {
      const count = (allowed.get(address) ?? 0) - 1;
      if (count > 0) allowed.set(address, count);
      else allowed.delete(address);
    }
    if (allowed.size === 0 && listening !== null) {
      listening.removeEventListener("click", onClick, true);
      listening = null;
    }
  };
}

/** One pinned target's addresses for the road. Draws nothing. */
export function IslandOpenInCmsAddresses({ addresses }: { addresses: readonly string[] }): null {
  const key = addresses.join("\n");
  useEffect(() => {
    if (key === "") return;
    return registerIslandOpenInCmsAddresses(document, key.split("\n"));
  }, [key]);
  return null;
}
