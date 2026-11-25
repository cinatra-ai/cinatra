// @vitest-environment jsdom
//
// cinatra#3092 — THE OPEN-IN-THE-CMS ROAD, ISLAND HALF.
//
// The card frames this document in a sandbox without `allow-popups`, so a CMS
// page display's new-tab link "Open in the CMS" was dropped by the browser. The
// island's own host code now takes that click, and only that click, for an
// address the pinned targets hold, and posts it to the card, which opens the
// tab. Every other anchor is untouched.
//
// The modules are new with cinatra#3092. They are loaded inside each test, not
// at the top of the file: before the change the file still loads and each test
// fails on the missing module.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const ROAD = "../island-open-in-cms";
const ADDRESSES = "../island-open-in-cms-addresses";
const loadRoad = async () =>
  (await import(/* @vite-ignore */ ROAD)) as typeof import("../island-open-in-cms");
const loadAddresses = async () =>
  (await import(/* @vite-ignore */ ADDRESSES)) as typeof import("../island-open-in-cms-addresses");

/** The card half of this literal is `packages/agents/src/review-gate-card.tsx`. */
const MESSAGE_TYPE = "cinatra.review-island.open-in-cms";
const CMS = "https://acme.example/wp-admin/post.php?post=42&action=edit";
const ACTION = "open-in-cms -> cms-opened";

const originalParent = Object.getOwnPropertyDescriptor(window, "parent")!;
let posted: Array<[unknown, string]>;

beforeEach(() => {
  posted = [];
  // Framed: the parent is the card's window, not this one.
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: {
      postMessage: (message: unknown, targetOrigin: string) => {
        posted.push([message, targetOrigin]);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  Object.defineProperty(window, "parent", originalParent);
  vi.restoreAllMocks();
});

function anchor(attrs: Record<string, string>, text = "Open in the CMS"): HTMLAnchorElement {
  const a = document.createElement("a");
  for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
  a.textContent = text;
  document.body.appendChild(a);
  return a;
}

/** Clicks the anchor and answers whether the default stayed allowed. */
function click(target: Element): boolean {
  return target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("the island takes the open-in-cms click and asks the card", () => {
  it("posts the address to the card at its own origin and prevents the default", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses addresses={[CMS]} />);
    const link = anchor({ href: CMS, target: "_blank", rel: "noopener noreferrer", "data-action": ACTION });
    expect(click(link)).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: CMS }, window.location.origin]]);
  });

  it("takes a click on a child of the anchor too", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses addresses={[CMS]} />);
    const link = anchor({ href: CMS, target: "_blank", "data-action": ACTION }, "");
    const inner = document.createElement("span");
    inner.textContent = "Open in the CMS";
    link.appendChild(inner);
    expect(click(inner)).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it("leaves another new-tab anchor untouched", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses addresses={[CMS]} />);
    expect(click(anchor({ href: CMS, target: "_blank" }))).toBe(true);
    expect(click(anchor({ href: CMS, target: "_blank", "data-action": "open-live-dashboard -> dashboard-canonical" }))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("leaves an open-in-cms anchor alone when its address is not one the pinned targets hold", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses addresses={[CMS]} />);
    expect(click(anchor({ href: "https://elsewhere.example/phish", target: "_blank", "data-action": ACTION }))).toBe(true);
    expect(click(anchor({ href: "http://acme.example/wp-admin/post.php?post=42&action=edit", "data-action": ACTION }))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("does nothing when no target is mounted, and stops when the last one unmounts", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    const link = anchor({ href: CMS, target: "_blank", "data-action": ACTION });
    expect(click(link)).toBe(true);
    const mounted = render(<IslandOpenInCmsAddresses addresses={[CMS]} />);
    mounted.unmount();
    expect(click(link)).toBe(true);
    expect(posted).toEqual([]);
  });

  it("posts nothing when the document is not framed", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    Object.defineProperty(window, "parent", originalParent);
    render(<IslandOpenInCmsAddresses addresses={[CMS]} />);
    expect(click(anchor({ href: CMS, target: "_blank", "data-action": ACTION }))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("names the action by its name, not by its outcome", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms'
    const { isOpenInCmsAnchor } = await loadRoad();
    expect(isOpenInCmsAnchor(anchor({ "data-action": ACTION }))).toBe(true);
    expect(isOpenInCmsAnchor(anchor({ "data-action": "open-in-cms" }))).toBe(true);
    expect(isOpenInCmsAnchor(anchor({ "data-action": "open-in-cms-x -> cms-opened" }))).toBe(false);
    expect(isOpenInCmsAnchor(anchor({ "data-action": "edit -> open-in-cms" }))).toBe(false);
    expect(isOpenInCmsAnchor(anchor({}))).toBe(false);
  });
});

describe("the addresses come from the pinned target's own data", () => {
  it("reads the https addresses of a text projection's JSON and the host's openInSource", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms-addresses'
    const { islandOpenableAddresses } = await loadAddresses();
    const text = JSON.stringify({
      system: "wordpress",
      page: { title: "About", address: "https://acme.example/about", cmsAddress: CMS },
      excerpts: [{ before: "see http://plain.example", after: "javascript:alert(1)" }],
    });
    const addresses = islandOpenableAddresses({
      actions: { openInSource: "https://source.example/item" },
      content: { kind: "text", text, representationRevisionId: "rev-1" },
    });
    expect(addresses.sort()).toEqual(["https://acme.example/about", CMS, "https://source.example/item"].sort());
  });

  it("refuses an address with credentials, another scheme, or no two slashes", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms-addresses'
    const { islandOpenableAddress } = await loadAddresses();
    expect(islandOpenableAddress("https://user:pass@acme.example/")).toBeNull();
    expect(islandOpenableAddress("http://acme.example/")).toBeNull();
    expect(islandOpenableAddress("https:acme.example")).toBeNull();
    expect(islandOpenableAddress("/relative")).toBeNull();
    expect(islandOpenableAddress(`https://acme.example/${"a".repeat(3000)}`)).toBeNull();
    expect(islandOpenableAddress("https://ACME.example")).toBe("https://acme.example/");
  });

  it("reads nothing from a target without props", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-in-cms-addresses'
    const { islandOpenableAddresses } = await loadAddresses();
    expect(islandOpenableAddresses(null)).toEqual([]);
    expect(islandOpenableAddresses({ actions: { openInSource: null }, content: { kind: "none", reason: "absent" } })).toEqual([]);
  });
});
