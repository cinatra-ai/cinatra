// @vitest-environment jsdom
//
// cinatra#3092 — THE OPEN-IN-THE-CMS ROAD, ISLAND HALF.
//
// The card frames this document in a sandbox without `allow-popups`, so a CMS
// page display's new-tab link "Open in the CMS" was dropped by the browser. The
// island's own host code now takes that click, and only that click, for an
// address THE LINK'S OWN TARGET holds (the target whose panel draws the link),
// and posts it to the card, which opens the tab. Every other anchor is
// untouched.
//
// The modules are new with cinatra#3092. They are loaded inside each test, not
// at the top of the file: before the change the file still loads and each test
// fails on the missing module.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const ROAD = "../island-open-link";
const ADDRESSES = "../island-open-link-addresses";
const loadRoad = async () =>
  (await import(/* @vite-ignore */ ROAD)) as typeof import("../island-open-link");
const loadAddresses = async () =>
  (await import(/* @vite-ignore */ ADDRESSES)) as typeof import("../island-open-link-addresses");

/** The card half of this literal is `packages/agents/src/review-gate-card.tsx`. */
const MESSAGE_TYPE = "cinatra.review-island.open-in-cms";
const CMS = "https://acme.example/wp-admin/post.php?post=42&action=edit";
const ACTION = "open-in-cms -> cms-opened";
/** A self-hosted CMS on the LAN, on http: the source-link rule admits it. */
const LAN_CMS = "http://cms.lan:8080/node/7/edit";
/** An address with a user name and password, built here so no such literal sits in the file. */
const withCredentials = (scheme: string) => `${scheme}://${["editor", "pw"].join(":")}@acme.example/edit`;

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

/** A target panel as the island page draws it: a box carrying the target's key. */
function panel(key: string): HTMLElement {
  const div = document.createElement("div");
  div.setAttribute("data-island-target-key", key);
  document.body.appendChild(div);
  return div;
}

/** The default target of a test, and its panel. */
const KEY_A = "0:6:art-aa:rev-a";
const KEY_B = "1:6:art-bb:rev-b";

function anchor(attrs: Record<string, string>, text = "Open in the CMS", parent?: Element): HTMLAnchorElement {
  const a = document.createElement("a");
  for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
  a.textContent = text;
  (parent ?? document.querySelector(`[data-island-target-key="${KEY_A}"]`) ?? panel(KEY_A)).appendChild(a);
  return a;
}

/** Clicks the anchor and answers whether the default stayed allowed. */
function click(target: Element): boolean {
  return target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("the island takes the open-in-cms click and asks the card", () => {
  it("posts the address to the card at its own origin and prevents the default", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    const link = anchor({ href: CMS, target: "_blank", rel: "noopener noreferrer", "data-action": ACTION });
    expect(click(link)).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: CMS }, window.location.origin]]);
  });

  it("takes a click on a child of the anchor too", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    const link = anchor({ href: CMS, target: "_blank", "data-action": ACTION }, "");
    const inner = document.createElement("span");
    inner.textContent = "Open in the CMS";
    link.appendChild(inner);
    expect(click(inner)).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it("leaves another new-tab anchor untouched", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    expect(click(anchor({ href: CMS, target: "_blank" }))).toBe(true);
    expect(click(anchor({ href: CMS, target: "_blank", "data-action": "open-live-dashboard -> dashboard-canonical" }))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("leaves an open-in-cms anchor alone when its address is not one its target holds", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    expect(click(anchor({ href: "https://elsewhere.example/phish", target: "_blank", "data-action": ACTION }))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("posts an http address of a self-hosted CMS that the pinned data holds, as the source-link rule admits it", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[LAN_CMS]} />);
    expect(click(anchor({ href: LAN_CMS, target: "_blank", "data-action": ACTION }))).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: LAN_CMS }, window.location.origin]]);
  });

  it("posts nothing for an address the source-link rule refuses, even when it is listed", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    const refused = ["javascript:alert(1)", "data:text/html,hi", withCredentials("http"), withCredentials("https")];
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={refused} />);
    for (const href of refused) {
      click(anchor({ href, target: "_blank", "data-action": ACTION }));
    }
    expect(posted).toEqual([]);
  });

  it("does nothing when no target is mounted, and stops when the last one unmounts", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    const link = anchor({ href: CMS, target: "_blank", "data-action": ACTION });
    expect(click(link)).toBe(true);
    const mounted = render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    mounted.unmount();
    expect(click(link)).toBe(true);
    expect(posted).toEqual([]);
  });

  it("posts nothing when the document is not framed", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    Object.defineProperty(window, "parent", originalParent);
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    expect(click(anchor({ href: CMS, target: "_blank", "data-action": ACTION }))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("names the action by its name, not by its outcome", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { isOpenInCmsAnchor } = await loadRoad();
    expect(isOpenInCmsAnchor(anchor({ "data-action": ACTION }))).toBe(true);
    expect(isOpenInCmsAnchor(anchor({ "data-action": "open-in-cms" }))).toBe(true);
    expect(isOpenInCmsAnchor(anchor({ "data-action": "open-in-cms-x -> cms-opened" }))).toBe(false);
    expect(isOpenInCmsAnchor(anchor({ "data-action": "edit -> open-in-cms" }))).toBe(false);
    expect(isOpenInCmsAnchor(anchor({}))).toBe(false);
  });
});

