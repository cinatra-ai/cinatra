// @vitest-environment jsdom
//
// Behavioural proof for the in-card install panel (cinatra#2373, design spec
// §I.1). Renders the REAL CardFaceSwitcher over the REAL card faces and the
// REAL ExtensionInstallScopePanel — the same components the marketplace screen
// and the conformance harness mount — and drives them with real clicks.
//
// What this locks that a source-text assertion cannot:
//   - exactly ONE face is mounted (no hidden face retaining a stale panel);
//   - the panel's ids are useId-derived, so two concurrent panels do not
//     collide;
//   - the trigger renders the preselected `Workspace: All` row VERBATIM;
//   - focus enters the panel on open and returns to the Install CTA on close;
//   - a failing install TOASTS, mirrors the same safe copy into the hidden
//     role="alert" region, keeps the panel open AND keeps the selection —
//     and renders no inline error alert;
//   - the availability states render (and withhold) the right controls.
//
//   pnpm exec vitest run src/components/__tests__/extension-install-panel.test.tsx

import "./access-picker-jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import { ExtensionInstallScopePanel } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";
import type { InstallPanelAvailability } from "@cinatra-ai/extensions/screens/install-panel-availability";
import type { MarketplaceInstallActionResult } from "@cinatra-ai/extensions/screens/marketplace-failure-copy";

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
    value: "team:team-rev",
    label: "Revenue",
    level: "team" as const,
    id: "team-rev",
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

const ENTITY_NAMES = {
  [`org:${ORG_ID}`]: "Acme Corp",
  "team:team-rev": "Revenue",
};

const FAILURE_COPY = {
  "not-found": "not-found copy",
  unavailable: "unavailable copy",
  incompatible: "incompatible copy",
  unrecoverable: "We could not install Ledger Sync. Ask an administrator to try again.",
} as unknown as Record<string, string>;

function Panel({
  availability,
  installAction,
}: {
  availability: InstallPanelAvailability;
  installAction: (input: {
    packageName: string;
    packageVersion: string;
    accessTarget: { level: string; id: string };
  }) => Promise<MarketplaceInstallActionResult | void>;
}) {
  return (
    <ExtensionInstallScopePanel
      packageName="@cinatra-fixtures/ledger-sync"
      packageVersion="2.0.0"
      displayName="Ledger Sync"
      installTargets={TARGETS}
      ownerEntityNames={ENTITY_NAMES}
      activeOrgId={ORG_ID}
      availability={availability}
      failureCopyByCategory={
        FAILURE_COPY as Parameters<
          typeof ExtensionInstallScopePanel
        >[0]["failureCopyByCategory"]
      }
      defaultFailureMessage={FAILURE_COPY.unrecoverable}
      installAction={
        installAction as Parameters<typeof ExtensionInstallScopePanel>[0]["installAction"]
      }
    />
  );
}

function Card({
  availability = { state: "ready", defaultValue: "workspace" } as InstallPanelAvailability,
  installAction = async () => undefined,
  label = "Ledger Sync",
}: {
  availability?: InstallPanelAvailability;
  installAction?: (input: {
    packageName: string;
    packageVersion: string;
    accessTarget: { level: string; id: string };
  }) => Promise<MarketplaceInstallActionResult | void>;
  label?: string;
} = {}) {
  return (
    <CardFaceSwitcher
      idleFace={
        <div data-testid="idle-face">
          <span>{label}</span>
          <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
        </div>
      }
      installFace={
        <div data-testid="extension-install-panel">
          <span>{label}</span>
          <InstallPanelCloseButton />
          <Panel availability={availability} installAction={installAction} />
        </div>
      }
    />
  );
}

const openCta = () => screen.getAllByTestId("extension-install-panel-open")[0];

beforeEach(() => {
  toastError.mockReset();
  toastSuccess.mockReset();
});
afterEach(() => cleanup());

