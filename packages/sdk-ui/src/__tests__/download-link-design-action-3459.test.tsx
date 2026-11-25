// @vitest-environment jsdom
//
// THE FLOOR'S DOWNLOAD CONTROL, AS THE DESIGN DRAWS IT (cinatra#3459).
// specs/app-lifecycle-cards.html and specs/app-artifact-review.html draw
// "Download PDF" as `<button type="button" class="btn outline"
// data-action="download-artifact -> file-downloaded">`: a real button that the
// keyboard reaches and presses. The address and the file-name hint stay the
// host's: pressing it downloads the same href the anchor did.
//
// red-first-expect: expected null not to be null

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DownloadLink } from "../ui/download-link";

const HREF = "/api/artifacts/a-1/download?revision=3";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function draw() {
  const clicked: Array<{ href: string; download: string | null }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute("href") ?? "", download: this.getAttribute("download") });
  });
  const { container } = render(<DownloadLink href={HREF}>Download PDF</DownloadLink>);
  const control = container.querySelector('[data-action="download-artifact -> file-downloaded"]');
  return { container, control, clicked };
}

describe("the download control", () => {
  it("is a real button carrying the design's exact action anchor", () => {
    const { container, control } = draw();
    expect(control).not.toBeNull();
    expect(control?.tagName).toBe("BUTTON");
    expect(control?.getAttribute("type")).toBe("button");
    expect(control?.textContent).toContain("Download PDF");
    expect(container.querySelector("a")).toBeNull();
    expect(control?.hasAttribute("disabled")).toBe(false);
    expect(control?.getAttribute("tabindex")).toBeNull();
  });

  it("downloads the host's address when pressed", () => {
    const { control, clicked } = draw();
    fireEvent.click(control as Element);
    expect(clicked).toEqual([{ href: HREF, download: "" }]);
  });

  it("is reached by the keyboard: focusable, in the tab order, never a div with a role", () => {
    const { control } = draw();
    // A native button takes focus and is pressed by Enter and Space in every
    // browser (the click fires from the key); nothing here may take it out of
    // that road with a tabindex, a disabled flag or a non-button element.
    (control as HTMLElement).focus();
    expect(document.activeElement).toBe(control);
    expect((control as HTMLButtonElement).tabIndex).toBe(0);
    expect(control?.hasAttribute("role")).toBe(false);
    expect(control?.getAttribute("aria-hidden")).toBeNull();
  });
});
