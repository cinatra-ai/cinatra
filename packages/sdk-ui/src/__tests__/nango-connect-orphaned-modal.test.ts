/**
 * Nango Connect UI orphaned-modal contract (#48).
 *
 * Source-text contract test: this repo's component tests use source-file
 * assertions because @testing-library/react is not available from the root
 * package.json (vitest env is "node").
 *
 * `openConnectUI()` mounts a full-viewport iframe (skeleton loaders, body
 * scroll locked) BEFORE a session token exists. Both connect surfaces must
 * close that iframe on every failure path, or the modal spins forever on its
 * skeletons and hides the error (#48):
 *
 *   1. POST /api/nango/connect/session fails (the issue's repro) — the outer
 *      catch must close the Connect UI before reporting the error.
 *   2. POST /api/nango/connections/save fails post-OAuth — the `connect`
 *      onEvent branch. @nangohq/frontend invokes onEvent as `void onEvent(e)`,
 *      so a throw there is an unhandled rejection, not a surfaced error; the
 *      failure must be caught, the modal closed, and the error reported.
 *
 * NangoUserConnectButton must additionally surface the error itself when the
 * caller passes no `onError` — no production call site passes one, so without
 * the fallback the user gets zero feedback even after the modal closes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as ButtonMod from "../nango-user-connect-button";
import * as CardMod from "../nango-managed-api-card";

const BUTTON_SOURCE = readFileSync(
  fileURLToPath(new URL("../nango-user-connect-button.tsx", import.meta.url)),
  "utf-8",
);
const CARD_SOURCE = readFileSync(
  fileURLToPath(new URL("../nango-managed-api-card.tsx", import.meta.url)),
  "utf-8",
);

describe("module load", () => {
  it("exports the connect surfaces", () => {
    expect(typeof ButtonMod.NangoUserConnectButton).toBe("function");
    expect(typeof ButtonMod.NangoUserConnectCard).toBe("function");
    expect(typeof CardMod.NangoManagedApiCard).toBe("function");
  });
});

describe("NangoUserConnectButton / useNangoUserConnect (#48)", () => {
  it("hoists the ConnectUI handle so catch blocks can close the modal", () => {
    expect(BUTTON_SOURCE).toMatch(/let connect: ConnectUI \| undefined;/);
    expect(BUTTON_SOURCE).toMatch(/connect = nangoFrontend\.openConnectUI\(\{/);
  });

  it("closes the orphaned Connect UI when /api/nango/connect/session fails", () => {
    // Outer catch: close → clear pending → report.
    expect(BUTTON_SOURCE).toMatch(
      /catch \(error\) \{[^{}]*connect\?\.close\(\);[^{}]*setPending\(false\);[^{}]*"Unable to open the connection flow\."\);/,
    );
  });

  it("catches /api/nango/connections/save failures inside onEvent (void-invoked) and closes the modal", () => {
    expect(BUTTON_SOURCE).toMatch(
      /catch \(error\) \{[^{}]*connect\?\.close\(\);[^{}]*setPending\(false\);[^{}]*"Unable to save the connection\."\);/,
    );
    // Success path + save-failure path + session-failure path all close.
    expect(BUTTON_SOURCE.match(/connect\?\.close\(\);/g)?.length).toBe(3);
  });

  it("surfaces errors itself when the caller passes no onError (no call site does)", () => {
    expect(BUTTON_SOURCE).toMatch(
      /onError: onError \?\? \(\(message\) => setFallbackError\(message \|\| null\)\)/,
    );
    expect(BUTTON_SOURCE).toMatch(/if \(onError\) \{\s*return button;\s*\}/);
    expect(BUTTON_SOURCE).toMatch(
      /\{fallbackError \? <p className="text-sm text-destructive">\{fallbackError\}<\/p> : null\}/,
    );
  });
});

describe("NangoManagedApiCard (#48)", () => {
  it("hoists the ConnectUI handle and guards close with connectUiClosed", () => {
    expect(CARD_SOURCE).toMatch(/let connect: ConnectUI \| undefined;/);
    expect(CARD_SOURCE).toMatch(
      /const closeConnectUi = \(\) => \{\s*if \(!connectUiClosed\) \{\s*connect\?\.close\(\);\s*connectUiClosed = true;\s*\}\s*\};/,
    );
  });

  it("closes the orphaned Connect UI when /api/nango/connect/session fails", () => {
    expect(CARD_SOURCE).toMatch(
      /catch \(error\) \{[^{}]*closeConnectUi\(\);[^{}]*setPending\(false\);[^{}]*"Unable to open the connection flow\."\);/,
    );
  });

  it("catches /api/nango/connections/save failures inside onEvent (void-invoked) and closes the modal", () => {
    expect(CARD_SOURCE).toMatch(
      /catch \(error\) \{[^{}]*closeConnectUi\(\);[^{}]*setPending\(false\);[^{}]*"Unable to save the connection\."\);/,
    );
  });
});
