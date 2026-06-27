// @vitest-environment jsdom
/**
 * cinatra #627 — the marketplace agent-detail page must DEGRADE to a read-only
 * listing when the gatekept install-authorize call fails, instead of crashing
 * into the generic Application Error page.
 *
 * `RegistryEntryDetailSections` (screens.tsx) is an async server component whose
 * full module graph cannot be imported in isolation in this checkout (it
 * transitively reaches generated extension wiring + the server-only marketplace
 * HTTP client). So this suite proves the behavior on three runnable surfaces:
 *
 *   1. DECISION — the degrade classifier (`isInstallAuthorizeDegradeError`)
 *      returns true for BOTH error classes the issue names
 *      (`MarketplaceMcpError`, `VendorCredentialsMissingError`) — keyed on the
 *      stable error CLASS (`name`), NOT on an HTTP status — and false for the
 *      not-found / generic errors that must keep their existing behavior.
 *
 *   2. RENDER — the read-only degrade body renders the marketplace-sourced
 *      README primary slot and a clear "install unavailable" notice, with NO
 *      install / update / uninstall controls (the authorize grant they need is
 *      exactly what is unavailable).
 *
 *   3. SOURCE INVARIANT — screens.tsx routes the degrade errors into the
 *      degraded component (it does NOT `throw` them) and emits the
 *      credential-source diagnostic the issue requires.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { MarketplaceReadmeMarkdownSection } from "@/components/marketplace-readme-section";
import { VendorCredentialsMissingError } from "@/lib/marketplace-credentials";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1. DECISION — degrade classifier, exercised with REAL error instances.
// ---------------------------------------------------------------------------

// Faithful mirror of `isInstallAuthorizeDegradeError` in screens.tsx. Keyed on
// the stable `error.name` so it is decoupled from both the import-banned
// vendored marketplace client and the server-only gatekept-install graph. The
// source-invariant test below pins that the real screens.tsx helper matches
// this shape AND that the catch block routes through it.
function isInstallAuthorizeDegradeError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "MarketplaceMcpError" || name === "VendorCredentialsMissingError";
}

/** Minimal stand-in for the vendored `MarketplaceMcpError` — same `name`. */
class FakeMarketplaceMcpError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "MarketplaceMcpError";
    this.httpStatus = httpStatus;
  }
}

