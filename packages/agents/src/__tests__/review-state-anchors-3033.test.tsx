// @vitest-environment jsdom
/**
 * THE REVIEW READINGS' DESIGN ANCHORS (cinatra#3033).
 *
 * `app-artifact-review.html` §I.3 draws the run page's review step in two
 * readings, `run-review-step-post` and `run-review-step-picture`, and
 * `app-lifecycle-cards.html` §II.1 draws the featured image's card in the chat
 * thread, `review-card-post-with-featured-image`. The drawing tells the two
 * readings apart by the TARGET: the post is drawn by the markdown display, the
 * picture by the image display, and on the picture the note field opens
 * carrying the prompt that made it. The card reads the one pinned target's form
 * from the resolve answer (`targetForm`) and the prompt beside it, and names no
 * artifact type.
 *
 * Each test mounts the REAL `ReviewGateCard` under a real host declaration and
 * answers its resolve with real target identities (the header the answer
 * carries, and the target's form), then counts every anchor: the right one
 * exactly once and the others never.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/review-state-anchors-3033.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  LifecycleCardState,
  LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// The run page draws the prompt window under the card; its real field pulls
// browser-only dependencies jsdom cannot load, and no anchor is read from it.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: () => null,
}));

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard, reviewStateAnchor } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-3033",
};

const PROMPT = "A long road over layered ground, cool light, no text.";

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const RESTRICTED: LifecycleCardState = {
  state: "restricted",
  canDecide: false,
  canComment: true,
  reason: "Another reviewer owns this gate.",
};

/** The post, as the resolve answer names it: its header and its form. */
const POST: { header: LifecycleTargetHeader; form: string } = {
  header: {
    title: "Pick a stack you can upgrade",
    typeLabel: "Blog Post",
    objectType: "@cinatra-ai/blog-post-artifact:post",
    revisionId: "rev-post-3033",
    facts: ["organization", "text/markdown", "updated 2 min ago"],
  },
  form: "text/markdown",
};

/** The featured image, as the resolve answer names it. */
const PICTURE: { header: LifecycleTargetHeader; form: string } = {
  header: {
    title: "Featured image",
    typeLabel: "Image",
    objectType: "@cinatra-ai/image-artifact:image",
    revisionId: "rev-picture-3033",
    facts: ["organization", "image/png", "updated 1 min ago"],
  },
  form: "image/png",
};

const ANCHORS = [
  "run-review-step-post",
  "run-review-step-picture",
  "review-card-post-with-featured-image",
] as const;
type Anchor = (typeof ANCHORS)[number];

type Answer = {
  state: LifecycleCardState;
  headers?: LifecycleTargetHeader[];
  form?: string;
  recordedPrompt?: string;
};

