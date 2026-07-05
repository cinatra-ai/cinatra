// @vitest-environment jsdom
/**
 * ExtensionCardIconImage — the §IV ListingCard icon tile's hosted-image link
 * of the fallback chain (icon → vendor logo → kind emblem, cinatra#1003).
 *
 * The tile must never go blank: a resolved URL that is present but fails to
 * LOAD (dead asset, network hiccup) has to degrade to the kind-emblem glyph,
 * not sit there as a broken/invisible image forever. This is the runtime half
 * of the fallback chain the pure `resolveCardIconUrl`/`normalizeCatalogAssetUrl`
 * unit tests can't exercise (those only cover URL *presence*, not load
 * success) — needs jsdom to fire a real `error` event on the `<img>`.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionCardIconImage } from "../extension-card-icon-image";

const Emblem = () => <svg data-testid="kind-emblem" />;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ExtensionCardIconImage", () => {
  it("renders the hosted image by default", () => {
    act(() => {
      root.render(<ExtensionCardIconImage src="https://assets.example/icon.png" emblem={<Emblem />} />);
    });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://assets.example/icon.png");
    expect(container.querySelector('[data-testid="kind-emblem"]')).toBeNull();
  });

  it("degrades to the kind-emblem glyph when the image fails to load — never a blank tile", () => {
    act(() => {
      root.render(<ExtensionCardIconImage src="https://assets.example/dead-link.png" emblem={<Emblem />} />);
    });
    const img = container.querySelector("img")!;
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="kind-emblem"]')).not.toBeNull();
  });
});