describe("each target allows only its own addresses", () => {
  const CMS_B = "https://other.example/wp-admin/post.php?post=7&action=edit";
  async function twoTargets() {
    const { IslandOpenInCmsAddresses } = await loadRoad();
    const a = panel(KEY_A);
    const b = panel(KEY_B);
    render(
      <>
        <IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />
        <IslandOpenInCmsAddresses targetKey={KEY_B} addresses={[CMS_B]} />
      </>,
    );
    return { a, b };
  }

  it("two targets in one island: each control opens its own target's address", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { a, b } = await twoTargets();
    expect(click(anchor({ href: CMS, target: "_blank", "data-cms-open": "" }, "Open in the CMS", a))).toBe(false);
    expect(click(anchor({ href: CMS_B, target: "_blank", "data-cms-open": "" }, "Open in the CMS", b))).toBe(false);
    expect(posted).toEqual([
      [{ type: MESSAGE_TYPE, url: CMS }, window.location.origin],
      [{ type: MESSAGE_TYPE, url: CMS_B }, window.location.origin],
    ]);
  });

  it("a control under target A with an address only target B holds opens nothing", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { a, b } = await twoTargets();
    expect(click(anchor({ href: CMS_B, target: "_blank", "data-action": ACTION }, "Open in the CMS", a))).toBe(true);
    expect(click(anchor({ href: CMS, target: "_blank", "data-cms-open": "" }, "Open in the CMS", b))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("a marker with target B's key drawn inside target A's panel does not lend B's addresses", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { a } = await twoTargets();
    const forged = document.createElement("div");
    forged.setAttribute("data-island-target-key", KEY_B);
    a.appendChild(forged);
    expect(click(anchor({ href: CMS_B, target: "_blank", "data-cms-open": "" }, "Open in the CMS", forged))).toBe(true);
    // A's own address still opens from inside the forged marker: the panel is A's.
    expect(click(anchor({ href: CMS, target: "_blank", "data-cms-open": "" }, "Open in the CMS", forged))).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: CMS }, window.location.origin]]);
  });

  it("a control outside every target panel opens nothing, even for an allowed address", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    await twoTargets();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(click(anchor({ href: CMS, target: "_blank", "data-action": ACTION }, "Open in the CMS", outside))).toBe(true);
    expect(click(anchor({ href: CMS_B, target: "_blank", "data-cms-open": "" }, "Open in the CMS", outside))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("a panel whose target registered nothing opens nothing", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    await twoTargets();
    const c = panel("2:6:art-cc:rev-c");
    expect(click(anchor({ href: CMS, target: "_blank", "data-cms-open": "" }, "Open in the CMS", c))).toBe(true);
    expect(posted).toEqual([]);
  });

  it("when one target unmounts, the other keeps its own addresses and loses none to it", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    const a = panel(KEY_A);
    const b = panel(KEY_B);
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    const second = render(<IslandOpenInCmsAddresses targetKey={KEY_B} addresses={[CMS_B, CMS]} />);
    second.unmount();
    expect(click(anchor({ href: CMS_B, target: "_blank", "data-cms-open": "" }, "Open in the CMS", b))).toBe(true);
    expect(click(anchor({ href: CMS, target: "_blank", "data-cms-open": "" }, "Open in the CMS", b))).toBe(true);
    expect(click(anchor({ href: CMS, target: "_blank", "data-cms-open": "" }, "Open in the CMS", a))).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: CMS }, window.location.origin]]);
  });
});