function envelope(answer: Answer): Record<string, unknown> {
  return {
    kind: "artifact_review_gate",
    state: answer.state,
    body: null,
    ...(answer.headers ? { targetHeaders: answer.headers, targetHeadersComplete: true } : {}),
    ...(answer.form === undefined ? {} : { targetForm: answer.form }),
    ...(answer.recordedPrompt === undefined ? {} : { recordedPrompt: answer.recordedPrompt }),
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResolve(answer: Answer): void {
  globalThis.fetch = vi.fn(async () => json(envelope(answer))) as unknown as typeof fetch;
}

function counts(root: ParentNode): Record<Anchor, number> {
  return Object.fromEntries(
    ANCHORS.map((id) => [id, root.querySelectorAll(`[data-conformance-id="${id}"]`).length]),
  ) as Record<Anchor, number>;
}

function only(anchor: Anchor | null): Record<Anchor, number> {
  return Object.fromEntries(ANCHORS.map((id) => [id, id === anchor ? 1 : 0])) as Record<
    Anchor,
    number
  >;
}

async function mountedFloor(container: HTMLElement): Promise<void> {
  // The floor is drawn once the resolve answer has arrived.
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
  );
}

function runPage(): React.ReactElement {
  return (
    <LifecycleCardSurfaceProvider host="run_card">
      <ReviewGateCard view={VIEW} runId="run-3033" />
    </LifecycleCardSurfaceProvider>
  );
}

describe("the run page's review step carries the reading its target draws", () => {
  it("the post's review is the post's reading", async () => {
    mockResolve({ state: PENDING, headers: [POST.header], form: POST.form });
    const { container } = render(runPage());
    // red-first-expect: expected { 'run-review-step-post': +0, …(2) } to deeply equal { 'run-review-step-post': 1
    await waitFor(() => expect(counts(container)).toEqual(only("run-review-step-post")));
    // The anchor is drawn inside the card, not around it.
    const card = container.querySelector('[data-conformance-id="review-gate-card"]');
    expect(card?.querySelector('[data-conformance-id="run-review-step-post"]')).not.toBeNull();
  });

  it("the featured image's review, with the prompt that made it, is the picture's reading", async () => {
    mockResolve({ state: PENDING, headers: [PICTURE.header], form: PICTURE.form, recordedPrompt: PROMPT });
    const { container } = render(runPage());
    // red-first-expect: to deeply equal { 'run-review-step-post': +0, …(2) }
    await waitFor(() => expect(counts(container)).toEqual(only("run-review-step-picture")));
    // The same trait the drawing names: the note opens with the prompt.
    const note = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="review-rationale"]');
    expect(note?.value).toBe(PROMPT);
  });

  it("a restricted reader sees the same reading", async () => {
    mockResolve({ state: RESTRICTED, headers: [PICTURE.header], form: PICTURE.form, recordedPrompt: PROMPT });
    const { container } = render(runPage());
    // red-first-expect: to deeply equal { 'run-review-step-post': +0, …(2) }
    await waitFor(() => expect(counts(container)).toEqual(only("run-review-step-picture")));
  });

  it("a gate over the post AND its picture claims neither reading", async () => {
    mockResolve({ state: PENDING, headers: [POST.header, PICTURE.header] });
    const { container } = render(runPage());
    await mountedFloor(container);
    expect(counts(container)).toEqual(only(null));
  });

  it("a target that is neither a post nor a picture claims no reading", async () => {
    mockResolve({
      state: PENDING,
      headers: [{ ...POST.header, typeLabel: "Document", objectType: "@cinatra-ai/pdf-artifact:document" }],
      form: "application/pdf",
    });
    const { container } = render(runPage());
    await mountedFloor(container);
    expect(counts(container)).toEqual(only(null));
  });

  it("a picture with no recorded prompt claims no reading", async () => {
    mockResolve({ state: PENDING, headers: [PICTURE.header], form: PICTURE.form });
    const { container } = render(runPage());
    await mountedFloor(container);
    expect(counts(container)).toEqual(only(null));
  });

  it("an answer that names no form claims no reading", async () => {
    mockResolve({ state: PENDING, headers: [POST.header] });
    const { container } = render(runPage());
    await mountedFloor(container);
    expect(counts(container)).toEqual(only(null));
  });
});

describe("the chat thread carries the featured image's card", () => {
  it("the picture's card carries the anchor", async () => {
    mockResolve({ state: PENDING, headers: [PICTURE.header], form: PICTURE.form, recordedPrompt: PROMPT });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: to deeply equal { 'run-review-step-post': +0, …(2) }
    await waitFor(() =>
      expect(counts(container)).toEqual(only("review-card-post-with-featured-image")),
    );
  });

  it("the inline run panel inside the thread is still the thread", async () => {
    mockResolve({ state: PENDING, headers: [PICTURE.header], form: PICTURE.form, recordedPrompt: PROMPT });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSurfaceProvider host="run_card">
          <ReviewGateCard view={VIEW} runId="run-3033" />
        </LifecycleCardSurfaceProvider>
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: to deeply equal { 'run-review-step-post': +0, …(2) }
    await waitFor(() =>
      expect(counts(container)).toEqual(only("review-card-post-with-featured-image")),
    );
  });

  it("the post's card in the thread carries no anchor of a reading", async () => {
    mockResolve({ state: PENDING, headers: [POST.header], form: POST.form });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await mountedFloor(container);
    expect(counts(container)).toEqual(only(null));
  });
});

describe("no reading is claimed where the card cannot tell", () => {
  for (const host of ["page_gate_region", "site_widget"] as const) {
    it(`${host}: neither reading is drawn`, async () => {
      mockResolve({ state: PENDING, headers: [PICTURE.header], form: PICTURE.form, recordedPrompt: PROMPT });
      const { container } = render(
        <LifecycleCardSurfaceProvider
          host={host}
          auth={
            host === "site_widget"
              ? { headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }), credentials: "omit" }
              : undefined
          }
        >
          <ReviewGateCard view={VIEW} runId="run-3033" />
        </LifecycleCardSurfaceProvider>,
      );
      await mountedFloor(container);
      expect(counts(container)).toEqual(only(null));
    });
  }

  it("while the resolve answer is loading, neither run page reading is drawn", async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const { container } = render(runPage());
    // The resolve was asked and has not answered; the card holds no reading.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts(container)).toEqual(only(null));
  });

  it("a settled gate claims no reading", async () => {
    mockResolve({ state: { state: "settled", outcome: "approved" }, headers: [POST.header] });
    const { container } = render(runPage());
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull(),
    );
    expect(counts(container)).toEqual(only(null));
  });
});

