// @vitest-environment jsdom
//
// cinatra#3520 — "Errors are a toast, never inline".
//
// The drawing (the design spec `specs/app-extensions.html` §I.1): "Errors are
// a toast, never inline: a failed install neither redraws the panel with an
// error state nor grows its height — it reports through the app's toast
// surface, and the panel stays exactly as the admin left it so the selection is
// never lost."
//
// The picture round of cinatra#3494 read the install panel's own DOM after a
// failed install and found the classified failure sentence inside it
// ("Couldn't install PDF. Contact your administrator for help. (Ref: …)"). The
// panel carried a visually hidden role="alert" mirror of the toast copy in its
// own subtree, so the failure DID redraw the panel body — the clause above is
// about the panel's DOM, not only about what the eye can see.
//
// This file pins the clause on the REAL rendered panel, driven by real clicks:
//
//   - the panel body's own outerHTML is byte-identical immediately before the
//     submit and after the failed install resolves (so its box cannot move);
//   - no part of the failure copy is anywhere inside the panel;
//   - the app's toast surface is the ONE that received the failure, with the
//     opaque diagnostic reference kept;
//   - after the toast the panel's actions still work — a second Install now
//     really re-submits, and Cancel still returns the card to idle.
//
// The announcement a screen reader hears is the toast surface's own live region
// (sonner renders its toast list inside `<section aria-live="polite"
// aria-relevant="additions text">`), which is OUTSIDE this panel.
//
//   pnpm exec vitest run src/components/__tests__/install-panel-toast-only-failure.test.tsx

import "./access-picker-jsdom-shims";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import {
  CardFaceSwitcher,
  InstallPanelCloseButton,
  InstallPanelOpenButton,
} from "@cinatra-ai/extensions/screens/card-face-switcher";
import {
  ExtensionInstallScopePanel,
  InstallPanelScopeProvider,
} from "@cinatra-ai/extensions/screens/extension-install-scope-panel";
import type { InstallPanelScopeContextValue } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";
import type { InstallPanelAvailability } from "@cinatra-ai/extensions/screens/install-panel-availability";
import {
  buildMarketplaceFailureCopy,
  type MarketplaceInstallActionResult,
} from "@cinatra-ai/extensions/screens/marketplace-failure-copy";

const ORG_ID = "org-acme";

const TARGETS = [
  {
    value: `org:${ORG_ID}`,
    label: "Anyone in Acme Corp",
    level: "organization" as const,
    id: ORG_ID,
    disabled: false,
  },
  {
    value: "workspace",
    label: "Whole Workspace",
    level: "workspace" as const,
    id: ORG_ID,
    disabled: false,
  },
  {
    value: "admin",
    label: "Admins only",
    level: "admin" as const,
    id: ORG_ID,
    disabled: false,
  },
];

const ENTITY_NAMES = { [`org:${ORG_ID}`]: "Acme Corp" };

/** The same pure builder the panel derives its classified copy from. */
const FAILURE_COPY = buildMarketplaceFailureCopy("install", "Ledger Sync");

/** The opaque diagnostic reference the drawing keeps with the failure. */
const REFERENCE = "REF-88D6E100";

type InstallAction = (input: {
  packageName: string;
  packageVersion: string;
  accessTarget: { level: string; id: string };
}) => Promise<MarketplaceInstallActionResult | void>;

function Card({ installAction }: { installAction: InstallAction }) {
  const availability = {
    state: "ready",
    defaultValue: "workspace",
  } as InstallPanelAvailability;
  return (
    <CardFaceSwitcher
      idleFace={
        <div data-testid="idle-face">
          <span>Ledger Sync</span>
          <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
        </div>
      }
      installFace={
        <div data-testid="extension-install-panel">
          <span>Ledger Sync</span>
          <InstallPanelCloseButton />
          <InstallPanelScopeProvider
            value={{
              installTargets: TARGETS,
              ownerEntityNames: ENTITY_NAMES,
              activeOrgId: ORG_ID,
              availability,
              installAction: installAction as InstallPanelScopeContextValue["installAction"],
            }}
          >
            <ExtensionInstallScopePanel
              packageName="@cinatra-fixtures/ledger-sync"
              packageVersion="2.0.0"
              displayName="Ledger Sync"
            />
          </InstallPanelScopeProvider>
        </div>
      }
    />
  );
}

