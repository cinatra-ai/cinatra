import { expect, test } from "@playwright/test";

import {
  CREDENTIAL_PREFIXES,
  collectEgressEvidence,
  installEgressHarness,
  proveHarnessRecords,
  searchableSurface,
} from "../credential-egress-harness";
import { SEL, loginWordPress, readSeed } from "../helpers";

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) AC-2 — THE INSTRUMENTED BROWSER HARNESS.
//
// "An instrumented browser harness captures every `Window.postMessage` and
// transferred `MessagePort` payload in both directions and proves synthetic
// credential sentinels never appear in those messages, the iframe URL/referrer,
// parent DOM, parent-origin storage, or parent-visible logs."
//
// WHAT THIS SPEC NEEDS, AND WHY IT IS AN OWED AC ON THE CINATRA PR THAT
// INTRODUCES IT. Two things, neither of which the cinatra change set can supply
// on its own:
//
//   1. A BOOTABLE STACK — the docker WordPress at :8080 wired to a running
//      cinatra dev server. The lane that wrote this had no bootable stack on its
//      host, so the spec ships UNRUN and the AC is recorded as owed, with the
//      exact command below.
//   2. THE MIGRATED PLUGIN. Until the WordPress plugin speaks protocol 2, its
//      parent script still composes the retired credential bootstrap. The frame
//      refuses it (that is the protocol-2 version literal doing its job), so the
//      widget never reaches a signed-in state and this spec cannot get as far as
//      the assertion. It therefore runs GREEN only once the linked plugin PR
//      lands — which is exactly the ordering #2674 asks to be recorded.
//
// RUN IT WITH:
//   pnpm exec playwright test -c tests/e2e/config/wp-drupal-uat.config.ts \
//     --project=wordpress credential-egress-uat
//
// (Prerequisites: `cinatra setup dev` + the docker WP stack up, per
// tests/e2e/wp-drupal-uat/README.md. The config boots the cinatra dev server
// itself with the deterministic scripted provider.)
// ---------------------------------------------------------------------------

test.describe("cinatra#2674 — no credential crosses into the parent origin", () => {
  test("every postMessage and MessagePort payload, both directions, is credential-free", async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => consoleLines.push(`pageerror: ${String(err)}`));

    // Install BEFORE any navigation, so no application script can post before
    // the recorder is watching.
    await installEgressHarness(page);

    await loginWordPress(page);
    await page.goto(readSeed().wordpress.editUrl);

    // POSITIVE CONTROL FIRST. A blind recorder makes every assertion below pass,
    // so the harness proves it can see BOTH channels before its silence counts.
    expect(
      await proveHarnessRecords(page),
      "the egress harness did not record its own probe — its silence proves nothing",
    ).toBe(true);

    // Drive the widget through a FULL sign-in and one turn: the credential is
    // acquired by the frame, and the turn is the moment it is used.
    await page.waitForSelector(SEL.root, { state: "attached", timeout: 30_000 });
    await page.waitForSelector(SEL.circle, { state: "visible", timeout: 30_000 });
    await page.click(SEL.circle);
    await page.waitForSelector(SEL.panel, { timeout: 15_000 });

    // The frame owns the sign-in now: the button is INSIDE the Cinatra iframe.
    const frame = page.frameLocator(SEL.frame);
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 30_000 }),
      frame.locator("[data-embed-signin]").click(),
    ]);
    await popup.waitForLoadState("domcontentloaded");
    // The hosted page returns the code to the CINATRA origin and closes itself.
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 30_000 });

    await frame.locator(SEL.embedActive).waitFor({ state: "visible", timeout: 30_000 });
    await frame.locator(SEL.embedComposerInput).fill("Hello");
    await frame.locator(SEL.embedComposerSubmit).click();
    await expect(frame.locator("[data-embed-assistant]")).toHaveAttribute(
      "data-turn-status",
      "finished",
      { timeout: 60_000 },
    );

    const evidence = await collectEgressEvidence(page, consoleLines);
    const surface = searchableSurface(evidence);

    // THE ASSERTION. Nothing Cinatra mints appears anywhere the AC names:
    // recorded messages (window and port, sent and received, both frames), the
    // iframe URL and referrer, the parent DOM, parent-origin storage and
    // cookies, and the console.
    for (const prefix of CREDENTIAL_PREFIXES) {
      expect(surface, `a ${prefix} value reached a parent-visible surface`).not.toContain(
        prefix,
      );
    }

    // …and the recording is not vacuously empty: the bridge really did talk.
    expect(evidence.messages.length).toBeGreaterThan(0);
    expect(evidence.messages.some((m) => m.kind === "message-received")).toBe(true);

    // The retired credential envelope is not merely credential-free — it is not
    // present at all, at any protocol version.
    expect(surface).not.toContain("cinatra.embed.bootstrap");
    expect(surface).not.toContain("citToken");
    expect(surface).not.toContain("cwuToken");
  });
});
