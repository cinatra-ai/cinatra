// @vitest-environment jsdom
// The harness raises the default toast for the independent grade (cinatra#4291):
// no product page raises an untyped toast, so a grade could not otherwise see the
// drawn muted circled alert or the ink border. Read here in a real Toaster: the
// button raises one untyped toast that keeps the wrapper's glyph and its Close.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "@/lib/cinatra-toast";
import { Toaster } from "@/components/ui/sonner";
import { ToastConformanceFixture } from "../toast-fixture";
import { CONFORMANCE_DEFAULT_TOAST_MESSAGE } from "../toast-fixture-data";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "cinatra" }) }));

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("the conformance harness's default toast", () => {
  it("raises an untyped toast with the default glyph and a Close", async () => {
    render(
      <>
        <Toaster />
        <ToastConformanceFixture />
      </>,
    );
    fireEvent.click(screen.getByTestId("show-conformance-default-toast"));
    const text = await screen.findByText(CONFORMANCE_DEFAULT_TOAST_MESSAGE);
    const root = text.closest("[data-sonner-toast]") as HTMLElement;
    // The library sets no data-type on an untyped toast.
    expect(root.getAttribute("data-type")).toBeNull();
    await waitFor(() => expect(root.querySelector(":scope > [data-icon]")).not.toBeNull());
    expect(root.querySelector(":scope > [data-icon] svg")?.getAttribute("class")).toBe("text-muted-foreground");
    expect(root.querySelector('button[aria-label="Close toast"]')).not.toBeNull();
  });

  it("keeps the typed button the conformance driver presses", () => {
    render(<ToastConformanceFixture />);
    expect(screen.getByTestId("show-conformance-toast")).toBeTruthy();
  });
});
