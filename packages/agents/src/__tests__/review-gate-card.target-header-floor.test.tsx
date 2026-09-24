// @vitest-environment jsdom
//
// THE TARGET PANEL HAS A READING OF ITS OWN (cinatra#3051).
//
// THE DEFECT. Everything the reader must be told about what is under review —
// the immutable header of `app-artifact-review` §IV (title, package, revision,
// pinned, ownership, visibility, updated) and the never-blank floor of its §V —
// lived only INSIDE the island document. So every state that is not a painted
// frame drew a panel that named nothing at all. Measured inside a third-party
// application at the pending instant: "The preview did not load — This does not
// block your decision below — try again, or continue without it", with no header
// above it and no `package · slot · reason` line under it, while the same card,
// on the same host, in the same slot, drew the full header and the rendered body
// at the settled instant minutes later.
//
// WHAT IS PINNED HERE. The header and the floor come off the GATE'S OWN ROWS on
// the resolve answer, so they are on screen at the card's FIRST render and do
// not depend on the frame fetching anything —
//
//   1. at first render, before any load event, on EVERY host;
//   2. still there past the island's bound, beside the retry;
//   3. IDENTICAL on the widget arm and on the chat host — no host is a special
//      case, and the chat host draws what it drew plus this same reading;
//   4. never blank: an answer that carries no rows still draws the §V line;
//   5. and the CREDENTIALED retry does not remount the frame on the address it
//      just spent (see the sibling measurement in
//      src/lib/lifecycle/__tests__/review-island-first-render.test.ts).
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/review-gate-card.target-header-floor.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type {
  LifecycleCardHost,
  LifecycleCardState,
  LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { REVIEW_TARGET_ISLAND_PATH, ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const REF = "ref-3051-target-rows";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const SETTLED: LifecycleCardState = { state: "settled", outcome: "approved" };
const FRAME = { assistant: "wordpress", instanceId: "inst-1" };
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};
const SEALED = "AAAA-sealed_credential-BBBB";
const WIDGET_ISLAND_SRC = `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`;

/** The gate's own pinned target header, exactly as the resolve answers it.
 *  Composed SERVER-SIDE (`readReviewTargetHeaders`) out of the same reads and
 *  the same surface-model wording the island's own header uses, so the card
 *  words no fact itself: the scope words arrive in the host's own vocabulary
 *  and the stored instant arrives already read as a relative time. */
const HEADER: LifecycleTargetHeader = {
  title: "Launch post draft",
  typeLabel: "Blog Post Artifact",
  objectType: "@cinatra-ai/blog-post-artifact:post",
  revisionId: "ea615d36-2ad7-4a11-9f0e-8c1b2d3e4f56",
  facts: ["Organization", "Organization", "text/markdown", "updated 8 minutes ago"],
};

/** Every host that draws this card (§IX). */
const HOSTS: LifecycleCardHost[] = [
  "chat_thread",
  "run_card",
  "page_gate_region",
  "site_widget",
];

function mockResolve(
  state: LifecycleCardState,
  targetHeaders: readonly LifecycleTargetHeader[] | null,
  islandSrc: string | null,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state,
          body: null,
          ...(islandSrc ? { islandSrc } : {}),
          ...(targetHeaders ? { targetHeaders } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderOn(
  host: LifecycleCardHost,
  options: {
    state?: LifecycleCardState;
    headers?: readonly LifecycleTargetHeader[] | null;
  } = {},
): Promise<HTMLElement> {
  const widget = host === "site_widget";
  mockResolve(
    options.state ?? PENDING,
    options.headers === undefined ? [HEADER] : options.headers,
    widget ? WIDGET_ISLAND_SRC : null,
  );
  const { container } = render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(widget ? { auth: WIDGET_AUTH, frame: FRAME } : {})}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull(),
  );
  return container;
}

function reading(root: HTMLElement): HTMLElement | null {
  return root.querySelector("[data-review-target-reading]");
}

function header(root: HTMLElement): HTMLElement | null {
  return root.querySelector("[data-review-target-header]");
}

function floor(root: HTMLElement): HTMLElement | null {
  return root.querySelector("[data-review-target-floor]");
}

/** Advance past the island's load bound and let React commit — deterministically,
 *  inside `act`, so this never races a `waitFor` running on the same fake clock. */
async function pastTheBound(root: HTMLElement): Promise<void> {
  // The shipped island suite's own idiom: the ASYNC advance inside `act`, then
  // `waitFor`. The synchronous advance raced its own commit under a full
  // parallel run.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(13_000);
  });
  await waitFor(() =>
    expect(
      root.querySelector('[data-conformance-id="review-target-island-timeout"]'),
      "the island reports it did not load",
    ).not.toBeNull(),
  );
}

