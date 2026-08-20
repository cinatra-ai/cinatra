// @vitest-environment jsdom
//
// `VerificationSummaryCard` — the ONE §VII renderer (cinatra#2789, epic #2784
// S9e). Design: `specs/app-lifecycle-cards.html` §VII, §IX.
//
// What is pinned here is what a later slice must not be able to weaken by
// accident:
//
//   · EVERY DECLARED HOST draws the SAME core, and only the frame differs — the
//     epic's structural rule, checked as a matrix over the four hosts × the two
//     states the resolver actually issues (`advisory`, `absent`);
//   · `absent` draws NO CARD DOM AT ALL, on every host, and so does a subtree
//     that declared no host — the two absences that keep the card from being an
//     existence oracle;
//   · §VII's own anchors are all present in the one drawing: the Core-analysis
//     chrome, the outcome pill, the revision pins, the authorized scope, the
//     field-by-field before/after with its out-of-scope mark, and the advisory
//     comments;
//   · the card carries NO FLOOR — §VII asks nothing, so it draws nothing to
//     press, on any host;
//   · the COURSE CORRECTION (2026-08-19) holds in the copy: the reading is
//     against what the review AUTHORIZED, and the card never presents a skills
//     list.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type {
  LifecycleCardHost,
  LifecycleCardState,
  VerificationSummaryBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { VerificationSummaryCard } from "../verification-summary-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "verification_summary" as const,
  schemaVersion: 1,
  ref: "ref-verification-1",
};

/** The four declared hosts (§IX). A new host must be added here too. */
const HOSTS: LifecycleCardHost[] = [
  "chat_thread",
  "run_card",
  "page_gate_region",
  "site_widget",
];

/** A non-cookie host must declare a credential, or the provider refuses it. */
const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cit_site" }),
  credentials: "omit" as const,
};

const BODY: VerificationSummaryBody = {
  version: 1,
  outcome: "drifted",
  reviewedRevisionId: "rev-base",
  repairedRevisionId: "rev-repaired",
  // The AUTHORIZATION arrives ON THE ROW (cinatra#2861) — the server decided it
  // against the review's whole scope manifest. `bcc` was not authorized, so
  // that row is out-of-scope drift.
  fieldDiff: [
    { field: "bcc", before: null, after: "legal@evil.test", inScope: false },
    {
      field: "body",
      before: "Old body copy.",
      after: "Fresh re-engagement copy.",
      inScope: true,
    },
    {
      field: "subject",
      before: "Reengage Q3 churned cohort",
      after: "Win back your Q3 favourites",
      inScope: true,
    },
  ],
  advisoryComments: [
    {
      authorKind: "service",
      body: "Core analysis of 3 disclosed field(s). [provenance] lane=core-analysis-lane",
    },
  ],
};

function envelope(state: LifecycleCardState, body: VerificationSummaryBody | null): unknown {
  return { kind: "verification_summary", state, body };
}