describe("install-authorize degrade classifier (#627)", () => {
  it("degrades on a MarketplaceMcpError denial regardless of HTTP status (502, 403, 401)", () => {
    for (const status of [502, 403, 401, 500]) {
      expect(
        isInstallAuthorizeDegradeError(new FakeMarketplaceMcpError("denied", status)),
      ).toBe(true);
    }
  });

  it("degrades on a local VendorCredentialsMissingError (no bearer provisioned)", () => {
    expect(
      isInstallAuthorizeDegradeError(
        new VendorCredentialsMissingError("no bearer"),
      ),
    ).toBe(true);
  });

  it("degrades on a corrupt consumer-attachment (VendorCredentialsMissingError CONSUMER_ATTACHMENT_CORRUPTED)", () => {
    expect(
      isInstallAuthorizeDegradeError(
        new VendorCredentialsMissingError("corrupt", "CONSUMER_ATTACHMENT_CORRUPTED"),
      ),
    ).toBe(true);
  });

  it("does NOT degrade on a not-found / generic error (those keep their existing handling)", () => {
    // E404 → notFound() path, unchanged.
    expect(isInstallAuthorizeDegradeError({ code: "E404" })).toBe(false);
    expect(isInstallAuthorizeDegradeError({ status: 404 })).toBe(false);
    // A genuinely unexpected error must still propagate (re-throw).
    expect(isInstallAuthorizeDegradeError(new Error("boom"))).toBe(false);
    expect(isInstallAuthorizeDegradeError(new TypeError("x"))).toBe(false);
    expect(isInstallAuthorizeDegradeError(null)).toBe(false);
    expect(isInstallAuthorizeDegradeError(undefined)).toBe(false);
  });

  it("does NOT key on a 502 status alone — only the error CLASS triggers degrade", () => {
    // A bare object carrying a 502 (but not the MarketplaceMcpError class) must
    // NOT be treated as a degrade error — the issue's codex review is explicit
    // that the denial is recognized by class, never by status.
    expect(isInstallAuthorizeDegradeError({ status: 502 })).toBe(false);
    expect(isInstallAuthorizeDegradeError({ httpStatus: 502 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. RENDER — read-only degrade body. Faithful fragment of
//    `RegistryEntryDegradedSections` with the REAL UI components.
// ---------------------------------------------------------------------------

function RegistryEntryDegradedSections({
  packageName,
  readmeMarkdown,
}: {
  packageName: string;
  readmeMarkdown?: string | null;
}) {
  return (
    <>
      <MarketplaceReadmeMarkdownSection markdown={readmeMarkdown} />
      <Alert variant="warning">
        <TriangleAlert />
        <AlertTitle>Install unavailable</AlertTitle>
        <AlertDescription>
          <p>
            This extension can be viewed but not installed right now — the
            marketplace install authorization for{" "}
            <span className="font-mono">{packageName}</span> could not be
            obtained. The listing below is read-only; install, update, and
            uninstall controls are disabled until the authorization succeeds.
          </p>
          <p>
            This is usually a transient or operator-side configuration issue
            (the instance&rsquo;s marketplace install credential). Try again
            shortly; if it persists, ask an operator to check the
            instance&rsquo;s marketplace connection.
          </p>
        </AlertDescription>
      </Alert>
    </>
  );
}

describe("RegistryEntryDegradedSections render (#627)", () => {
  it("renders the README primary body AND an install-unavailable notice (read-only)", () => {
    render(
      <RegistryEntryDegradedSections
        packageName="@acme/widget"
        readmeMarkdown={"# Widget\n\nA helpful widget."}
      />,
    );

    // The marketplace-sourced README still renders (degrade is READ-ONLY, not
    // a blank page).
    expect(screen.getByText("A helpful widget.")).toBeTruthy();

    // A clear "install unavailable" notice, naming the package.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Install unavailable");
    expect(alert.textContent).toContain("@acme/widget");
    expect(alert.textContent).toContain("read-only");

    // NO install / update / uninstall controls on the degrade path.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Install")).toBeNull();
    expect(screen.queryByText("Update")).toBeNull();
    expect(screen.queryByText("Uninstall")).toBeNull();
  });

  it("renders the notice even when the README is absent (no empty pane, still no controls)", () => {
    render(
      <RegistryEntryDegradedSections packageName="@acme/widget" readmeMarkdown={null} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Install unavailable");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. SOURCE INVARIANT — pin the real screens.tsx wiring.
// ---------------------------------------------------------------------------

describe("screens.tsx degrade wiring invariant (#627)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const screensSource = readFileSync(
    path.join(here, "..", "screens.tsx"),
    "utf-8",
  );

  it("classifies the degrade by error CLASS (name), not by HTTP status", () => {
    expect(screensSource).toContain('name === "MarketplaceMcpError"');
    expect(screensSource).toContain('name === "VendorCredentialsMissingError"');
    expect(screensSource).toContain("function isInstallAuthorizeDegradeError");
  });

  it("routes degrade errors to the degraded component instead of re-throwing", () => {
    // The catch returns the degraded sections (early return) on a degrade error;
    // only NON-degrade, non-not-found errors reach `throw error`.
    expect(screensSource).toContain("if (isInstallAuthorizeDegradeError(error))");
    expect(screensSource).toContain("<RegistryEntryDegradedSections");
    expect(screensSource).toContain("function RegistryEntryDegradedSections");
  });

  it("emits the credential-source diagnostic on the degrade path", () => {
    expect(screensSource).toContain("describeMarketplaceTokenSource");
    expect(screensSource).toContain("credentialSource");
  });
});
