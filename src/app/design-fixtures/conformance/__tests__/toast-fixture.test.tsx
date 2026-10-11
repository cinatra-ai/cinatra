// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "@/lib/cinatra-toast";
import { ToastConformanceFixture } from "../toast-fixture";
import { CONFORMANCE_TOAST_MESSAGE } from "../toast-fixture-data";

const writeText = vi.fn().mockResolvedValue(undefined);
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "cinatra" }) }));

beforeEach(() => {
  writeText.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.unstubAllGlobals();
});

function mountToast() {
  render(<><Toaster richColors /><ToastConformanceFixture /></>);
  fireEvent.click(screen.getByRole("button", { name: "Show conformance toast" }));
}

it("renders the canonical message in the real library toast and its Copy reaches the clipboard boundary", async () => {
  mountToast();
  await screen.findByText(CONFORMANCE_TOAST_MESSAGE);
  const copy = await screen.findByRole("button", { name: "Copy" });
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(CONFORMANCE_TOAST_MESSAGE));
});

it("uses the library's own accessible Close control and dismisses the actual toast", async () => {
  mountToast();
  await screen.findByText(CONFORMANCE_TOAST_MESSAGE);
  fireEvent.click(await screen.findByRole("button", { name: "Close toast" }));
  await waitFor(() => expect(screen.queryByText(CONFORMANCE_TOAST_MESSAGE)).toBeNull());
  expect(writeText).not.toHaveBeenCalled();
});