/** A classified backend refusal, the shape the picture round's install hit. */
const failingInstall = () =>
  vi.fn(async () => ({
    ok: false as const,
    category: "unrecoverable" as const,
    reference: REFERENCE,
  })) as unknown as ReturnType<typeof vi.fn> & InstallAction;

const openCta = () => screen.getAllByTestId("extension-install-panel-open")[0];
const submitControl = () =>
  screen.getByTestId("extension-install-panel-submit") as HTMLButtonElement;

/** The failure resolved AND the submit's pending flag cleared again. */
const settled = async (calls: number) => {
  await waitFor(() => {
    expect(toastError).toHaveBeenCalledTimes(calls);
    expect(submitControl().disabled).toBe(false);
  });
};

beforeEach(() => {
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterAll(() => {
  vi.doUnmock("@/lib/cinatra-toast");
  vi.resetModules();
});

describe('clause: "Errors are a toast, never inline" (cinatra#3520)', () => {
  it("leaves the panel's own DOM and box exactly as the admin left them", async () => {
    const installAction = failingInstall();
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    const body = screen.getByTestId("extension-install-panel-body");
    const domBefore = body.outerHTML;
    const boxBefore = body.getBoundingClientRect();

    fireEvent.click(submitControl());
    await settled(1);
    expect(installAction).toHaveBeenCalledTimes(1);

    // The SAME node, not a redraw.
    expect(screen.getByTestId("extension-install-panel-body")).toBe(body);
    // "a failed install neither redraws the panel with an error state" — the
    // panel's whole subtree is byte-identical, so nothing inside it moved.
    expect(
      body.outerHTML,
      "the failed install redrew the panel's own DOM",
    ).toBe(domBefore);
    // "nor grows its height" — the box is unchanged. (jsdom does no layout, so
    // this reads 0 both times; the drawn 299px is measured on the live boot.)
    expect(body.getBoundingClientRect().height).toBe(boxBefore.height);

    // No failure copy anywhere inside the panel — not visible, not hidden.
    const message = String(toastError.mock.calls[0][0]);
    expect(body.textContent ?? "").not.toContain(message);
    expect(body.textContent ?? "").not.toContain("Couldn't install");
    expect(body.textContent ?? "").not.toContain(REFERENCE);
    expect(body.querySelector('[role="alert"]')).toBeNull();
    expect(body.querySelector('[data-slot="alert"]')).toBeNull();
  });

  it("reports through the app's toast surface, with the reference kept", async () => {
    const installAction = failingInstall();
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    fireEvent.click(submitControl());
    await settled(1);

    // "it reports through the app's toast surface" — the classified copy plus
    // the opaque diagnostic reference, and no raw backend detail.
    expect(toastError).toHaveBeenCalledExactlyOnceWith(
      `${FAILURE_COPY.unrecoverable} (Ref: ${REFERENCE})`,
    );
    expect(String(toastError.mock.calls[0][0])).not.toContain("unrecoverable");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("keeps the selection, so it is never lost", async () => {
    const installAction = failingInstall();
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    const trigger = screen
      .getByTestId("extension-install-panel-picker")
      .querySelector('[role="combobox"]')!;
    const selectionBefore = trigger.textContent;

    fireEvent.click(submitControl());
    await settled(1);

    expect(screen.getByTestId("extension-install-panel-body")).toBeTruthy();
    expect(trigger.textContent).toBe(selectionBefore);
    expect(trigger.textContent).toMatch(/Workspace:\s*All/);
  });
});

describe("the panel stays usable after the toast (cinatra#3520)", () => {
  it("lets the admin try again — a second Install now really re-submits", async () => {
    const installAction = failingInstall();
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    fireEvent.click(submitControl());
    await settled(1);

    expect(submitControl().disabled).toBe(false);
    expect(submitControl().textContent).toBe("Install now");

    fireEvent.click(submitControl());
    await waitFor(() => expect(installAction).toHaveBeenCalledTimes(2));
    await settled(2);
  });

  it("lets the admin cancel — the card returns to idle", async () => {
    const installAction = failingInstall();
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    fireEvent.click(submitControl());
    await settled(1);

    const cancel = screen.getByTestId("extension-install-panel-cancel") as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);

    expect(screen.getAllByTestId("idle-face")).toHaveLength(1);
    expect(screen.queryByTestId("extension-install-panel")).toBeNull();
  });
});
