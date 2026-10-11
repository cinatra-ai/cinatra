// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IslandHeightReporter } from "../island-height-reporter";
import { islandBodyClassName } from "../island-color-scheme";
import { parseReviewIslandPalette } from "../island-palette-message";

const message = (scheme: unknown) => ({ type: "cinatra.review-island.palette", scheme });
const originalParent = Object.getOwnPropertyDescriptor(window, "parent")!;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "parent", originalParent);
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  document.documentElement.style.removeProperty("color-scheme");
});

describe("the island palette message is a fixed shape with one closed enum", () => {
  it.each(["light", "dark"])("accepts %s", (scheme) => {
    expect(parseReviewIslandPalette(message(scheme))).toBe(scheme);
  });

  it.each([
    null, undefined, "dark", [],
    { scheme: "dark" },
    { type: "other", scheme: "dark" },
    { type: "cinatra.review-island.palette" },
    message(null), message("system"), message("DARK"), message(1),
    { ...message("dark"), content: "not a palette" },
  ])("rejects malformed or widened messages: %j", (value) => {
    expect(parseReviewIslandPalette(value)).toBeNull();
  });
});

function framedIsland() {
  const parent = document.createElement("iframe");
  document.body.appendChild(parent);
  const source = parent.contentWindow!;
  Object.defineProperty(window, "parent", { configurable: true, value: source });
  const mounted = render(
    <div className={islandBodyClassName("light")} data-island-color-scheme="light" style={{ colorScheme: "light" }}>
      <p data-testid="work">The existing review target</p>
      <IslandHeightReporter />
    </div>,
  );
  const wrapper = mounted.container.firstElementChild as HTMLElement;
  const send = (data: unknown, origin = window.location.origin, sender: Window | null = source) => {
    act(() => window.dispatchEvent(new MessageEvent("message", { data, origin, source: sender })));
  };
  return { ...mounted, wrapper, send };
}

describe("the already drawn island follows only its own parent", () => {
  it("updates all four palette readings immediately, without replacing the work", () => {
    const { wrapper, send } = framedIsland();
    const work = wrapper.querySelector("[data-testid='work']");
    send(message("dark"));
    expect(wrapper.classList.contains("dark")).toBe(true);
    expect(wrapper.classList.contains("cinatra")).toBe(false);
    expect(wrapper.classList.contains("overflow-x-auto")).toBe(true);
    expect(wrapper.dataset.islandColorScheme).toBe("dark");
    expect(wrapper.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(wrapper.querySelector("[data-testid='work']")).toBe(work);
    expect(work?.textContent).toBe("The existing review target");

    send(message("light"));
    expect(wrapper.classList.contains("cinatra")).toBe(true);
    expect(wrapper.classList.contains("dark")).toBe(false);
    expect(wrapper.dataset.islandColorScheme).toBe("light");
    expect(wrapper.style.colorScheme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("ignores a foreign origin, unrelated window, missing source and malformed message", () => {
    const { wrapper, send } = framedIsland();
    const original = wrapper.outerHTML;
    send(message("dark"), "https://unrelated.example");
    send(message("dark"), window.location.origin, window);
    send(message("dark"), window.location.origin, null);
    send(message("system"));
    send({ ...message("dark"), content: "unexpected" });
    expect(wrapper.outerHTML).toBe(original);
    expect(document.documentElement.style.colorScheme).toBe("");
  });

  it("removes the listener when the reporter unmounts", () => {
    const { wrapper, send, unmount } = framedIsland();
    unmount();
    send(message("dark"));
    expect(wrapper.dataset.islandColorScheme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("");
  });
});