function mockResolve(state: LifecycleCardState, body: VerificationSummaryBody | null = BODY) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(envelope(state, body)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderOn(host: LifecycleCardHost) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
    >
      <VerificationSummaryCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

// ---------------------------------------------------------------------------
// The host × state matrix
// ---------------------------------------------------------------------------

describe("one renderer, every host (§IX)", () => {
  for (const host of HOSTS) {
    it(`draws the §VII core on ${host} when the resolve answers advisory`, async () => {
      mockResolve({ state: "advisory" });
      const { container } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
      );
      const root = container.querySelector<HTMLElement>(
        '[data-conformance-id="verification-card"]',
      )!;
      // The SAME component and the SAME state on every host — the host changes
      // the frame and nothing else.
      expect(root.dataset.lifecycleCard).toBe("verification_summary");
      expect(root.dataset.lifecycleCardState).toBe("advisory");
      expect(root.dataset.lifecycleCardHost).toBe(host);
      // Every §VII anchor, on every host.
      expect(root.querySelector('[data-verification-chrome="Core analysis"]')).not.toBeNull();
      expect(root.querySelector("[data-verification-outcome]")).not.toBeNull();
      expect(root.querySelector("[data-verification-revisions]")).not.toBeNull();
      expect(root.querySelector("[data-verification-field-diff]")).not.toBeNull();
      expect(root.querySelector("[data-verification-advisory]")).not.toBeNull();
      // …and NO region §VII does not draw. The plan's binding correction puts
      // the authorization in the copy and the before/after columns, so an
      // "Authorized scope" region is a region outside §VII's closed set.
      expect(root.querySelector("[data-verification-authorized-scope]")).toBeNull();
      expect(root.textContent).not.toContain("Authorized scope");
    });

    it(`draws NO card DOM at all on ${host} when the resolve answers absent`, async () => {
      const fetchMock = mockResolve({ state: "absent" }, null);
      const { container } = renderOn(host);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      // Settle any state update the answer produced before reading the DOM.
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="verification-card"]')).toBeNull(),
      );
      expect(container.querySelector("[data-lifecycle-card]")).toBeNull();
      expect(container.textContent).toBe("");
    });
  }

  it("renders nothing at all with NO host declared — the other absence", async () => {
    const fetchMock = mockResolve({ state: "advisory" });
    const { container } = render(<VerificationSummaryCard view={VIEW} />);
    expect(container.textContent).toBe("");
    // A surface that declared no host issues no resolve either.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders nothing before the first authorized resolve lands", () => {
    // A fetch that never settles: the card must draw no skeleton, no
    // placeholder and no frame in the meantime.
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    expect(container.textContent).toBe("");
  });

  it("gives each host its own FRAME and the SAME drawing inside it", async () => {
    const frames = new Map<LifecycleCardHost, string>();
    const drawings = new Map<LifecycleCardHost, string>();
    for (const host of HOSTS) {
      mockResolve({ state: "advisory" });
      const { container } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
      );
      const root = container.querySelector<HTMLElement>(
        '[data-conformance-id="verification-card"]',
      )!;
      frames.set(host, root.className);
      // Everything INSIDE the frame is the drawing — markup and classes both.
      drawings.set(host, root.innerHTML);
      cleanup();
    }
    // §VII's callout, as a checked property: "the bordered panel is the card
    // treatment for a CONVERSATION … on the run's own review page the same
    // regions sit UNFRAMED in the page column". So the two conversation hosts
    // carry the plate and the turn's vertical rhythm, and the two column hosts
    // carry neither.
    for (const host of ["chat_thread", "site_widget"] as LifecycleCardHost[]) {
      expect(frames.get(host), host).toContain("my-3");
      expect(frames.get(host), host).toContain("border-line");
      expect(frames.get(host), host).toContain("bg-surface-strong");
    }
    for (const host of ["run_card", "page_gate_region"] as LifecycleCardHost[]) {
      expect(frames.get(host), host).not.toContain("my-3");
      expect(frames.get(host), host).not.toContain("border-line");
      expect(frames.get(host), host).not.toContain("bg-surface-strong");
    }
    // …and the DRAWING is byte-identical on all four, which is what makes "one
    // renderer, host-specific frame" a checked property rather than a claim.
    const reference = drawings.get("chat_thread")!;
    for (const host of HOSTS) expect(drawings.get(host)).toBe(reference);
  });
});

// ---------------------------------------------------------------------------
// §VII's drawing
// ---------------------------------------------------------------------------