/** Write one of the island's OWN two documents into the framed document and
 *  report the load, the way a real navigation does. */
async function frameLoads(root: HTMLElement, anchor: string): Promise<void> {
  const frame = root.querySelector("iframe")!;
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<html><body><div data-conformance-id="${anchor}"></div></body></html>`);
  doc.close();
  await act(async () => {
    fireEvent.load(frame);
  });
}

describe("the header and the floor are on screen at the FIRST render, on every host", () => {
  it("names the artifact before any frame has loaded", async () => {
    for (const host of HOSTS) {
      const root = await renderOn(host);
      // The frame is mounted and has NOT reported a load — this is the instant
      // the capture photographed.
      const frame = root.querySelector("iframe");
      expect(frame, `${host}: the island is still framed`).not.toBeNull();
      expect(
        root.querySelector('[data-conformance-id="review-target-island"]')
          ?.getAttribute("data-island-load-state"),
        `${host}: the frame has not painted`,
      ).toBe("loading");

      const head = header(root);
      expect(head, `${host}: the target header is drawn`).not.toBeNull();
      const text = head!.textContent ?? "";
      // §IV — every field the drawing names, from the gate's own row.
      expect(text, `${host}: title`).toContain("Launch post draft");
      expect(text, `${host}: type tag`).toContain("Blog Post Artifact");
      expect(text, `${host}: package/type id`).toContain(
        "@cinatra-ai/blog-post-artifact:post",
      );
      expect(text, `${host}: revision`).toContain("revision ea615d36-2ad");
      expect(text, `${host}: pinned`).toContain("pinned");
      // The DRAWN line: bare scope words in the host's own vocabulary, and the
      // instant as a relative reading — never a labelled enum, never raw.
      expect(text, `${host}: the scope words`).toContain(
        "Organization · Organization",
      );
      expect(text, `${host}: the relative time`).toContain("updated 8 minutes ago");
      expect(text, `${host}: no raw instant`).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(text, `${host}: mime`).toContain("text/markdown");
      // The exact revision is preserved for the reader who hovers it.
      expect(
        head!.querySelector("[title]")?.getAttribute("title"),
        `${host}: full revision`,
      ).toBe(HEADER.revisionId);

      // §V — the one sanitized line, package · slot · reason.
      const line = floor(root);
      expect(line, `${host}: the floor line is drawn`).not.toBeNull();
      expect(line!.getAttribute("data-review-target-floor"), host).toBe("preview-loading");
      // AMENDED (cinatra#3058, fix leg 8). This pin used to read the artifact
      // TYPE's defining package onto the line. §V fixes where that name may come
      // from — "The resolution is host-derived, never a claim the client or the
      // model can forge" — and this overlay is the card's own, drawn for a frame
      // that never reached a renderer. So the line drops the half it cannot
      // know and keeps the two it can. See the floor-line component for the
      // whole reasoning, and `drawing-departures-3141` for the shared-package
      // control.
      expect(line!.getAttribute("data-review-floor-package"), host).toBe("");
      expect(line!.getAttribute("data-review-floor-slot"), host).toBe("detail");
      expect(line!.textContent, host).toBe(
        'slot "detail" · reason "preview-loading"',
      );
      cleanup();
    }
  });

  it("draws the SAME reading on the widget arm as on the chat host", async () => {
    const widget = reading(await renderOn("site_widget"))!.innerHTML;
    cleanup();
    const chat = reading(await renderOn("chat_thread"))!.innerHTML;
    expect(widget).toBe(chat);
  });

  it("draws it on the DECIDED reading too — the same panel, read-only", async () => {
    const root = await renderOn("site_widget", { state: SETTLED });
    expect(header(root)?.textContent).toContain("Launch post draft");
    expect(floor(root)?.getAttribute("data-review-target-floor")).toBe("preview-loading");
  });
});

describe("past the island's bound, the panel still names its target", () => {
  it("keeps the header and turns the floor to the unavailable reading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = await renderOn("site_widget");
    await pastTheBound(root);
    // The shipped copy is unchanged — a preview that did not load is still never
    // drawn as a reason the reviewer cannot decide.
    expect(root.textContent).toContain("The preview did not load");
    // And the target is still named, which is what was missing.
    expect(header(root)?.textContent).toContain("Launch post draft");
    expect(header(root)?.textContent).toContain("revision ea615d36-2ad");
    expect(floor(root)?.getAttribute("data-review-target-floor")).toBe("preview-unavailable");
    // The same amendment as the loading reading above: no package half, because
    // the card reached no renderer resolution to report (§V).
    expect(floor(root)?.textContent).toBe(
      'slot "detail" · reason "preview-unavailable"',
    );
    // The decision floor below is untouched and still live.
    expect(root.querySelector('[data-action="approve-review -> resolved"]')).not.toBeNull();
  });
});

describe("never blank", () => {
  it("draws the §V line even when the answer carried no rows at all", async () => {
    const root = await renderOn("site_widget", { headers: null });
    const line = floor(root);
    expect(line, "the floor is never absent").not.toBeNull();
    expect(line!.textContent).toBe('slot "detail" · reason "preview-loading"');
  });

  // REVERSED BY MEASUREMENT (cinatra#3051, third capture). This pin used to read
  // "no row means no header to draw", and the third capture showed what that
  // cost on the real surface: at the card's first render inside a third-party
  // application the island had timed out, the answer carried no rows, and the
  // reader was offered Approve and Reject for twenty seconds over a panel that
  // named nothing. The header is STRUCTURAL now — present in every state the
  // card's own overlay draws — while its facts are still never invented. See
  // `review-gate-card.header-at-first-paint.test.tsx` for the full contract.
  it("still names the panel when the answer carried no headers", async () => {
    const root = await renderOn("site_widget", { headers: null });
    const named = header(root);
    expect(named, "the panel is named even before its facts arrive").not.toBeNull();
    expect(
      named!.getAttribute("data-review-target-header-pending"),
      "and it says openly that they have not",
    ).toBe("");
  });

  // RETIRED BY THE DRAWING (cinatra#3058, fix leg 8). This pin used to read
  // "names a target by its id when the artifact could not be read", and drew a
  // header out of the gate's own ids for a row the reader may not read. §IV
  // fixes the header's facts as "the read-only row facts THE HOST AUTHORIZED",
  // and on a pending reading the host authorizes none for an unknown, tombstoned
  // or read-refused row — that reading floors the target and "shows no title,
  // type, ownership, visibility, MIME or update time for it". A header composed
  // out of ids beside it would be the side door onto a deleted row that the
  // composer exists to close. What the drawing DOES require is that the panel
  // still opens with a header, and that is the factless one below.
  it("names the READING, not the row, when the answer could compose no header", async () => {
    const root = await renderOn("site_widget", { headers: null });
    const text = header(root)?.textContent ?? "";
    expect(text, "the panel is named").toContain("Review target");
    // No fact of a row the host did not authorize, and no absence printed as one.
    expect(text).not.toContain("artifact-1");
    expect(text).not.toContain("pinned");
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
    // §V still holds under it: the line drops only the half it cannot name.
    expect(floor(root)?.getAttribute("data-review-floor-package")).toBe("");
  });
});

describe("a frame that LOADED is not necessarily a frame that PAINTED", () => {
  it("keeps the header, the floor and the retry when the island answers EMPTY", async () => {
    // Every island refusal — a spent or expired address, a reader who may not
    // read the run, a gate that moved — is one empty same-origin document with
    // status 200, and an empty document fires `load`. Before cinatra#3051 that
    // set the frame to "loaded", removed the overlay, and left the reader in
    // front of a blank box with nothing to press.
    const root = await renderOn("site_widget");
    await frameLoads(root, "review-target-island-empty");
    expect(
      root.querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
    ).toBe("timed-out");
    expect(header(root)?.textContent).toContain("Launch post draft");
    expect(floor(root)?.getAttribute("data-review-target-floor")).toBe("preview-unavailable");
    expect(
      root.querySelector('[data-action="retry-review-target-island -> reload"]'),
      "and the retry is still pressable",
    ).not.toBeNull();
    // It says the same sentence for every refusal, so it discloses nothing about
    // which one this was.
    expect(root.textContent).toContain("The preview did not load");
  });

  // REWRITTEN BY THE DRAWING (cinatra#3058, fix leg 8). This pin used to read
  // "the frame carries its own §IV header now; a second copy would be two", and
  // expected the card's reading to disappear once the island painted. The header
  // does not live in the island any more: §IV's header belongs to the target on
  // every reading, and the CARD is the one surface drawn in every island state,
  // so the island document draws none and there is no second copy to avoid.
  // What DOES stand down is the floor — §V.2: "A display and a floor are never
  // drawn for each other", and a painted island is the display.
  it("keeps the header and stands the FLOOR down the moment the island's own BODY arrives", async () => {
    const root = await renderOn("site_widget");
    await frameLoads(root, "review-target-island-body");
    expect(
      root.querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
    ).toBe("loaded");
    expect(reading(root), "the target is still named over its own preview").not.toBeNull();
    expect(header(root)?.textContent).toContain("Launch post draft");
    expect(
      root.querySelectorAll("[data-review-target-header]").length,
      "never nothing, and never both",
    ).toBe(1);
    expect(floor(root), "the floor is not drawn over a display that resolved").toBeNull();
  });

  it("keeps naming the target for a document it does not recognize", async () => {
    // The two ways to be wrong are not symmetric. A framework error page, a
    // response that did not parse, a document this card cannot read at all —
    // none of them is a painted target, and reading one as painted is exactly
    // the blank panel this slice exists to close. So the fallback is "not
    // painted": the header, the floor and the retry stay.
    const root = await renderOn("site_widget");
    const frame = root.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write("<html><body><h1>404</h1></body></html>");
    doc.close();
    await act(async () => {
      fireEvent.load(frame);
    });
    expect(
      root.querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
    ).toBe("timed-out");
    expect(header(root)?.textContent).toContain("Launch post draft");
    expect(floor(root)?.getAttribute("data-review-target-floor")).toBe("preview-unavailable");
    expect(
      root.querySelector('[data-action="retry-review-target-island -> reload"]'),
    ).not.toBeNull();
  });
});

describe("the retry does not re-present a spent address", () => {
  it("keeps the credentialed frame mounted and waits for a fresh one", async () => {
    // A resolve that never re-answers with a NEW address: the second answer
    // repeats the first. If the retry remounted the frame, it would remount on
    // exactly the address whose one grant was already spent.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = await renderOn("site_widget");
    await pastTheBound(root);
    const before = root.querySelector("iframe")!;
    fireEvent.click(
      root.querySelector('[data-action="retry-review-target-island -> reload"]')!,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const after = root.querySelector("iframe")!;
    expect(after, "the frame was not remounted on the spent address").toBe(before);
    expect(after.getAttribute("src")).toBe(before.getAttribute("src"));
  });

  it("still remounts on the COOKIE arm, where the address does not change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = await renderOn("chat_thread");
    await pastTheBound(root);
    const before = root.querySelector("iframe")!;
    fireEvent.click(
      root.querySelector('[data-action="retry-review-target-island -> reload"]')!,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(root.querySelector("iframe")).not.toBe(before);
  });
});
