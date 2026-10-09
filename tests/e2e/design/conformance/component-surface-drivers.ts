/**
 * Drivers for the components drawing's component surfaces (the shared-primitives
 * wave). Each surface is mounted ONCE on the conformance harness
 * (src/app/design-fixtures/conformance/component-surface-fixtures.tsx) as the
 * SHIPPED primitive, and its manifest declares no field, action or state: the
 * battery is "surface renders", which reads the harness mount and the
 * primitive's OWN data-slot marker inside it. The four overlays (dialog,
 * select, combobox, tooltip) are also opened by their own trigger, their open
 * content read on the page, and closed again with Escape.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { SurfaceDriver } from "./contract";

const slot = (name: string) => `[data-slot="${name}"]`;

/** The overlay a surface opens by its own trigger, read on the page while open. */
type Overlay = { trigger: string; content: string; open: "press" | "hover" };

async function openAndClose(page: Page, root: Locator, overlay: Overlay): Promise<void> {
  const trigger = root.locator(slot(overlay.trigger)).first();
  const content = page.locator(slot(overlay.content));
  // A press or a pointer move that lands before React hydration is swallowed,
  // so it is retried until the content answers (contract.ts's clickCtaUntil).
  await expect(async () => {
    if ((await content.count()) === 0) {
      if (overlay.open === "hover") {
        await page.mouse.move(0, 0);
        await trigger.hover();
      } else {
        await trigger.click();
      }
    }
    await expect(content.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(content).toHaveCount(0);
}

function componentSurfaceDriver(id: string, markers: readonly string[], overlay?: Overlay): SurfaceDriver {
  return {
    path: "/design-fixtures/conformance",
    root: (page) => page.locator(`[data-surface-id="${id}"]`),
    present: async (page, root) => {
      await expect(root).toBeVisible();
      for (const marker of markers) {
        await expect(root.locator(slot(marker)), `${id} holds ${marker}`).not.toHaveCount(0);
      }
      if (overlay) await openAndClose(page, root, overlay);
    },
    fields: {},
    actions: {},
    states: {},
  };
}

export const BUTTON_SURFACE_DRIVER = componentSurfaceDriver("button", ["button"]);
export const CARD_SURFACE_DRIVER = componentSurfaceDriver("card", ["card"]);
export const INPUT_SURFACE_DRIVER = componentSurfaceDriver("input", ["input"]);
export const SELECT_SURFACE_DRIVER = componentSurfaceDriver("select", ["select-trigger"], {
  trigger: "select-trigger",
  content: "select-content",
  open: "press",
});
export const DIALOG_SURFACE_DRIVER = componentSurfaceDriver("dialog", ["dialog-trigger"], {
  trigger: "dialog-trigger",
  content: "dialog-content",
  open: "press",
});
export const BADGE_SURFACE_DRIVER = componentSurfaceDriver("badge", ["badge"]);
export const TABS_SURFACE_DRIVER = componentSurfaceDriver("tabs", ["tabs", "tabs-list", "tabs-trigger"]);
export const TOOLBAR_SURFACE_DRIVER = componentSurfaceDriver("toolbar", ["toolbar"]);
export const TOOLBAR_NESTED_SURFACE_DRIVER = componentSurfaceDriver("toolbar-nested", ["toolbar", "toolbar-child"]);
export const SIDEBAR_SURFACE_DRIVER = componentSurfaceDriver("sidebar", ["sidebar"]);
export const SIDEBAR_GROUP_LABEL_SURFACE_DRIVER = componentSurfaceDriver("sidebar-group-label", ["sidebar-group-label"]);
export const TOOLTIP_SURFACE_DRIVER = componentSurfaceDriver("tooltip", ["tooltip-trigger"], {
  trigger: "tooltip-trigger",
  content: "tooltip-content",
  open: "hover",
});
export const AVATAR_SURFACE_DRIVER = componentSurfaceDriver("avatar", ["avatar"]);
export const FORM_SURFACE_DRIVER = componentSurfaceDriver("form", ["form-item", "form-label", "form-control"]);
export const CHECKBOX_SURFACE_DRIVER = componentSurfaceDriver("checkbox", ["checkbox"]);
export const ALERT_SURFACE_DRIVER = componentSurfaceDriver("alert", ["alert"]);
export const TABLE_SURFACE_DRIVER = componentSurfaceDriver("table", ["table"]);
export const COMMAND_SURFACE_DRIVER = componentSurfaceDriver("command", ["command"]);
export const BREADCRUMB_SURFACE_DRIVER = componentSurfaceDriver("breadcrumb", ["breadcrumb"]);
export const PAGINATION_SURFACE_DRIVER = componentSurfaceDriver("pagination", ["pagination"]);
export const SKELETON_SURFACE_DRIVER = componentSurfaceDriver("skeleton", ["skeleton"]);
export const EMPTY_SURFACE_DRIVER = componentSurfaceDriver("empty", ["empty"]);
export const ACCORDION_SURFACE_DRIVER = componentSurfaceDriver("accordion", ["accordion"]);
export const SEPARATOR_SURFACE_DRIVER = componentSurfaceDriver("separator", ["separator"]);
export const TOGGLE_SURFACE_DRIVER = componentSurfaceDriver("toggle", ["toggle"]);
export const CALENDAR_SURFACE_DRIVER = componentSurfaceDriver("calendar", ["calendar"]);
export const COMBOBOX_SURFACE_DRIVER = componentSurfaceDriver("combobox", ["combobox-trigger"], {
  trigger: "combobox-trigger",
  content: "combobox-content",
  open: "press",
});
export const SCROLL_AREA_SURFACE_DRIVER = componentSurfaceDriver("scroll-area", ["scroll-area"]);
export const INPUT_OTP_SURFACE_DRIVER = componentSurfaceDriver("input-otp", ["input-otp", "input-otp-slot"]);
