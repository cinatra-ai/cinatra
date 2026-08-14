// @vitest-environment jsdom
//
// cinatra#2534 — the tunnel field's Tailscale flyout told EVERY operator with
// no Funnel URL preview the same thing:
//
//   "tailnet not resolved yet — reconnect the Tailscale connector to refresh."
//
// That is true for one cause only. On a plain local install the real cause is
// an unsanctioned dev identity, and reconnecting the connector cannot change
// it — so the operator was sent down a dead end while an externally reachable
// URL (typically a Funnel already running on the host) was one paste away.
//
// The reason codes cannot be produced end-to-end here (they need a live
// Tailscale install and a specific database/schema identity), so the
// MESSAGE-SELECTION seam is pinned exhaustively instead — every branch, plus
// the two properties that carry the defect:
//
//   · only the no-tailnet branch may recommend reconnecting;
//   · every no-preview branch must offer the paste remediation.
//
// The rendered flyout is asserted separately so the copy cannot regress to a
// hardcoded sentence again.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEV_MAIN_DECLARATION_VAR,
  DEV_MAIN_ENDPOINT_PLACEHOLDER,
  FUNNEL_PREVIEW_IDENTITY_CONFLICT,
  FUNNEL_PREVIEW_NO_TAILNET,
  FUNNEL_PREVIEW_UNREGISTERED_IDENTITY,
  selectFunnelPreviewNotice,
  type FunnelPreviewNoticeState,
} from "../funnel-preview-notice";

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../actions", () => ({
  setMcpPublicBaseUrlAction: vi.fn(),
}));

import { PublicBaseUrlForm } from "../public-base-url-form";

const NO_PREVIEW_REASONS: Array<[string | null, FunnelPreviewNoticeState]> = [
  [FUNNEL_PREVIEW_NO_TAILNET, "no-tailnet"],
  [FUNNEL_PREVIEW_UNREGISTERED_IDENTITY, "unregistered-identity"],
  [FUNNEL_PREVIEW_IDENTITY_CONFLICT, "identity-conflict"],
  [null, "unknown"],
  ["tailscale.some_code_this_host_does_not_know_yet", "unknown"],
];

