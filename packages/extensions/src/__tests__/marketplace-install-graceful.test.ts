// Regression: marketplace install must NOT crash the page on a failed install (#356).
//
// Before the fix, the marketplace Install/Update/Restore CTAs were rendered as
// plain server-action `<form action={boundAction}>`. The bound action
// (installExtensionPackageFormAction) re-throws on a failed install, and there
// is no error.tsx boundary for /configuration/marketplace, so the throw
// surfaced as a full-page Next.js Runtime Error — reproduced with a Verdaccio
// 404 ("no such package available") for @cinatra-ai/* packages, but identical
// for ANY failed install (registry unreachable, lifecycle error).
//
// The fix wraps each CTA in MarketplaceInstallForm — a "use client" wrapper
// whose handleSubmit awaits the action inside try/catch, re-throws Next.js's
// redirect() sentinel (so a SUCCESSFUL install still navigates), and surfaces a
// friendly toast on a genuine failure instead of crashing the route.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isRedirectError } from "../screens/is-redirect-error";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "../screens/marketplace-failure-copy";

const SCREENS = path.resolve(__dirname, "..", "screens");
const read = (rel: string) => readFileSync(path.join(SCREENS, rel), "utf8");

describe("isRedirectError — distinguishes redirect() sentinel from a real failure", () => {
  it("returns true for a NEXT_REDIRECT-shaped sentinel (the success path)", () => {
    expect(isRedirectError({ digest: "NEXT_REDIRECT;replace;/configuration/extensions;307;" })).toBe(
      true,
    );
  });

  it("returns false for a genuine install failure (404 / unreachable / lifecycle error)", () => {
    expect(
      isRedirectError(
        new Error(
          "404 Not Found - GET http://127.0.0.1:4873/@cinatra-ai%2flinkedin-oauth-connector - no such package available",
        ),
      ),
    ).toBe(false);
    expect(isRedirectError(undefined)).toBe(false);
    expect(isRedirectError(null)).toBe(false);
    expect(isRedirectError({ digest: 42 })).toBe(false);
    expect(isRedirectError({ digest: "NEXT_NOT_FOUND" })).toBe(false);
  });
});

describe("graceful submit contract — failure toasts, success re-throws (no page crash)", () => {
  // Mirrors MarketplaceInstallForm.handleSubmit exactly (post-#685): the action
  // RETURNS `{ ok:false, category }` on a classified failure (a returned value
  // survives Next prod masking where a thrown message would not), and may still
  // THROW for an unexpected failure. Both surface a friendly toast (no re-throw →
  // no unhandled server-action exception → no page crash); a redirect() sentinel
  // is re-thrown so Next.js navigates.
  type FailureResult = { ok: false; category: string };
  async function handleSubmit(
    action: () => Promise<FailureResult | void>,
    onFailure: (msg: string) => void,
    failureCopyByCategory: Record<string, string>,
    defaultFailureMessage: string,
  ): Promise<void> {
    try {
      const result = await action();
      if (result && result.ok === false) {
        onFailure(failureCopyByCategory[result.category] ?? defaultFailureMessage);
      }
    } catch (error) {
      if (isRedirectError(error)) throw error;
      onFailure(defaultFailureMessage);
    }
  }

  const COPY = {
    "denied-entitlement": "Foo isn't available to install on your workspace.",
    unrecoverable: "Could not install Foo.",
  } as Record<string, string>;

  it("does NOT throw and DOES toast the classified copy when the install fails (the #356 crash is gone)", async () => {
    const onFailure = vi.fn();
    // Post-#685: a failed install RETURNS a classified category, it does not throw.
    const failing = vi.fn(async () => ({ ok: false as const, category: "denied-entitlement" }));

    await expect(
      handleSubmit(failing, onFailure, COPY, "Could not install Foo."),
    ).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      "Foo isn't available to install on your workspace.",
    );
  });

  it("falls back to the default copy when the action unexpectedly THROWS", async () => {
    const onFailure = vi.fn();
    const throwing = vi.fn(async (): Promise<FailureResult | void> => {
      throw new Error("404 Not Found - no such package available");
    });

    await expect(
      handleSubmit(throwing, onFailure, COPY, "Could not install Foo."),
    ).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("Could not install Foo.");
  });

  it("re-throws the redirect() sentinel on success and does NOT toast", async () => {
    const onFailure = vi.fn();
    const redirecting = vi.fn(async (): Promise<FailureResult | void> => {
      throw { digest: "NEXT_REDIRECT;replace;/configuration/extensions;307;" };
    });

    await expect(
      handleSubmit(redirecting, onFailure, COPY, "Could not install Foo."),
    ).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(onFailure).not.toHaveBeenCalled();
  });
});

