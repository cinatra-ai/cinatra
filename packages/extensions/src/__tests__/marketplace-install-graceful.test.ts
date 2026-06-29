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

describe("wiring — the marketplace screen renders the graceful form, not the crashing plain form", () => {
  const wrapperSrc = read("marketplace-install-form.tsx");
  const screenSrc = read("extensions-marketplace-screen.tsx");

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