describe("both forms the display pack draws the link in", () => {
  it("takes the pinned pack's form, `data-cms-open` alone", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses, isOpenInCmsAnchor } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    const link = anchor({ style: "color: inherit", href: CMS, target: "_blank", rel: "noopener noreferrer", "data-cms-open": "" });
    expect(isOpenInCmsAnchor(link)).toBe(true);
    expect(click(link)).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: CMS }, window.location.origin]]);
  });

  it("takes the newer pack's form, `data-cms-open` with the design action", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    const link = anchor({ href: CMS, target: "_blank", rel: "noopener noreferrer", "data-cms-open": "", "data-action": ACTION });
    expect(click(link)).toBe(false);
    expect(posted).toEqual([[{ type: MESSAGE_TYPE, url: CMS }, window.location.origin]]);
  });

  it("does not take a `data-cms-open` element that is not a link", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link'
    const { IslandOpenInCmsAddresses } = await loadRoad();
    render(<IslandOpenInCmsAddresses targetKey={KEY_A} addresses={[CMS]} />);
    const button = document.createElement("button");
    button.setAttribute("data-cms-open", "");
    button.setAttribute("data-href", CMS);
    panel(KEY_A).appendChild(button);
    expect(click(button)).toBe(true);
    expect(posted).toEqual([]);
  });
});

describe("the addresses come from the pinned target's own data", () => {
  it("reads the https addresses of a text projection's JSON and the host's openInSource", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link-addresses'
    const { islandOpenableAddresses } = await loadAddresses();
    const text = JSON.stringify({
      system: "wordpress",
      page: { title: "About", address: "https://acme.example/about", cmsAddress: CMS },
      excerpts: [{ before: "see the plain page", after: "javascript:alert(1)" }],
      self: "http://cms.lan:8080/node/7",
    });
    const addresses = islandOpenableAddresses({
      actions: { openInSource: "https://source.example/item" },
      content: { kind: "text", text, representationRevisionId: "rev-1" },
    });
    expect(addresses.sort()).toEqual(
      ["https://acme.example/about", CMS, "https://source.example/item", "http://cms.lan:8080/node/7"].sort(),
    );
  });

  it("admits what the source-link rule admits, without credentials, in parsed form", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link-addresses'
    const { islandOpenableAddress } = await loadAddresses();
    expect(islandOpenableAddress(LAN_CMS)).toBe(LAN_CMS);
    expect(islandOpenableAddress("http://acme.example")).toBe("http://acme.example/");
    expect(islandOpenableAddress("https://ACME.example")).toBe("https://acme.example/");
    expect(islandOpenableAddress(withCredentials("https"))).toBeNull();
    expect(islandOpenableAddress(withCredentials("http"))).toBeNull();
    expect(islandOpenableAddress("javascript:alert(1)")).toBeNull();
    expect(islandOpenableAddress("data:text/html,hi")).toBeNull();
    expect(islandOpenableAddress("ftp://acme.example/")).toBeNull();
    expect(islandOpenableAddress("/relative")).toBeNull();
    expect(islandOpenableAddress("")).toBeNull();
    expect(islandOpenableAddress(42)).toBeNull();
  });

  it("reads nothing from a target without props", async () => {
    // red-first-expect: Cannot find module '/src/app/lifecycle/review-island/island-open-link-addresses'
    const { islandOpenableAddresses } = await loadAddresses();
    expect(islandOpenableAddresses(null)).toEqual([]);
    expect(islandOpenableAddresses({ actions: { openInSource: null }, content: { kind: "none", reason: "absent" } })).toEqual([]);
  });
});
