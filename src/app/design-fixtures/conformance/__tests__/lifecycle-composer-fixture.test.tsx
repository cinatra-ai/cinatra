// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation review-composer row
// (cinatra#3159, epic #3155 W3).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e driver. The
// functional-acceptance driver asserts the manifest surfaces in a browser
// against the built app; this asserts what those drivers depend on and what a
// browser run cannot tell you separately — that the harness MOUNT is the shipped
// row, and that every reading it is drawn in is computed by the product rather
// than written by the harness. If the harness ever started naming a reading, a
// control or an outcome itself, this is red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

import { LifecycleComposerFixtures } from "../lifecycle-composer-fixtures";
import {
  LIFECYCLE_CHAT_COMPOSER_MOUNT,
  LIFECYCLE_COMPOSER_ROW_FIXTURES,
  LIFECYCLE_COMPOSER_UNBOUND_GROUP_MOUNT,
  LIFECYCLE_COMPOSER_UNBOUND_GROUP_ROWS,
} from "../lifecycle-composer-fixture-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mountRoot(container: HTMLElement, mount: string): HTMLElement {
  const root = container.querySelector(`[data-surface-id="${mount}"]`);
  expect(root, `the fixture draws its declared mount "${mount}"`).not.toBeNull();
  return root as HTMLElement;
}

function row(container: HTMLElement, mount: string): HTMLElement {
  const found = mountRoot(container, mount).querySelector(
    '[data-conformance-id="review-composer-focus"]',
  );
  expect(found, `mount "${mount}" draws the SHIPPED row`).not.toBeNull();
  return found as HTMLElement;
}

describe("the conformance harness mount for the review-composer row", () => {
  it("mounts the SHIPPED row under every mount the drivers address", () => {
    const { container } = render(<LifecycleComposerFixtures />);
    for (const fixture of LIFECYCLE_COMPOSER_ROW_FIXTURES) {
      const drawn = row(container, fixture.mount);
      // The shipped row's own attributes, which is how the drivers read a
      // reading. The harness writes none of them.
      expect(drawn.getAttribute("data-composer-bound")).not.toBeNull();
      expect(drawn.getAttribute("data-composer-ambiguous")).not.toBeNull();
    }
    // The two unbound readings are drawn INSIDE the group mount the drawing
    // gives its own surface.
    const group = mountRoot(container, LIFECYCLE_COMPOSER_UNBOUND_GROUP_MOUNT);
    for (const mount of LIFECYCLE_COMPOSER_UNBOUND_GROUP_ROWS) {
      expect(group.querySelector(`[data-surface-id="${mount}"]`)).not.toBeNull();
    }
  });

  it("the SHIPPED resolver decides each reading — one open review binds with no press", () => {
    const { container } = render(<LifecycleComposerFixtures />);
    // A single open review and no choice made: §I binds it with no press at all.
    // The harness put nothing into the store for this mount.
    for (const mount of ["composer-row-bound", "composer-row-acting"]) {
      const drawn = row(container, mount);
      expect(drawn.getAttribute("data-composer-bound")).toBe("true");
      expect(
        drawn.querySelector('[data-conformance-id="review-composer-bound"]'),
      ).not.toBeNull();
    }
    // Two open reviews and no choice: nothing routes until one is picked.
    const choosing = row(container, "composer-row-choosing");
    expect(choosing.getAttribute("data-composer-ambiguous")).toBe("true");
    expect(
      choosing.querySelector('[data-conformance-id="review-composer-ambiguous"]'),
    ).not.toBeNull();
    // Two open reviews and the reader chose the OTHER one.
    const elsewhere = row(container, "composer-row-elsewhere");
    expect(elsewhere.getAttribute("data-composer-bound")).toBe("false");
    expect(elsewhere.getAttribute("data-composer-ambiguous")).toBe("false");
    expect(
      elsewhere.querySelector('[data-conformance-id="review-composer-unbound"]'),
    ).not.toBeNull();
  });

  it("the chat box is the SHIPPED primary field, not a look-alike", () => {
    const { container } = render(<LifecycleComposerFixtures />);
    const field = mountRoot(container, LIFECYCLE_CHAT_COMPOSER_MOUNT).querySelector(
      '[data-conformance-id="chat-composer-primary"]',
    );
    expect(field).not.toBeNull();
    // §I's primary input takes the heavier edge; a card's subordinate note field
    // never does. The token is the shipped component's, chosen by its `primary`
    // declaration — the harness passes the declaration, not the class.
    expect(field!.className).toContain("border-line-strong");
  });

  it("the harness names NO reading, NO control and NO outcome", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "lifecycle-composer-fixtures.tsx"),
      "utf8",
    );
    const data = readFileSync(
      path.join(__dirname, "..", "lifecycle-composer-fixture-data.ts"),
      "utf8",
    );
    // Everything the drivers assert is computed by the product. If any of these
    // ever appears as a literal the harness WRITES, the family stops proving the
    // shipped behaviour and starts proving the fixture.
    for (const named of [
      "data-composer-bound",
      "data-composer-ambiguous",
      "release-review-composer",
      "review-composer-bound",
      "review-composer-ambiguous",
      "review-composer-unbound",
      "border-line-strong",
    ]) {
      expect(source, `the harness must not write "${named}"`).not.toContain(
        `"${named}"`,
      );
      expect(data, `the fixture data must not write "${named}"`).not.toContain(
        `"${named}"`,
      );
    }
  });
});