// cinatra#2333 — the NO-CATEGORY paths. `defaultFailureMessage` is what renders
// when the action THROWS (no category exists) and when a returned category is
// not in the map. Both resolve to the `unrecoverable` copy, so they must carry
// the same no-retry-claim guarantee as the classified path — proven here with
// the REAL copy functions rather than a stand-in literal.
describe("#2333 — the no-category fallbacks render the real escalation copy", () => {
  const NAME = "Acme Widget";
  const REAL_COPY = buildMarketplaceFailureCopy("install", NAME);
  const REAL_DEFAULT = marketplaceFailureCopy("unrecoverable", "install", NAME);

  async function handleSubmit(
    action: () => Promise<{ ok: false; category: string } | void>,
    onFailure: (msg: string) => void,
  ): Promise<void> {
    try {
      const result = await action();
      if (result && result.ok === false) {
        onFailure(
          (REAL_COPY as Record<string, string>)[result.category] ?? REAL_DEFAULT,
        );
      }
    } catch (error) {
      if (isRedirectError(error)) throw error;
      onFailure(REAL_DEFAULT);
    }
  }

  it("an unexpected THROW (no category at all) renders the escalation copy, not retry advice", async () => {
    const onFailure = vi.fn();
    await expect(
      handleSubmit(async () => {
        throw new Error("401 Unauthorized - Unable to authenticate, need: Basic, Bearer");
      }, onFailure),
    ).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      "Couldn't install Acme Widget. Contact your administrator for help.",
    );
  });

  it("a returned category MISSING from the map falls back to the same escalation copy", async () => {
    const onFailure = vi.fn();
    await expect(
      handleSubmit(async () => ({ ok: false as const, category: "a-category-we-do-not-map" }), onFailure),
    ).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      "Couldn't install Acme Widget. Contact your administrator for help.",
    );
  });

  // The mirrors above reproduce handleSubmit's expression; these pin that each
  // consumer's THROWN-failure branch really does render the `defaultFailureMessage`
  // it was handed, and never a string of its own. Same source-contract pattern as
  // the wrapper assertions below (this package's vitest env is "node", so RTL
  // rendering is unavailable here — see vitest.config.ts).
  it("every consumer's thrown-failure branch renders the handed-down default", () => {
    expect(read("marketplace-install-form.tsx")).toContain("toast.error(defaultFailureMessage)");
    // cinatra#2374: the scoped popup was deleted; the in-card install panel is
    // the scoped surface now, and its thrown-failure branch reports the same
    // handed-down default (toast + the hidden role="alert" mirror).
    expect(read("extension-install-scope-panel.tsx")).toContain(
      "reportFailure(defaultFailureMessage)",
    );
    const updatePlan = read("update-plan-flow.tsx");
    expect(updatePlan).toContain("toast.error(defaultFailureMessage)");
    expect(updatePlan).toContain("setFailureCopy(defaultFailureMessage)");
  });
});

describe("wiring — the marketplace screen renders the graceful form, not the crashing plain form", () => {
  const wrapperSrc = read("marketplace-install-form.tsx");
  // cinatra#2539 split the per-card composition out of the screen (verbatim
  // move); the CTA wiring asserted below lives in that half.
  const screenSrc =
    read("extensions-marketplace-screen.tsx") + "\n" + read("marketplace-card-nodes.tsx");

  it("the wrapper is a client component that re-throws the redirect sentinel and toasts otherwise", () => {
    expect(wrapperSrc).toMatch(/^"use client";/);
    expect(wrapperSrc).toMatch(/isRedirectError\(error\)\) throw error/);
    // Post-#685 the wrapper toasts category-classified copy (or the default).
    expect(wrapperSrc).toMatch(/toast\.error\(/);
    expect(wrapperSrc).toMatch(/failureCopyByCategory\[result\.category\]/);
  });

  it("the screen routes Install/Update/Restore through MarketplaceInstallForm", () => {
    expect(screenSrc).toMatch(/MarketplaceInstallForm/);
    // Defends against regressing to the crashing plain `<form action={installAction}>`.
    expect(screenSrc).not.toMatch(/<form action=\{installAction\}/);
    expect(screenSrc).not.toMatch(/<form action=\{updateAction\}/);
    expect(screenSrc).not.toMatch(/<form action=\{restoreAction\}/);
  });
});
