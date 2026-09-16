// @vitest-environment jsdom
//
// HOST PARITY FOR THE ISLAND'S COLOUR SCHEME (cinatra#2931, epic #2926 W4).
//
// THE RULE. One card, drawn by its renderer, on every host — and the island the
// card frames follows its HOST's colour scheme on every host.
//
// WHAT BROKE IT. The island is a nested document. It cannot see the surface
// around it, and the card never told it anything about the surface, so it
// resolved a palette from its OWN theme state. On a first-party page that state
// lives in the same place the app's theme control writes, so the island came out
// matching the page by coincidence. Inside a third-party application the nested
// document's store is partitioned away from the app's and nothing ever writes
// it: the island fell back to the app's DEFAULT palette and painted a light
// panel inside a dark widget.
//
// WHAT THIS SUITE PINS. Not "the widget is fixed" — that would pass for a
// widget-only patch and leave the next host to rediscover the same hole. It
// walks the PROTOCOL's own host list, so a host added there enters this matrix
// without anybody remembering to add it, and requires the same reading from
// each: the address the card frames names the palette the host document paints.
//
// AND WHAT IT MUST NOT COST. A credentialed island address is a single-use
// bearer. The last describe holds the line the scheme must not cross: a surface
// that repaints may not rewrite an address whose grant has already been spent.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import {
  LIFECYCLE_CARD_HOSTS,
  type LifecycleCardHost,
  type LifecycleCardState,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { colorSchemeOfRoot, LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { REVIEW_TARGET_ISLAND_PATH, ReviewGateCard } from "../review-gate-card";

/** §IX's closed host list, taken from the protocol rather than restated here. */
const HOSTS: readonly LifecycleCardHost[] = LIFECYCLE_CARD_HOSTS;

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-scheme-001" };

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

const WIDGET_FRAME = { assistant: "wordpress", instanceId: "inst-1" };

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };

/** The palette class the app writes on a document root for each scheme. */
const ROOT_CLASS = { light: "cinatra", dark: "dark" } as const;

/** A server-minted island address, as the resolve answers with one. */
const served = (credential: string) =>
  `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(VIEW.ref)}&ic=${credential}`;