describe("§VII — the reading", () => {
  it("draws the three outcomes with their own pill and label", async () => {
    const cases = [
      { outcome: "verified" as const, label: "Verified" },
      { outcome: "drifted" as const, label: "Out-of-scope drift" },
      { outcome: "unmet" as const, label: "Findings not met" },
    ];
    for (const c of cases) {
      mockResolve({ state: "advisory" }, { ...BODY, outcome: c.outcome });
      const { container } = renderOn("chat_thread");
      await waitFor(() =>
        expect(container.querySelector("[data-verification-outcome]")).not.toBeNull(),
      );
      const pill = container.querySelector<HTMLElement>("[data-verification-outcome]")!;
      expect(pill.dataset.verificationOutcome).toBe(c.outcome);
      expect(pill.textContent).toContain(c.label);
      cleanup();
    }
  });

  it("pins the two revisions, reviewed then repaired", async () => {
    mockResolve({ state: "advisory" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-verification-revisions]")).not.toBeNull(),
    );
    const pins = container.querySelector<HTMLElement>("[data-verification-revisions]")!;
    expect(pins.textContent).toContain("rev-base");
    expect(pins.textContent).toContain("rev-repaired");
    expect(pins.textContent!.indexOf("rev-base")).toBeLessThan(
      pins.textContent!.indexOf("rev-repaired"),
    );
  });

  it("carries the AUTHORIZATION in the copy and the columns — never as a region of its own", async () => {
    // Plan §8 binding correction, as a property of the DRAWING. §VII names five
    // regions and an authorized-scope list is not one of them, so the manifest
    // is NOT drawn as itself: the card's COPY says what the reading is measured
    // against, and the before/after COLUMNS say it row by row.
    mockResolve({ state: "advisory" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
    );
    expect(container.querySelector("[data-verification-authorized-scope]")).toBeNull();
    expect(container.querySelector("[data-authorized-path]")).toBeNull();
    // The COPY names the authorization…
    expect(container.textContent).toContain("the review never authorized");
    // …and the COLUMNS carry it, per row.
    expect(container.querySelector<HTMLElement>('[data-diff-field="bcc"]')!.dataset.diffInScope)
      .toBe("false");
    // The course correction (2026-08-19), as a property of the DRAWING: nothing
    // on this card presents the agent's skills as the thing verified.
    expect(container.textContent!.toLowerCase()).not.toContain("skill");
  });

  it("takes the in-scope mark from the ROW and never re-derives it", async () => {
    // cinatra#2861: the mark is decided on the server against the WHOLE scope
    // manifest. If this card recomputed it from anything it received, a body
    // whose rows disagree with a naive re-derivation would draw the card's
    // answer instead of the server's — and a false "out of scope" accuses a
    // repair of drift a human had authorized. So the row wins, both ways.
    mockResolve(
      { state: "advisory" },
      {
        ...BODY,
        fieldDiff: [
          { field: "bcc", before: null, after: "legal@evil.test", inScope: true },
          { field: "body", before: "Old.", after: "New.", inScope: false },
        ],
      },
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-verification-field-diff]")).not.toBeNull(),
    );
    const rows = [...container.querySelectorAll<HTMLElement>("[data-diff-field]")];
    expect(rows.map((r) => r.dataset.diffInScope)).toEqual(["true", "false"]);
    expect(rows[0]!.textContent).not.toContain("out of scope");
    expect(rows[1]!.textContent).toContain("out of scope");
  });

  it("draws the field-by-field before/after and marks drift IN PLACE", async () => {
    mockResolve({ state: "advisory" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-verification-field-diff]")).not.toBeNull(),
    );
    const rows = [...container.querySelectorAll<HTMLElement>("[data-diff-field]")];
    expect(rows.map((r) => r.dataset.diffField)).toEqual(["bcc", "body", "subject"]);
    // Only the row outside the authorized scope carries the mark, and it
    // carries it on the row rather than in the result.
    const marks = rows.map((r) => r.dataset.diffInScope);
    expect(marks).toEqual(["false", "true", "true"]);
    const drifted = rows[0]!;
    expect(drifted.textContent).toContain("out of scope");
    expect(rows[1]!.textContent).not.toContain("out of scope");
    // `null` on a side draws the honest em dash, never an empty cell.
    expect(drifted.textContent).toContain("—");
    expect(drifted.textContent).toContain("legal@evil.test");
  });

  it("draws an empty diff as a sentence, not as an empty table", async () => {
    mockResolve({ state: "advisory" }, { ...BODY, fieldDiff: [] });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-verification-field-diff]")).not.toBeNull(),
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("no field-level changes");
  });

  it("draws one panel per advisory comment, author kind above the body", async () => {
    mockResolve({ state: "advisory" });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-advisory-comment]")).not.toBeNull(),
    );
    const panels = [...container.querySelectorAll<HTMLElement>("[data-advisory-comment]")];
    expect(panels).toHaveLength(1);
    expect(panels[0]!.dataset.advisoryAuthorKind).toBe("service");
    expect(panels[0]!.textContent).toContain("service");
    // §VII: the reading's PROVENANCE is the body of a service comment there,
    // not a line of its own — so it must appear inside the panel and nowhere
    // else on the card.
    expect(panels[0]!.textContent).toContain("[provenance] lane=core-analysis-lane");
  });

  it("says an analysis has no advisory comments rather than dropping the section", async () => {
    mockResolve({ state: "advisory" }, { ...BODY, advisoryComments: [] });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-verification-advisory]")).not.toBeNull(),
    );
    expect(container.querySelector("[data-advisory-comment]")).toBeNull();
    expect(container.textContent).toContain("No advisory comments");
  });

  it("says the panel is UNAVAILABLE when the store failed — not that there are none", async () => {
    // The loop's own honesty doctrine (cinatra#2861). `null` is the resolver
    // saying it could not read the comment store; "No advisory comments on this
    // audit" asserts an absence nobody established — and about the one region
    // §VII makes load-bearing, since the reading's provenance lives there. The
    // failure gets its own line, and the rest of the reading is untouched.
    mockResolve({ state: "advisory" }, { ...BODY, advisoryComments: null });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-verification-advisory]")).not.toBeNull(),
    );
    expect(container.querySelector("[data-advisory-unavailable]")).not.toBeNull();
    expect(container.textContent).toContain("Advisory comments unavailable");
    expect(container.textContent).not.toContain("No advisory comments");
    expect(container.querySelector("[data-advisory-comment]")).toBeNull();
    // The card still draws: a store that lost one panel did not un-authorize
    // the verdict or the diff.
    expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull();
    expect(container.querySelector("[data-verification-outcome]")).not.toBeNull();
    expect(container.querySelectorAll("[data-diff-field]")).toHaveLength(3);
  });

  it("renders a comment body as TEXT, never as markup", async () => {
    mockResolve(
      { state: "advisory" },
      {
        ...BODY,
        advisoryComments: [
          { authorKind: "agent", body: "<img src=x onerror=alert(1)>done" },
        ],
      },
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-advisory-comment]")).not.toBeNull(),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>done");
  });

  it("CONTAINS a comment body with no breakable whitespace in it", async () => {
    // A body is arbitrary text and nothing upstream caps its token length: a
    // stack frame, a base64 blob or a signed URL arrives as one unbroken run.
    // `whitespace-pre-wrap` alone would lay that out as a single line and widen
    // the panel past the card, so the body must also carry the wrap rule.
    // jsdom does no layout, so the containment is asserted where it is decided
    // — on the body node's own classes, plus the min-width-0 chain that lets
    // the wrap take effect instead of the flex column growing to fit.
    const unbroken = "x".repeat(4000);
    mockResolve(
      { state: "advisory" },
      { ...BODY, advisoryComments: [{ authorKind: "agent", body: unbroken }] },
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-advisory-comment]")).not.toBeNull(),
    );
    const body = container.querySelector<HTMLElement>("[data-advisory-comment] p")!;
    expect(body.textContent).toBe(unbroken);
    expect(body.className).toContain("whitespace-pre-wrap");
    expect(body.className).toContain("break-words");
    // The card frame and the advisory section both allow their content to
    // shrink; without this the wrap rule would have nothing to wrap against.
    const card = container.querySelector<HTMLElement>(
      '[data-conformance-id="verification-card"]',
    )!;
    expect(card.className).toContain("min-w-0");
    expect(
      container.querySelector<HTMLElement>("[data-verification-advisory]")!.className,
    ).toContain("min-w-0");
  });

  it("carries NO FLOOR at all — it asks nothing, so it draws nothing to press", async () => {
    for (const host of HOSTS) {
      mockResolve({ state: "advisory" });
      const { container } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="verification-card"]')).not.toBeNull(),
      );
      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(container.querySelectorAll("form")).toHaveLength(0);
      expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
      cleanup();
    }
  });

  it("leads with what AUTHORIZED the reading, per the 2026-08-19 correction", async () => {
    mockResolve({ state: "advisory" }, { ...BODY, outcome: "verified" });
    renderOn("chat_thread");
    await waitFor(() => expect(screen.queryByText(/what the review authorized/)).not.toBeNull());
    expect(screen.getByText(/accepted findings and the scope manifest/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

describe("fail-closed", () => {
  it("draws nothing for an answer to a DIFFERENT kind", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ kind: "artifact_review_gate", state: { state: "advisory" }, body: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("draws nothing for an `advisory` that arrives with NO body", async () => {
    const fetchMock = mockResolve({ state: "advisory" }, null);
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("draws nothing for a verdict outside the closed set", async () => {
    const fetchMock = mockResolve(
      { state: "advisory" },
      { ...BODY, outcome: "who-knows" } as unknown as VerificationSummaryBody,
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("draws nothing for a state §VII's card never resolves", async () => {
    // The resolver answers `advisory` or `absent` and nothing else. A `pending`
    // would be a reading asking for a decision it has no floor to take, so the
    // card refuses rather than approximating one.
    for (const state of [
      { state: "pending", canDecide: true, canComment: true },
      { state: "settled" },
      { state: "loading" },
    ] as LifecycleCardState[]) {
      const fetchMock = mockResolve(state);
      const { container } = renderOn("chat_thread");
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("draws nothing when the resolve transport fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { container } = renderOn("chat_thread");
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });
});
