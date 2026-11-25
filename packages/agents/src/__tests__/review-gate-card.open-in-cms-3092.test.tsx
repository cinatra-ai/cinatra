// @vitest-environment jsdom
//
// cinatra#3092 — THE OPEN-IN-THE-CMS ROAD, CARD HALF.
//
// The card frames the review island in a sandbox without `allow-popups`, so a
// CMS page display's new-tab link "Open in the CMS" did nothing in the card.
// The sandbox stays as it is: the island's host code posts the link's address
// to the card, and the card opens the tab, only for a message from ITS OWN
// frame, at the app's own origin, with exactly the fixed payload and an https
// address without credentials.
//
// The road's functions are new exports of the card module with cinatra#3092.
// They are read off the module inside each test, so before the change the file
// still loads and each such test fails on the missing export.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { LifecycleCardState, LifecycleTargetHeader } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import * as card from "../review-gate-card";
import { ReviewGateCard } from "../review-gate-card";

/** The road's exports, read off the module: before the change they are absent. */
const road = card as Partial<typeof card>;

/** The island half of this literal is `src/app/lifecycle/review-island/island-open-in-cms.tsx`. */
const MESSAGE_TYPE = "cinatra.review-island.open-in-cms";
const CMS = "https://acme.example/wp-admin/post.php?post=42&action=edit";
/** A self-hosted CMS on the LAN, on http: the source-link rule admits it. */
const LAN_CMS = "http://cms.lan:8080/node/7/edit";
/** An address with a user name and password, built here so no such literal sits in the file. */
const withCredentials = (scheme: string) => `${scheme}://${["editor", "pw"].join(":")}@acme.example/edit`;

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-open-in-cms" };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };

function headers(count: number): LifecycleTargetHeader[] {
  return Array.from({ length: count }, (_unused, i) => ({
    title: `Target ${i + 1}`,
    typeLabel: "Page",
    objectType: `@cinatra-ai/kind-${i + 1}:page`,
    revisionId: `rev-00000000000000${i + 1}`,
    facts: ["Team"],
  }));
}

function mockResolve(count: number): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          targetHeaders: headers(count),
          targetHeadersComplete: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountCard(count = 1): Promise<HTMLIFrameElement[]> {
  mockResolve(count);
  const { container } = render(
    <LifecycleCardSurfaceProvider host="page_gate_region">
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  await settle();
  const frames = Array.from(container.querySelectorAll("iframe"));
  expect(frames).toHaveLength(count);
  return frames;
}

async function post(data: unknown, source: MessageEventSource | null, origin = window.location.origin): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    await Promise.resolve();
  });
}

