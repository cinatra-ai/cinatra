// @vitest-environment jsdom
//
// Integration coverage for `<DcModalA11yScope>`'s uniform ESC-to-close
// (cinatra#438), exercised against the REAL drizzle-cube
// `DashboardProvider` store — not a mock. The bug: DC's "Add text" modal
// (`TextPortletModal`) hand-rolls its overlay with no ESC handler, so ESC
// closed "Add portlet" but not "Add text". The fix binds ONE document
// Escape handler at this seam that routes through the store's close
// actions, so EVERY modal closes on ESC.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/dc-modal-a11y-scope.integration.test.tsx

import "./jsdom-shims";
import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  DashboardProvider,
  useDashboardStoreApi,
} from "drizzle-cube/client";

import { DcModalA11yScope } from "../dc-modal-a11y-scope";

// The raw store API type, derived from the hook's return so we don't take
// a direct `zustand` dependency (it's only a transitive dep here).
type DashboardStoreApi = ReturnType<typeof useDashboardStoreApi>;

afterEach(cleanup);

// A drizzle-cube DashboardProvider needs a config; an empty dashboard is
// enough — we drive the modal flags directly through the store actions.
const EMPTY_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as React.ComponentProps<typeof DashboardProvider>["config"];

/**
 * Captures the per-instance store API so the test can flip modal flags
 * via the real store actions and read them back. Rendered INSIDE the
 * provider (same constraint as `DcModalA11yScope`: the store lives there).
 */
function CaptureStoreApi({
  onApi,
}: {
  onApi: (api: DashboardStoreApi) => void;
}) {
  const api = useDashboardStoreApi();
  onApi(api);
  return null;
}

function renderScope(extraChild?: React.ReactNode) {
  let storeApi: DashboardStoreApi | null = null;
  render(
    <DashboardProvider config={EMPTY_CONFIG} editable>
      <DcModalA11yScope>
        <CaptureStoreApi onApi={(api) => (storeApi = api)} />
        {extraChild}
      </DcModalA11yScope>
    </DashboardProvider>,
  );
  if (!storeApi) throw new Error("store API was not captured");
  return storeApi as DashboardStoreApi;
}

function pressEscape(init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document, { key: "Escape", ...init });
  });
}

describe("DcModalA11yScope — uniform ESC-to-close (cinatra#438)", () => {
  test("ESC closes the hand-rolled Add-text modal (the bug)", () => {
    const store = renderScope();
    expect(store.getState().isTextModalOpen).toBe(false);

    act(() => store.getState().openTextModal());
    expect(store.getState().isTextModalOpen).toBe(true);

    pressEscape();
    expect(store.getState().isTextModalOpen).toBe(false);
  });

  test("ESC still closes the Add-portlet modal (no regression)", () => {
    const store = renderScope();

    act(() => store.getState().openPortletModal());
    expect(store.getState().isPortletModalOpen).toBe(true);

    pressEscape();
    expect(store.getState().isPortletModalOpen).toBe(false);
  });

  test("ESC closes the delete-confirmation modal", () => {
    const store = renderScope();

    act(() => store.getState().openDeleteConfirm("portlet-1"));
    expect(store.getState().deleteConfirmPortletId).toBe("portlet-1");

    pressEscape();
    expect(store.getState().deleteConfirmPortletId).toBeNull();
  });

  test("ESC is inert when no modal is open (handler is unbound)", () => {
    const store = renderScope();
    expect(() => pressEscape()).not.toThrow();
    expect(store.getState().isTextModalOpen).toBe(false);
    expect(store.getState().isPortletModalOpen).toBe(false);
  });

  test("a nested editor that preventDefaults ESC keeps the modal open (bubble-phase contract)", () => {
    // Realistic shape of the bug codex flagged: a real DOM child handler
    // (an editor inside the modal) calls preventDefault on ESC. Because our
    // listener is on the document BUBBLE phase, it runs AFTER the child and
    // observes defaultPrevented — so it must NOT also close the modal. A
    // capture-phase listener would have closed it before the child ran.
    const store = renderScope(
      <div
        data-testid="nested-editor"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.preventDefault();
        }}
      />,
    );
    act(() => store.getState().openTextModal());
    expect(store.getState().isTextModalOpen).toBe(true);

    const editor = document.querySelector<HTMLDivElement>(
      "[data-testid='nested-editor']",
    )!;
    act(() => {
      // Dispatched from the child so the event truly bubbles up through it
      // to document — exercising real propagation order, not a pre-cancel.
      fireEvent.keyDown(editor, { key: "Escape" });
    });
    expect(store.getState().isTextModalOpen).toBe(true);
  });

  test("a nested editor that stopsPropagation ESC keeps the modal open", () => {
    // The other escape-consuming pattern: a child stops propagation so the
    // event never reaches our document listener at all.
    const store = renderScope(
      <div
        data-testid="nested-editor"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      />,
    );
    act(() => store.getState().openTextModal());
    expect(store.getState().isTextModalOpen).toBe(true);

    const editor = document.querySelector<HTMLDivElement>(
      "[data-testid='nested-editor']",
    )!;
    act(() => {
      fireEvent.keyDown(editor, { key: "Escape" });
    });
    expect(store.getState().isTextModalOpen).toBe(true);
  });

  test("ESC from a non-consuming child still bubbles to close the modal", () => {
    // Sanity: a child that does NOT consume ESC lets it bubble to document,
    // so the modal still closes — the bubble-phase fix didn't break the
    // primary behaviour.
    const store = renderScope(
      <div data-testid="plain-child" tabIndex={-1} />,
    );
    act(() => store.getState().openTextModal());
    expect(store.getState().isTextModalOpen).toBe(true);

    const child = document.querySelector<HTMLDivElement>(
      "[data-testid='plain-child']",
    )!;
    act(() => {
      fireEvent.keyDown(child, { key: "Escape" });
    });
    expect(store.getState().isTextModalOpen).toBe(false);
  });
});