/** Answer every resolve the same way. */
function mockResolve(islandSrc: string | null = null): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          ...(islandSrc ? { islandSrc } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

/** Answer each successive resolve with the next island address in the list. */
function mockResolveSequence(islandSrcs: Array<string | null>): void {
  let call = 0;
  globalThis.fetch = vi.fn(async () => {
    const islandSrc = islandSrcs[Math.min(call, islandSrcs.length - 1)];
    call += 1;
    return new Response(
      JSON.stringify({
        kind: "artifact_review_gate",
        state: PENDING,
        body: null,
        ...(islandSrc ? { islandSrc } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

/** Let the resolve settle without crossing the island's own load timeout. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Paint the HOST DOCUMENT in a scheme, exactly as the app does: the palette is
 * a class on the document root. This is the whole of the host's declaration —
 * the test never touches the card, the island, or any prop.
 */
function paintHost(scheme: "light" | "dark" | "none"): void {
  document.documentElement.className = scheme === "none" ? "" : ROOT_CLASS[scheme];
}

function mountCard(host: LifecycleCardHost) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
      frame={host === "site_widget" ? WIDGET_FRAME : undefined}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

const srcIn = (container: HTMLElement): string => {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("no island frame");
  return frame.getAttribute("src") ?? "";
};

/** The address the card frames the island at, on one host. */
async function islandSrcOn(host: LifecycleCardHost): Promise<string> {
  mockResolve();
  const { container } = mountCard(host);
  await settle();
  const src = srcIn(container);
  cleanup();
  return src;
}

const paramOf = (src: string, key: string): string | null =>
  new URL(src, "https://app.example").searchParams.get(key);

const schemeOf = (src: string): string | null => paramOf(src, "scheme");

afterEach(() => {
  cleanup();
  paintHost("none");
  vi.restoreAllMocks();
});

describe("the island is addressed in the palette its HOST is painting", () => {
  it("names DARK on every host whose document is dark — the widget included", async () => {
    paintHost("dark");
    for (const host of HOSTS) {
      expect(schemeOf(await islandSrcOn(host)), `dark island scheme on ${host}`).toBe("dark");
    }
  });

  it("names LIGHT on every host whose document is light — the widget's light stays light", async () => {
    paintHost("light");
    for (const host of HOSTS) {
      expect(schemeOf(await islandSrcOn(host)), `light island scheme on ${host}`).toBe("light");
    }
  });

  it("gives the SAME answer on every host — no host is a special case", async () => {
    for (const painted of ["light", "dark"] as const) {
      paintHost(painted);
      const answers = new Set<string | null>();
      for (const host of HOSTS) answers.add(schemeOf(await islandSrcOn(host)));
      expect(answers, `one answer for a ${painted} document`).toEqual(new Set([painted]));
    }
  });

  it("walks EVERY host the protocol declares", () => {
    expect(HOSTS).toContain("chat_thread");
    expect(HOSTS).toContain("site_widget");
    expect(HOSTS).toContain("run_card");
    expect(HOSTS).toContain("page_gate_region");
    expect(new Set(HOSTS).size).toBe(HOSTS.length);
  });

  it("keeps the ref, the credential seam and the frame selectors beside it", async () => {
    paintHost("dark");
    const url = new URL(await islandSrcOn("site_widget"), "https://app.example");
    expect(url.searchParams.get("ref")).toBe(VIEW.ref);
    expect(url.searchParams.get("assistant")).toBe(WIDGET_FRAME.assistant);
    expect(url.searchParams.get("instanceId")).toBe(WIDGET_FRAME.instanceId);
    expect(url.searchParams.get("scheme")).toBe("dark");
  });

  it("names NOTHING when the host document declares no palette — the island keeps its own", async () => {
    paintHost("none");
    for (const host of HOSTS) {
      expect(schemeOf(await islandSrcOn(host)), `unpainted host ${host}`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The line the scheme must not cross
// ---------------------------------------------------------------------------
//
// A credentialed island address is spent the moment the frame paints from it,
// and the frame's identity IS that address string. So a repaint may not rewrite
// a spent address: the reader would get a blank island instead of a repainted
// one. A cookie-authenticated island has nothing to spend and repaints freely.

describe("a repaint never replays a spent island grant", () => {
  it("repaints a COOKIE-authenticated island in place", async () => {
    mockResolve();
    paintHost("light");
    const { container } = mountCard("chat_thread");
    await settle();
    expect(schemeOf(srcIn(container))).toBe("light");

    await act(async () => {
      paintHost("dark");
    });
    await settle();
    expect(schemeOf(srcIn(container))).toBe("dark");
  });

  it("holds a CREDENTIALED island's address until a fresh grant arrives", async () => {
    mockResolveSequence([served("grant-one"), served("grant-two")]);
    paintHost("light");
    const { container } = mountCard("site_widget");
    await settle();
    const first = srcIn(container);
    expect(paramOf(first, "ic")).toBe("grant-one");
    expect(schemeOf(first)).toBe("light");

    // EVERY address the frame is ever given, not just the one it settles on.
    // The defect this guards is a TRANSIENT: one committed render on a rewritten
    // spent address is enough to navigate the frame and blank the island, and a
    // sample taken after the re-resolve has landed would not see it. The
    // observer watches the subtree because a new address remounts the element.
    const seen: string[] = [first];
    const record = () => {
      const src = container.querySelector("iframe")?.getAttribute("src") ?? null;
      if (src && src !== seen[seen.length - 1]) seen.push(src);
    };
    const observer = new MutationObserver(record);
    observer.observe(container, {
      attributes: true,
      attributeFilter: ["src"],
      subtree: true,
      childList: true,
    });

    // The surface repaints. No address the frame is handed may pair the SPENT
    // grant with the new palette.
    await act(async () => {
      paintHost("dark");
    });
    await settle();
    await settle();
    record();
    observer.disconnect();

    const replayed = seen.filter(
      (src) => paramOf(src, "ic") === "grant-one" && schemeOf(src) === "dark",
    );
    expect(replayed, `spent grant replayed in a new palette: ${seen.join(" | ")}`).toEqual([]);

    // And the island DOES end up in the host's palette — on the grant the
    // re-resolve minted, never on the one the first paint consumed.
    const settled = seen[seen.length - 1];
    expect(paramOf(settled, "ic")).toBe("grant-two");
    expect(schemeOf(settled)).toBe("dark");
  });

  it("keeps the address whole when a later answer carries no grant at all", async () => {
    // The mint can fail while the gate is perfectly pending, so an answer may
    // legitimately arrive without an island address. Composing from that answer
    // would hand the frame an UNCREDENTIALED src — a different string, so a
    // remount, so a blank island: the same failure a spent grant causes, by
    // another road. The held address stands instead.
    mockResolveSequence([served("grant-one"), null]);
    paintHost("light");
    const { container } = mountCard("site_widget");
    await settle();
    const first = srcIn(container);
    expect(paramOf(first, "ic")).toBe("grant-one");

    const seen: string[] = [first];
    const record = () => {
      const src = container.querySelector("iframe")?.getAttribute("src") ?? null;
      if (src && src !== seen[seen.length - 1]) seen.push(src);
    };
    const observer = new MutationObserver(record);
    observer.observe(container, {
      attributes: true,
      attributeFilter: ["src"],
      subtree: true,
      childList: true,
    });

    // A repaint asks for a fresh address; the answer carries none.
    await act(async () => {
      paintHost("dark");
    });
    await settle();
    await settle();
    record();
    observer.disconnect();

    // Nothing the frame was handed lost the grant, and nothing replayed it in a
    // new palette. The island stays painted as it is.
    for (const src of seen) {
      expect(paramOf(src, "ic"), `an address lost its grant: ${seen.join(" | ")}`).toBe("grant-one");
    }
    expect(seen[seen.length - 1]).toBe(first);
  });

  it("asks again for the next palette after an answer that brought no grant", async () => {
    mockResolveSequence([served("grant-one"), null, served("grant-three")]);
    paintHost("light");
    const { container } = mountCard("site_widget");
    await settle();
    expect(paramOf(srcIn(container), "ic")).toBe("grant-one");

    // First repaint — the answer brings nothing, so the island holds.
    await act(async () => {
      paintHost("dark");
    });
    await settle();
    await settle();
    expect(paramOf(srcIn(container), "ic")).toBe("grant-one");
    expect(schemeOf(srcIn(container))).toBe("light");

    // The reader picks another palette: the card asks again rather than staying
    // latched on the answer that failed.
    await act(async () => {
      paintHost("light");
    });
    await act(async () => {
      paintHost("dark");
    });
    await settle();
    await settle();
    const settled = srcIn(container);
    expect(paramOf(settled, "ic")).toBe("grant-three");
    expect(schemeOf(settled)).toBe("dark");
  });
});

describe("the palette read itself", () => {
  it("reads the class the app writes, and nothing else", () => {
    const root = (className: string) => {
      const el = document.createElement("div");
      el.className = className;
      return el;
    };
    expect(colorSchemeOfRoot(root("dark"))).toBe("dark");
    expect(colorSchemeOfRoot(root("cinatra"))).toBe("light");
    expect(colorSchemeOfRoot(root("cinatra some-other-class"))).toBe("light");
    expect(colorSchemeOfRoot(root(""))).toBeNull();
    expect(colorSchemeOfRoot(root("theme-dark darkish"))).toBeNull();
    expect(colorSchemeOfRoot(null)).toBeNull();
  });
});