let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  open = vi.fn(() => null);
  vi.spyOn(window, "open").mockImplementation(open as unknown as typeof window.open);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the card opens the CMS page its own island asks for", () => {
  it("opens a matching https address from its own frame, without opener or referrer", async () => {
    const [frame] = await mountCard();
    await post({ type: MESSAGE_TYPE, url: CMS }, frame.contentWindow);
    // red-first-expect: expected "vi.fn()" to be called with arguments
    expect(open).toHaveBeenCalledWith(CMS, "_blank", "noopener,noreferrer");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("each frame of a multi-target card is heard by its own island", async () => {
    const frames = await mountCard(2);
    await post({ type: MESSAGE_TYPE, url: CMS }, frames[1].contentWindow);
    // red-first-expect: expected "vi.fn()" to be called 1 times, but got 0 times
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens an http address of a self-hosted CMS, as the source-link rule admits it", async () => {
    const [frame] = await mountCard();
    await post({ type: MESSAGE_TYPE, url: LAN_CMS }, frame.contentWindow);
    // red-first-expect: expected "vi.fn()" to be called with arguments
    expect(open).toHaveBeenCalledWith(LAN_CMS, "_blank", "noopener,noreferrer");
  });

  it("refuses another source window, another origin, and the page itself", async () => {
    await mountCard();
    const stranger = document.createElement("iframe");
    document.body.appendChild(stranger);
    await post({ type: MESSAGE_TYPE, url: CMS }, stranger.contentWindow);
    await post({ type: MESSAGE_TYPE, url: CMS }, window);
    await post({ type: MESSAGE_TYPE, url: CMS }, null);
    const [frame] = Array.from(document.querySelectorAll('[data-conformance-id="review-target-island"] iframe')) as HTMLIFrameElement[];
    await post({ type: MESSAGE_TYPE, url: CMS }, frame.contentWindow, "https://evil.example");
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses what the source-link rule refuses, an address with credentials, a malformed payload and an extra field", async () => {
    const [frame] = await mountCard();
    const source = frame.contentWindow;
    for (const data of [
      { type: MESSAGE_TYPE, url: "javascript:alert(1)" },
      { type: MESSAGE_TYPE, url: "data:text/html,hi" },
      { type: MESSAGE_TYPE, url: "ftp://acme.example/edit" },
      { type: MESSAGE_TYPE, url: withCredentials("https") },
      { type: MESSAGE_TYPE, url: withCredentials("http") },
      { type: MESSAGE_TYPE, url: "/wp-admin/post.php" },
      { type: MESSAGE_TYPE, url: 42 },
      { type: MESSAGE_TYPE },
      { type: "cinatra.review-island.height", url: CMS },
      { type: MESSAGE_TYPE, url: CMS, target: "_self" },
      [MESSAGE_TYPE, CMS],
      CMS,
      null,
    ]) {
      await post(data, source);
    }
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the message check, alone", () => {
  it("accepts exactly the fixed payload with an https address in parsed form", async () => {
    // red-first-expect: expected undefined to be 'cinatra.review-island.open-in-cms'
    expect(road.REVIEW_ISLAND_OPEN_IN_CMS_MESSAGE_TYPE).toBe(MESSAGE_TYPE);
    const readIslandOpenInCmsRequest = road.readIslandOpenInCmsRequest!;
    expect(readIslandOpenInCmsRequest({ type: MESSAGE_TYPE, url: CMS })).toBe(CMS);
    // Not in parsed form: the island always sends the parsed form.
    expect(readIslandOpenInCmsRequest({ type: MESSAGE_TYPE, url: "https://ACME.example" })).toBeNull();
    expect(readIslandOpenInCmsRequest({ type: MESSAGE_TYPE, url: LAN_CMS })).toBe(LAN_CMS);
    expect(readIslandOpenInCmsRequest({ type: MESSAGE_TYPE, url: "http://acme.example" })).toBeNull();
    expect(readIslandOpenInCmsRequest(Object.assign(Object.create({ extra: 1 }), { type: MESSAGE_TYPE, url: CMS }))).toBe(CMS);
  });

  it("opens through the given opener only for its own frame and origin", async () => {
    // red-first-expect: expected undefined to be type of 'function'
    expect(road.openIslandCmsAddress).toBeTypeOf("function");
    const openIslandCmsAddress = road.openIslandCmsAddress!;
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const opener = vi.fn();
    const event = (origin: string, source: MessageEventSource | null) =>
      new MessageEvent("message", { data: { type: MESSAGE_TYPE, url: CMS }, origin, source });
    expect(openIslandCmsAddress(event("https://app.example", frame.contentWindow), frame, "https://app.example", opener)).toBe(true);
    expect(opener).toHaveBeenCalledWith(CMS, "_blank", "noopener,noreferrer");
    expect(openIslandCmsAddress(event("https://other.example", frame.contentWindow), frame, "https://app.example", opener)).toBe(false);
    expect(openIslandCmsAddress(event("https://app.example", window), frame, "https://app.example", opener)).toBe(false);
    expect(openIslandCmsAddress(event("https://app.example", frame.contentWindow), null, "https://app.example", opener)).toBe(false);
    expect(opener).toHaveBeenCalledTimes(1);
  });
});

describe("the frame keeps withholding popups and top navigation", () => {
  it("the island frame's sandbox carries no popup and no top-navigation token", async () => {
    const [frame] = await mountCard();
    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toContain("allow-scripts");
    for (const token of tokens) {
      expect(token.startsWith("allow-popups")).toBe(false);
      expect(token.startsWith("allow-top-navigation")).toBe(false);
    }
  });
});
