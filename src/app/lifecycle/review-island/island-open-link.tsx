"use client";

// ---------------------------------------------------------------------------
// THE OPEN-IN-THE-CMS ROAD, ISLAND HALF (cinatra#3092).
//
// A CMS page display draws "Open in the CMS" as a plain new-tab link. The card
// frames this document in a sandbox that withholds popups, so the browser drops
// that click. The sandbox stays as it is. Instead this host code, which runs
// inside the frame, takes the click and asks the card (outside the frame) to
// open the tab:
//
//   - ONE delegated click listener on this document, in the capture phase;
//   - it acts only on the display's open-in-the-CMS anchor, in the form every
//     pinned pack version draws: `data-cms-open`, or the design action
//     `data-action="open-in-cms -> cms-opened"`;
//   - EACH TARGET ALLOWS ONLY ITS OWN ADDRESSES. The island's server reads each
//     pinned target's addresses (`island-open-link-addresses.ts`) and registers
//     them under that target's own key; the target's panel carries the same key
//     as `data-island-target-key`. The listener finds the panel the clicked
//     anchor sits in (the outermost element with that key) and checks the anchor's address, in parsed
//     form, against THAT target's set only. An anchor outside every panel, or
//     whose address only another target holds, is not taken;
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

/** The attribute each target panel carries with its own key. */
export const ISLAND_TARGET_KEY_ATTRIBUTE = "data-island-target-key";

/** The anchors that may be the open-in-the-CMS link, in both pack forms. */
const OPEN_IN_CMS_CANDIDATE = "a[data-cms-open], a[data-action]";

/** Is this anchor the open-in-the-CMS link? The pack marks it `data-cms-open`;
 *  newer pack versions also name the design action, written `<name> -> <outcome>`. */
export function isOpenInCmsAnchor(anchor: Element): boolean {
  if (anchor.hasAttribute("data-cms-open")) return true;
  const action = anchor.getAttribute("data-action");
  if (action === null) return false;
  return action.split("->")[0]?.trim() === ISLAND_OPEN_IN_CMS_ACTION;
}

// The addresses each mounted target allows, under that target's own key and
// counted per registration, so a target that unmounts takes only its own away.
const allowedByTarget = new Map<string, Map<string, number>>();
let registrations = 0;
let listening: Document | null = null;

function onClick(event: MouseEvent): void {
  const start = event.target;
  if (!start || typeof (start as Node).nodeType !== "number") return;
  const element = (start as Node).nodeType === 1 ? (start as Element) : (start as Node).parentElement;
  const anchor = element?.closest(OPEN_IN_CMS_CANDIDATE) ?? null;
  if (!anchor || !isOpenInCmsAnchor(anchor)) return;
  const view = anchor.ownerDocument.defaultView;
  // Not framed: nobody to ask, and nothing withholds the link.
  if (!view || view.parent === view) return;
  // The target this anchor is drawn in; outside every target, nothing.
  // The host's wrapper is the OUTERMOST element carrying the key: the island page
  // draws it around the whole panel, and everything a display renders is inside
  // it. A display could draw the same attribute itself, with another target's
  // key, nearer to the anchor; the nearest match must therefore never decide.
  let targetKey: string | null = null;
  for (let node: Element | null = anchor; node; node = node.parentElement) {
    const key = node.getAttribute(ISLAND_TARGET_KEY_ATTRIBUTE);
    if (key !== null) targetKey = key;
  }
  if (targetKey === null) return;
  const allowed = allowedByTarget.get(targetKey);
  const address = islandOpenableAddress((anchor as HTMLAnchorElement).href);
  if (address === null || !allowed?.has(address)) return;
  event.preventDefault();
  view.parent.postMessage({ type: ISLAND_OPEN_IN_CMS_MESSAGE_TYPE, url: address }, view.location.origin);
}

/**
 * Adds one target's addresses under its key and starts the listener with the
 * first registration; the returned function takes them away and stops the
 * listener with the last one.
 */
export function registerIslandOpenInCmsAddresses(
  doc: Document,
  targetKey: string,
  addresses: readonly string[],
): () => void {
  const own = addresses
    .map((address) => islandOpenableAddress(address))
    .filter((address): address is string => address !== null);
  const allowed = allowedByTarget.get(targetKey) ?? new Map<string, number>();
  allowedByTarget.set(targetKey, allowed);
  for (const address of own) allowed.set(address, (allowed.get(address) ?? 0) + 1);
  registrations += 1;
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
    if (allowed.size === 0 && allowedByTarget.get(targetKey) === allowed) allowedByTarget.delete(targetKey);
    registrations -= 1;
    if (registrations === 0 && listening !== null) {
      listening.removeEventListener("click", onClick, true);
      listening = null;
    }
  };
}

/** One pinned target's addresses for the road, under the key its panel carries. Draws nothing. */
export function IslandOpenInCmsAddresses({
  targetKey,
  addresses,
}: {
  targetKey: string;
  addresses: readonly string[];
}): null {
  const list = addresses.join("\n");
  useEffect(() => {
    if (list === "") return;
    return registerIslandOpenInCmsAddresses(document, targetKey, list.split("\n"));
  }, [targetKey, list]);
  return null;
}