describe("a gate that settles keeps the preview it painted", () => {
  it("Continue removes the reading and keeps the same island frame", async () => {
    let resolves = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/decide") && init?.method === "POST") {
        return json({ outcome: { kind: "decided", disposition: "approve", idempotent: false } });
      }
      // The first answer is the pending post; the re-resolve after the decision
      // never answers, so the card draws the decision it landed.
      return ++resolves === 1
        ? json(envelope({ state: PENDING, headers: [POST.header], form: POST.form }))
        : new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const { container } = render(runPage());
    await mountedFloor(container);
    // red-first-expect: expected null not to be null
    expect(container.querySelector('[data-conformance-id="run-review-step-post"]')).not.toBeNull();
    const framePending = container.querySelector("iframe");
    expect(framePending).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-gate-settled"]')).not.toBeNull(),
    );
    expect(counts(container)).toEqual(only(null));
    // The SAME node, not a new frame at the same address: a remount would load
    // the preview again and lose its height and scroll.
    expect(container.querySelector("iframe")).toBe(framePending);
  });
});

describe("reviewStateAnchor — the rule", () => {
  const post = {
    host: "run_card" as const,
    insideConversation: false,
    state: "pending" as const,
    targetCount: 1,
    targetForm: "text/markdown",
    recordedPrompt: null,
  };
  const picture = { ...post, targetForm: "image/png", recordedPrompt: PROMPT };

  it("decides each reading from the place and the one target's form", () => {
    // red-first-expect: reviewStateAnchor is not a function
    expect(reviewStateAnchor(post)).toBe("run-review-step-post");
    expect(reviewStateAnchor(picture)).toBe("run-review-step-picture");
    expect(reviewStateAnchor({ ...post, state: "restricted" })).toBe("run-review-step-post");
    expect(reviewStateAnchor({ ...picture, host: "chat_thread", insideConversation: true })).toBe(
      "review-card-post-with-featured-image",
    );
    expect(reviewStateAnchor({ ...post, host: "chat_thread", insideConversation: true })).toBeNull();
    expect(reviewStateAnchor({ ...picture, host: "page_gate_region" })).toBeNull();
    expect(reviewStateAnchor({ ...picture, host: "site_widget" })).toBeNull();
    expect(reviewStateAnchor({ ...picture, host: null })).toBeNull();
  });

  it("claims nothing it cannot read off one known target", () => {
    // red-first-expect: reviewStateAnchor is not a function
    // Several targets, or none named: no reading, whatever the rest says.
    for (const targetCount of [0, 2, 12]) {
      expect(reviewStateAnchor({ ...post, targetCount })).toBeNull();
      expect(reviewStateAnchor({ ...picture, targetCount })).toBeNull();
    }
    // No form, or a form neither display draws as these readings.
    expect(reviewStateAnchor({ ...post, targetForm: null })).toBeNull();
    for (const targetForm of ["application/pdf", "text/html", "text/plain", "video/mp4"]) {
      expect(reviewStateAnchor({ ...post, targetForm })).toBeNull();
      expect(reviewStateAnchor({ ...picture, targetForm })).toBeNull();
    }
    // A picture without its prompt, and a post that carries one.
    expect(reviewStateAnchor({ ...picture, recordedPrompt: null })).toBeNull();
    expect(reviewStateAnchor({ ...picture, recordedPrompt: "  " })).toBeNull();
    expect(reviewStateAnchor({ ...post, recordedPrompt: PROMPT })).toBeNull();
  });

  it("claims nothing outside the states whose answer can carry the target", () => {
    // red-first-expect: reviewStateAnchor is not a function
    for (const state of ["loading", "settled", "advisory", "absent"] as const) {
      expect(reviewStateAnchor({ ...post, state })).toBeNull();
      expect(reviewStateAnchor({ ...picture, state })).toBeNull();
    }
  });
});