describe("selectFunnelPreviewNotice (#2534)", () => {
  it("says nothing when a preview exists — the flyout offers the pick instead", () => {
    expect(
      selectFunnelPreviewNotice({
        funnelUrlPreview: "https://cinatra-main.tail8a34f1.ts.net",
        reason: null,
      }),
    ).toBeNull();
    // a stale reason alongside a live preview must not resurrect a notice
    expect(
      selectFunnelPreviewNotice({
        funnelUrlPreview: "https://cinatra-main.tail8a34f1.ts.net",
        reason: FUNNEL_PREVIEW_UNREGISTERED_IDENTITY,
      }),
    ).toBeNull();
  });

  it.each(NO_PREVIEW_REASONS)("maps reason %s to the %s state", (reason, state) => {
    const notice = selectFunnelPreviewNotice({ funnelUrlPreview: null, reason });
    expect(notice?.state).toBe(state);
    expect(notice?.message.length).toBeGreaterThan(0);
  });

  it("recommends reconnecting ONLY when reconnecting can help", () => {
    for (const [reason, state] of NO_PREVIEW_REASONS) {
      const notice = selectFunnelPreviewNotice({ funnelUrlPreview: null, reason });
      const mentionsReconnect = /reconnect/i.test(notice!.message);
      if (state === "no-tailnet") {
        expect(notice!.reconnectHelps).toBe(true);
        expect(mentionsReconnect).toBe(true);
      } else {
        expect(notice!.reconnectHelps).toBe(false);
        // it may still MENTION reconnecting — but only to say it won't help
        if (mentionsReconnect) {
          expect(notice!.message).toMatch(/not change that|does not help/i);
        }
      }
    }
  });

  it("offers the paste remediation on every branch where reconnecting cannot help", () => {
    // Deliberately NOT the no-tailnet branch: there the auto-derived URL is
    // about to exist and reconnecting is the real remedy, so sending the
    // operator to paste a URL would be the wrong advice. Everywhere else the
    // paste path is the one that works today — including an unrecognised
    // future code, which lands in the same fallback.
    const cases = NO_PREVIEW_REASONS.filter(([, state]) => state !== "no-tailnet");
    expect(cases.length).toBe(NO_PREVIEW_REASONS.length - 1);
    for (const [reason] of cases) {
      const notice = selectFunnelPreviewNotice({ funnelUrlPreview: null, reason });
      expect(notice!.message).toMatch(/paste an externally reachable https url/i);
      // the already-running host Funnel the picker never offers
      expect(notice!.message).toMatch(/already run on this host/i);
    }
  });

  it("never claims the tailnet is unresolved unless that is the reported reason", () => {
    for (const [reason, state] of NO_PREVIEW_REASONS) {
      if (state === "no-tailnet") continue;
      const notice = selectFunnelPreviewNotice({ funnelUrlPreview: null, reason });
      expect(notice!.message).not.toMatch(/tailnet not resolved/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The unregistered branch used to offer ONE remediation — "run this instance
// as a clone or a worktree" — which describes the MULTI-instance case. A plain
// single canonical install classifies `unregistered` too, and for it the fix
// is the explicit declaration the connector already computes one layer down.
// These pin both branches, and pin that the jargon is explained.
// ---------------------------------------------------------------------------
describe("the unregistered-identity remediation", () => {
  const unregistered = (mainDatabaseEndpoint?: string | null) =>
    selectFunnelPreviewNotice({
      funnelUrlPreview: null,
      reason: FUNNEL_PREVIEW_UNREGISTERED_IDENTITY,
      mainDatabaseEndpoint,
    })!;

  it("names the declaration that fixes a canonical main install", () => {
    const { message } = unregistered();
    expect(message).toContain(DEV_MAIN_DECLARATION_VAR);
    // the VARIABLE alone is not the remediation — the assignment is
    expect(message).toContain(`${DEV_MAIN_DECLARATION_VAR}=`);
    // and it must say where the line goes, or the operator cannot act on it
    expect(message).toMatch(/\.env\.local/);
  });

  it("renders the value format when no endpoint is reported", () => {
    expect(unregistered().message).toContain(
      `${DEV_MAIN_DECLARATION_VAR}=${DEV_MAIN_ENDPOINT_PLACEHOLDER}`,
    );
    // an empty/blank report is the same as none — never an empty assignment
    expect(unregistered(null).message).toContain(DEV_MAIN_ENDPOINT_PLACEHOLDER);
    expect(unregistered("   ").message).toContain(DEV_MAIN_ENDPOINT_PLACEHOLDER);
  });

  it("renders the resolved endpoint when one IS reported", () => {
    const { message } = unregistered("127.0.0.1:5434/postgres");
    expect(message).toContain(`${DEV_MAIN_DECLARATION_VAR}=127.0.0.1:5434/postgres`);
    expect(message).not.toContain(DEV_MAIN_ENDPOINT_PLACEHOLDER);
  });

  it("explains 'sanctioned Tailscale identity' instead of assuming the term", () => {
    const { message } = unregistered();
    expect(message).toMatch(/no sanctioned Tailscale identity/i);
    // the three identities that ARE sanctioned, named where the term is used
    expect(message).toMatch(/registered clone/i);
    expect(message).toMatch(/worktree/i);
    expect(message).toMatch(/dev main/i);
  });

  it("keeps the clone/worktree advice, but as the multi-instance branch", () => {
    const { message } = unregistered();
    expect(message).toMatch(/clone or a worktree/i);
    // it is no longer offered as the ONLY remedy — it is conditioned on the
    // situation it actually fits
    expect(message).toMatch(/several instances/i);
  });

  it("leaves the other branches' remediation untouched", () => {
    // The declaration belongs to the unregistered branch only. The conflict
    // branch's instance already HAS signals; telling it to add another would
    // deepen the conflict it is being asked to resolve.
    const conflict = selectFunnelPreviewNotice({
      funnelUrlPreview: null,
      reason: FUNNEL_PREVIEW_IDENTITY_CONFLICT,
    })!;
    expect(conflict.message).not.toContain(`${DEV_MAIN_DECLARATION_VAR}=`);
    expect(conflict.message).toMatch(/exactly one of clone, worktree or main/i);

    const noTailnet = selectFunnelPreviewNotice({
      funnelUrlPreview: null,
      reason: FUNNEL_PREVIEW_NO_TAILNET,
    })!;
    expect(noTailnet.message).not.toContain(DEV_MAIN_DECLARATION_VAR);
  });

  it("still does not recommend reconnecting as the remedy", () => {
    const notice = unregistered("127.0.0.1:5434/postgres");
    expect(notice.reconnectHelps).toBe(false);
    expect(notice.message).toMatch(/will not change that/i);
  });
});

describe("PublicBaseUrlForm flyout copy (#2534)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const mounted: Root[] = [];

  afterEach(() => {
    for (const root of mounted.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
  });

  /**
   * Mount the form for real and OPEN the flyout the way a user does — the
   * flyout only exists after the field takes focus, so a static render would
   * assert nothing about the notice at all.
   */
  function openFlyout(props: {
    tailscaleUrl: string | null;
    tailscaleUrlReason?: string | null;
  }): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => {
      root.render(
        <PublicBaseUrlForm
          initialUrl=""
          tailscaleConnected
          tailscaleUrl={props.tailscaleUrl}
          tailscaleUrlReason={props.tailscaleUrlReason ?? null}
        />,
      );
    });
    const input = host.querySelector<HTMLInputElement>("#publicBaseUrl");
    if (!input) throw new Error("public base URL field did not render");
    act(() => input.focus());
    return host;
  }

  it("renders the matching notice for each no-preview reason", () => {
    for (const [reason, state] of NO_PREVIEW_REASONS) {
      const host = openFlyout({ tailscaleUrl: null, tailscaleUrlReason: reason });
      const notice = host.querySelector("[data-funnel-preview-state]");
      expect(notice).not.toBeNull();
      expect(notice!.getAttribute("data-funnel-preview-state")).toBe(state);
      expect(notice!.textContent).toContain(
        selectFunnelPreviewNotice({ funnelUrlPreview: null, reason })!.message,
      );
    }
  });

  it("no longer paints the blanket 'tailnet not resolved — reconnect' sentence", () => {
    const host = openFlyout({
      tailscaleUrl: null,
      tailscaleUrlReason: FUNNEL_PREVIEW_UNREGISTERED_IDENTITY,
    });
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/tailnet not resolved yet/i);
    expect(text).toMatch(/no sanctioned Tailscale identity/i);
    expect(text).toMatch(/will not change that/i);
  });

  it("puts the declaration remediation in front of the operator", () => {
    // The seam is only worth changing if the sentence actually reaches the
    // flyout the operator opens.
    const host = openFlyout({
      tailscaleUrl: null,
      tailscaleUrlReason: FUNNEL_PREVIEW_UNREGISTERED_IDENTITY,
    });
    const text = host.textContent ?? "";
    expect(text).toContain(`${DEV_MAIN_DECLARATION_VAR}=${DEV_MAIN_ENDPOINT_PLACEHOLDER}`);
    expect(text).toMatch(/\.env\.local/);
    expect(text).toMatch(/several instances/i);
  });

  it("offers the pickable URL — and no notice — when a preview exists", () => {
    const host = openFlyout({ tailscaleUrl: "https://cinatra-main.tail8a34f1.ts.net" });
    expect(host.querySelector("[data-funnel-preview-state]")).toBeNull();
    expect(host.textContent).toContain("https://cinatra-main.tail8a34f1.ts.net");
  });

  it("no longer promises a pickable URL when there is no preview", () => {
    const html = renderToStaticMarkup(
      <PublicBaseUrlForm initialUrl="" tailscaleConnected tailscaleUrl={null} />,
    );
    expect(html).not.toMatch(/Click the field to pick the Tailscale Funnel URL/);
    const withPreview = renderToStaticMarkup(
      <PublicBaseUrlForm
        initialUrl=""
        tailscaleConnected
        tailscaleUrl="https://cinatra-main.tail8a34f1.ts.net"
      />,
    );
    expect(withPreview).toMatch(/Click the field to pick the Tailscale Funnel URL/);
  });
});
