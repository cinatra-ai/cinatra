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
  ReviewTargetRow,
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

/** The gate's own pinned row, exactly as the resolve answers it. */
const ROW: ReviewTargetRow = {
  artifactId: "artifact-1",
  representationRevisionId: "ea615d36-2ad7-4a11-9f0e-8c1b2d3e4f56",
  title: "Launch post draft",
  objectType: "@cinatra-ai/blog-post-artifact:post",
  ownerLevel: "organization",
  visibility: "organization",
  mime: "text/markdown",
  // An INSTANT, as the gate's row carries it — the header reads it as a time.
  updatedAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  packageName: "@cinatra-ai/blog-post-artifact",
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
  targets: readonly ReviewTargetRow[] | null,
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
          ...(targets ? { targets } : {}),
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
    targets?: readonly ReviewTargetRow[] | null;
  } = {},
): Promise<HTMLElement> {
  const widget = host === "site_widget";
  mockResolve(
    options.state ?? PENDING,
    options.targets === undefined ? [ROW] : options.targets,
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
      ).toBe(ROW.representationRevisionId);

      // §V — the one sanitized line, package · slot · reason.
      const line = floor(root);
      expect(line, `${host}: the floor line is drawn`).not.toBeNull();
      expect(line!.getAttribute("data-review-target-floor"), host).toBe("preview-loading");
      expect(line!.getAttribute("data-review-floor-package"), host).toBe(
        "@cinatra-ai/blog-post-artifact",
      );
      expect(line!.getAttribute("data-review-floor-slot"), host).toBe("detail");
      expect(line!.textContent, host).toBe(
        'package "@cinatra-ai/blog-post-artifact" · slot "detail" · reason "preview-loading"',
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
    expect(floor(root)?.textContent).toBe(
      'package "@cinatra-ai/blog-post-artifact" · slot "detail" · reason "preview-unavailable"',
    );
    // The decision floor below is untouched and still live.
    expect(root.querySelector('[data-action="approve-review -> resolved"]')).not.toBeNull();
  });
});

describe("never blank", () => {
  it("draws the §V line even when the answer carried no rows at all", async () => {
    const root = await renderOn("site_widget", { targets: null });
    expect(header(root), "no row means no header to draw").toBeNull();
    const line = floor(root);
    expect(line, "but the floor is never absent").not.toBeNull();
    expect(line!.textContent).toBe('slot "detail" · reason "preview-loading"');
  });

  it("names a target by its id when the artifact could not be read", async () => {
    const root = await renderOn("site_widget", {
      targets: [
        {
          ...ROW,
          title: null,
          objectType: null,
          ownerLevel: null,
          visibility: null,
          mime: null,
          updatedAt: null,
          packageName: null,
        },
      ],
    });
    const text = header(root)?.textContent ?? "";
    expect(text).toContain("artifact-1");
    expect(text).toContain("Artifact");
    expect(text).toContain("pinned");
    // No fact is printed as an absence.
    expect(text).not.toContain("null");
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

  it("stands down the moment the island's own BODY arrives", async () => {
    const root = await renderOn("site_widget");
    await frameLoads(root, "review-target-island-body");
    expect(
      root.querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
    ).toBe("loaded");
    // The frame carries its own §IV header now; a second copy would be two.
    expect(reading(root)).toBeNull();
    expect(header(root)).toBeNull();
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