describe("CardFaceSwitcher — exactly one face (cinatra#2373)", () => {
  it("swaps the body in place: the idle face is UNMOUNTED, not hidden", () => {
    render(<Card />);
    expect(screen.getAllByTestId("idle-face")).toHaveLength(1);
    expect(screen.queryByTestId("extension-install-panel")).toBeNull();

    fireEvent.click(openCta());

    expect(screen.queryByTestId("idle-face")).toBeNull();
    expect(screen.getAllByTestId("extension-install-panel")).toHaveLength(1);
    // No dialog is mounted anywhere on this path.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });

  it("close ✕ and Cancel both restore the idle face", () => {
    render(<Card />);
    fireEvent.click(openCta());
    fireEvent.click(screen.getByTestId("extension-install-panel-close"));
    expect(screen.getAllByTestId("idle-face")).toHaveLength(1);
    expect(screen.queryByTestId("extension-install-panel")).toBeNull();

    fireEvent.click(openCta());
    fireEvent.click(screen.getByTestId("extension-install-panel-cancel"));
    expect(screen.getAllByTestId("idle-face")).toHaveLength(1);
    expect(screen.queryByTestId("extension-install-panel")).toBeNull();
  });

  it("two cards hold open panels concurrently with UNIQUE ids", () => {
    render(
      <>
        <Card label="Alpha" />
        <Card label="Beta" />
      </>,
    );
    const ctas = screen.getAllByTestId("extension-install-panel-open");
    expect(ctas).toHaveLength(2);
    fireEvent.click(ctas[0]);
    fireEvent.click(screen.getAllByTestId("extension-install-panel-open")[0]);

    const bodies = screen.getAllByTestId("extension-install-panel-body");
    expect(bodies).toHaveLength(2);
    const ids = bodies.map((b) => b.getAttribute("aria-labelledby"));
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    // The picker ids derive from the same per-card prefix.
    const pickerIds = screen
      .getAllByTestId("extension-install-panel-picker")
      .map((p) => p.querySelector('[role="combobox"]')?.getAttribute("id"));
    expect(pickerIds[0]).toBeTruthy();
    expect(pickerIds[0]).not.toBe(pickerIds[1]);
  });
});

describe("focus contract", () => {
  it("moves focus into the panel on open and back to the CTA on close", () => {
    render(<Card />);
    fireEvent.click(openCta());
    const trigger = screen
      .getByTestId("extension-install-panel-picker")
      .querySelector('[role="combobox"]');
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(screen.getByTestId("extension-install-panel-cancel"));
    expect(document.activeElement).toBe(
      screen.getByTestId("extension-install-panel-open"),
    );
  });

  it("focuses the panel heading when there is no enabled control", () => {
    render(<Card availability={{ state: "no-active-organization" }} />);
    fireEvent.click(openCta());
    const body = screen.getByTestId("extension-install-panel-body");
    const heading = document.getElementById(body.getAttribute("aria-labelledby")!);
    expect(document.activeElement).toBe(heading);
  });
});

describe("default audience + availability states", () => {
  it("preselects Workspace: All and renders it VERBATIM in the closed trigger", () => {
    render(<Card />);
    fireEvent.click(openCta());
    const trigger = screen
      .getByTestId("extension-install-panel-picker")
      .querySelector('[role="combobox"]')!;
    // Since cinatra#2372 the trigger composes the SAME two elements the row
    // does — a `<Type>:` prefix span and a name span separated by a CSS gap —
    // so its textContent carries no separating space. That is the trigger ≡ row
    // guarantee, not a drift from it: match the pair, exactly as the Playwright
    // conformance driver for this surface does.
    expect(trigger.textContent).toMatch(/Workspace:\s*All/);
    // Not the retired trigger-only phrasing.
    expect(trigger.textContent).not.toContain("Whole Workspace");
  });

  it("keeps narrower audiences selectable", () => {
    render(<Card />);
    fireEvent.click(openCta());
    const trigger = screen
      .getByTestId("extension-install-panel-picker")
      .querySelector('[role="combobox"]')!;
    fireEvent.click(trigger);
    // The ROW renders its `<Type>:` prefix and its name as two elements, so
    // textContent carries no separating space — match on the pair, not on the
    // rendered-with-CSS-gap string.
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((t) => /Workspace:\s*All/.test(t))).toBe(true);
    expect(options.some((t) => /Workspace:\s*Admins only/.test(t))).toBe(true);
    expect(options.some((t) => /Team:\s*Revenue/.test(t))).toBe(true);
  });

  it("no-active-organization: names the real problem, no picker, no submit", () => {
    render(<Card availability={{ state: "no-active-organization" }} />);
    fireEvent.click(openCta());
    const body = screen.getByTestId("extension-install-panel-body");
    expect(body.getAttribute("data-availability")).toBe("no-active-organization");
    expect(within(body).getByText(/needs an active organization/i)).toBeTruthy();
    expect(screen.queryByTestId("extension-install-panel-picker")).toBeNull();
    expect(screen.queryByTestId("extension-install-panel-submit")).toBeNull();
    // Cancel remains — the admin can always get back to the card.
    expect(screen.getByTestId("extension-install-panel-cancel")).toBeTruthy();
  });

  it("no-installable-scope: the role-oriented empty state, copy unchanged", () => {
    render(<Card availability={{ state: "no-installable-scope" }} />);
    fireEvent.click(openCta());
    const body = screen.getByTestId("extension-install-panel-body");
    expect(body.getAttribute("data-availability")).toBe("no-installable-scope");
    expect(
      within(body).getByText(
        "You need org admin, team admin, or project ownership to install extensions.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("extension-install-panel-submit")).toBeNull();
  });
});

describe("failure path — toast + hidden live region, panel stays put", () => {
  it("toasts the classified copy, mirrors it into role=alert, keeps the selection", async () => {
    const installAction = vi.fn(
      async (input: {
        packageName: string;
        packageVersion: string;
        accessTarget: { level: string; id: string };
      }) => {
        void input;
        return { ok: false as const, category: "unrecoverable" as const };
      },
    );
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    fireEvent.click(screen.getByTestId("extension-install-panel-submit"));

    await waitFor(() => expect(installAction).toHaveBeenCalledTimes(1));
    // The AUDIENCE actually submitted is the preselected workspace row.
    expect(installAction.mock.calls[0][0]).toMatchObject({
      packageName: "@cinatra-fixtures/ledger-sync",
      packageVersion: "2.0.0",
      accessTarget: { level: "workspace", id: ORG_ID },
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const message = String(toastError.mock.calls[0][0]);
    expect(message).toBe(FAILURE_COPY.unrecoverable);

    // The SAME safe copy is announced — and nothing else is rendered for it.
    await waitFor(() =>
      expect(screen.getByTestId("extension-install-panel-error").textContent).toBe(message),
    );
    expect(
      screen.getByTestId("extension-install-panel-error").getAttribute("role"),
    ).toBe("alert");
    // No raw backend detail, and no inline alert redraw of the panel body.
    const body = screen.getByTestId("extension-install-panel-body");
    expect(body.textContent).not.toContain("unrecoverable");
    expect(body.querySelector('[data-slot="alert"]')).toBeNull();

    // The panel stayed open with the selection retained. (Trigger ≡ row renders
    // the type prefix and the name as two gap-separated elements — cinatra#2372.)
    expect(screen.getByTestId("extension-install-panel-body")).toBeTruthy();
    const trigger = screen
      .getByTestId("extension-install-panel-picker")
      .querySelector('[role="combobox"]')!;
    expect(trigger.textContent).toMatch(/Workspace:\s*All/);
  });

  it("re-announces an IDENTICAL repeat failure (the alert node is remounted)", async () => {
    // A `role="alert"` whose text never changes is never re-read. Two
    // identical failures in a row must still reach a screen reader, so the
    // alert is keyed by an announcement sequence and remounts each time.
    // (Clearing-then-setting in one handler cannot work: React batches both
    // updates into one commit, so the empty state never reaches the DOM.)
    const installAction = vi.fn(
      async (input: {
        packageName: string;
        packageVersion: string;
        accessTarget: { level: string; id: string };
      }) => {
        void input;
        return { ok: false as const, category: "unrecoverable" as const };
      },
    );
    render(<Card installAction={installAction} />);
    fireEvent.click(openCta());

    fireEvent.click(screen.getByTestId("extension-install-panel-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("extension-install-panel-error").textContent).toBe(
        FAILURE_COPY.unrecoverable,
      ),
    );
    const firstNode = screen.getByTestId("extension-install-panel-error");

    fireEvent.click(screen.getByTestId("extension-install-panel-submit"));
    await waitFor(() => expect(installAction).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("extension-install-panel-error")).not.toBe(firstNode),
    );
    // Same copy, new node — the announcement, not a different message.
    expect(screen.getByTestId("extension-install-panel-error").textContent).toBe(
      FAILURE_COPY.unrecoverable,
    );
    expect(toastError).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Committability gate (cinatra#2372). The panel is the newest single-mode
// install consumer: it landed while the flat access-option model was parked, so
// it shipped gating submit on bare value-truthiness. The model supersedes that,
// exactly as it does in both install dialogs — a selection that is synthetic,
// degenerate, or server-disabled is NOT committable, so the submit is disabled
// and the handler refuses even if the control is driven anyway.
// ---------------------------------------------------------------------------
describe("committability gate — non-committable selections cannot install", () => {
  /**
   * The gate's own refusal copy, mirrored from the panel's submit handler. It
   * is deliberately NOT one of the `failureCopyByCategory` entries: nothing
   * reached the backend, so no backend category classifies this.
   */
  const GATE_REFUSAL_COPY =
    "Pick who can access this extension before installing — the current selection is not an installable audience.";

  /**
   * The server-supplied disabled REASON. Legitimate explanatory copy on the
   * picker OPTION; the contract is that it never becomes failure-body copy.
   */
  const DISABLED_REASON = "Requires an active organization.";

  /** A panel whose ONLY offered org row is server-disabled. */
  function DisabledOrgPanel({
    installAction,
  }: {
    installAction: (input: {
      packageName: string;
      packageVersion: string;
      accessTarget: { level: string; id: string };
    }) => Promise<MarketplaceInstallActionResult | void>;
  }) {
    const targets = [
      {
        value: `org:${ORG_ID}`,
        label: "Anyone in Acme Corp",
        level: "organization" as const,
        id: ORG_ID,
        disabled: true,
        reason: DISABLED_REASON,
      },
    ];
    return (
      <CardFaceSwitcher
        idleFace={
          <div data-testid="idle-face">
            <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
          </div>
        }
        installFace={
          <div>
            <InstallPanelCloseButton />
            <ExtensionInstallScopePanel
              packageName="@cinatra-fixtures/ledger-sync"
              packageVersion="2.0.0"
              displayName="Ledger Sync"
              installTargets={targets}
              ownerEntityNames={ENTITY_NAMES}
              activeOrgId={ORG_ID}
              availability={
                { state: "ready", defaultValue: `org:${ORG_ID}` } as InstallPanelAvailability
              }
              failureCopyByCategory={
                FAILURE_COPY as Parameters<
                  typeof ExtensionInstallScopePanel
                >[0]["failureCopyByCategory"]
              }
              defaultFailureMessage={FAILURE_COPY.unrecoverable}
              installAction={
                installAction as Parameters<typeof ExtensionInstallScopePanel>[0]["installAction"]
              }
            />
          </div>
        }
      />
    );
  }

  it("disables submit for a server-DISABLED selection, and the handler refuses it", async () => {
    const installAction = vi.fn(async () => undefined);
    render(<DisabledOrgPanel installAction={installAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Install now" }));

    const submit = screen.getByTestId("extension-install-panel-submit") as HTMLButtonElement;
    // The value is truthy — the OLD `!value` gate would have enabled this.
    expect(submit.disabled).toBe(true);

    // Drive the form anyway: the handler is the second, independent gate.
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(installAction).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // S4 acceptance (cinatra#2375, item 5) — the one genuinely NEW combination.
  //
  // S1's committability gate landed AFTER S2's error-path tests, so the two
  // contracts were never proven TOGETHER: the gate assertion above stops at
  // "a toast fired and the action was refused", while every error-path
  // assertion above drives a BACKEND failure (a classified `ok:false` result)
  // rather than a gate refusal. A gate refusal is the one failure the panel
  // raises entirely on its own — nothing reaches the server — so nothing until
  // now proved it lands on the SAME accessible surface a backend failure does.
  //
  // Driving the refusal through the full S2 error-path contract catches a
  // regression that reports it by any weaker route: a toast-only path that
  // never announces, an inline alert redraw of the body, the picker's own
  // explanatory copy bleeding into the failure surface, focus escaping the
  // panel, or the selection being dropped.
  // -------------------------------------------------------------------------
  it("routes a gate refusal through the full error path — mirrored alert, panel-scoped copy, focus and selection retained", async () => {
    const installAction = vi.fn(async () => undefined);
    render(<DisabledOrgPanel installAction={installAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Install now" }));

    const submit = screen.getByTestId("extension-install-panel-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const trigger = screen
      .getByTestId("extension-install-panel-picker")
      .querySelector('[role="combobox"]')!;
    // Record the rendered selection BEFORE the refusal — asserting it is
    // unchanged afterwards pins retention without re-testing #2372's resolver.
    const selectionBefore = trigger.textContent;

    fireEvent.submit(submit.closest("form")!);

    // 1. Refused locally — the backend is never reached.
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(installAction).not.toHaveBeenCalled();

    // 2. The refusal is ANNOUNCED, not just toasted: the hidden live region
    //    mirrors the toast copy verbatim, exactly as a backend failure does.
    //    This is the assertion a toast-only regression fails.
    const message = String(toastError.mock.calls[0][0]);
    expect(message).toBe(GATE_REFUSAL_COPY);
    await waitFor(() =>
      expect(screen.getByTestId("extension-install-panel-error").textContent).toBe(message),
    );
    expect(
      screen.getByTestId("extension-install-panel-error").getAttribute("role"),
    ).toBe("alert");

    // 3. The picker's own disabled REASON is legitimate explanatory copy on the
    //    OPTION — it is deliberately NOT banned from the panel at large. What it
    //    must never do is become the FAILURE copy, so the ban is scoped to the
    //    two failure surfaces. The failure also must not be redrawn as an inline
    //    alert inside the panel (the toast + live region are the whole surface).
    const body = screen.getByTestId("extension-install-panel-body");
    expect(message).not.toContain(DISABLED_REASON);
    expect(
      screen.getByTestId("extension-install-panel-error").textContent,
    ).not.toContain(DISABLED_REASON);
    expect(body.querySelector('[data-slot="alert"]')).toBeNull();

    // 4. Focus never leaves the panel — the refusal must not strand the user.
    expect(body.contains(document.activeElement)).toBe(true);

    // 5. The selection is retained (the refusal is not a reset), and the gate
    //    stays shut rather than flipping open as a side effect.
    expect(trigger.textContent).toBe(selectionBefore);
    expect(
      (screen.getByTestId("extension-install-panel-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
