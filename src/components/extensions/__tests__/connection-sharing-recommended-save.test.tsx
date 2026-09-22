// @vitest-environment jsdom
//
// A recommending connector's panel, rendered, then saved (cinatra#3408).
//
// Section II of the connectors drawing, the Sharing tab: "Where the connector
// only recommends a scope, the line reads instead This connector recommends
// sharing with your organization ... Currently: only you. Nothing is shared by
// either line on its own; the grant is written when you press Save changes."
//
// The panel model (`decideConnectionShareSurface`) decides what the picker
// opens on and which line sits under it; the real `PermissionsForm` draws them.
// This suite feeds the form exactly what the model yields for the MCP Servers
// connector's declaration (mode default, scope workspace) on the untouched
// connect seed, and proves the two roads the owner has from there:
//   - accept: Save changes writes the recommended scope, and
//   - decline: taking the workspace row back to Only me, then Save changes,
//     writes the owner scope.
// Nothing is written before Save in either road.

import "@/components/__tests__/access-picker-jsdom-shims";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { PermissionsForm, type PermissionsFormActions } from "@/components/permissions-form";
import type { AvailableScopes } from "@/components/access-combobox";
import { decideConnectionShareSurface } from "@/lib/connection-share-ui";

const ORG = "org-1";

const SCOPES: AvailableScopes = {
  orgs: [{ id: ORG, name: "Acme", teams: [] }],
  projects: [],
  canGrantWorkspace: true,
};

/** Exactly what `registerSavedConnectionIdentity` writes at registration. */
const CONNECT_SEED = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
  seededDefault: true,
} as unknown as AgentAuthPolicy;

/**
 * The recommendation line as section II of the connectors drawing gives it,
 * word for word. The dash is U+2014, written as an escape here.
 */
const RECOMMENDATION_LINE =
  "This connector recommends sharing with your organization \u2014 nothing is shared until you save. Currently: only you.";

afterEach(() => cleanup());

function drawRecommendedPanel() {
  const surface = decideConnectionShareSurface({
    identity: { organizationId: ORG },
    declaration: {
      formatVersion: 1,
      mode: "default",
      scope: "workspace",
      source: "declared",
    } as never,
    storedPolicy: CONNECT_SEED,
    scopes: SCOPES,
  });
  if (surface.surface !== "editable") throw new Error("expected an editable surface");

  const savePolicy = vi.fn<PermissionsFormActions["savePolicy"]>(async () => ({ ok: true }));
  const actions: PermissionsFormActions = {
    savePolicy,
    searchCandidates: async () => ({ ok: true, results: [], hasMore: false }),
    addCoOwner: async () => ({ ok: true }),
    removeCoOwner: async () => ({ ok: true }),
  };
  render(
    <PermissionsForm
      resourceKind="connection"
      canEdit
      initialPolicy={CONNECT_SEED}
      owner={{ userId: "user-owner", name: "Owner", email: "owner@example.com", image: null }}
      coOwners={[]}
      availableScopes={SCOPES}
      currentUserId="user-owner"
      allowSharing
      actions={actions}
      accessHelperText="Choose who can use this connection."
      accessValueOverride={surface.value}
      accessScopeNote={surface.recommendationNote}
    />,
  );
  return { savePolicy };
}

async function pressSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  });
}

describe("a recommending connector's panel on the untouched seed", () => {
  it("draws the drawing's line and opens the picker on the recommended scope, and writes nothing before Save", () => {
    const { savePolicy } = drawRecommendedPanel();

    expect(screen.getByText(RECOMMENDATION_LINE)).toBeTruthy();
    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent ?? "").toMatch(/Workspace:\s*All/);
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("writes the recommended scope when the owner presses Save changes", async () => {
    const { savePolicy } = drawRecommendedPanel();

    await pressSave();

    await waitFor(() => expect(savePolicy).toHaveBeenCalledTimes(1));
    expect(savePolicy.mock.calls[0]?.[0]).toEqual({
      runListVisibility: ["workspace"],
      runDataVisibility: ["workspace"],
      runExecuteVisibility: ["workspace"],
      allowRunSharing: false,
    });
  });

  it("writes the owner scope when the owner declines the recommendation, then presses Save changes", async () => {
    const { savePolicy } = drawRecommendedPanel();

    // The workspace row stays enabled while it is selected; taking it back
    // returns the picker to Only me.
    fireEvent.click(screen.getByRole("combobox"));
    const workspaceRow = document.querySelector<HTMLElement>(
      '[role="option"][data-value="workspace"]',
    );
    expect(workspaceRow).not.toBeNull();
    expect(workspaceRow?.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      fireEvent.click(workspaceRow as HTMLElement);
    });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByRole("combobox").textContent ?? "").toMatch(/Personal:\s*Only me/);
    expect(savePolicy).not.toHaveBeenCalled();

    await pressSave();

    await waitFor(() => expect(savePolicy).toHaveBeenCalledTimes(1));
    expect(savePolicy.mock.calls[0]?.[0]).toEqual({
      runListVisibility: ["owner"],
      runDataVisibility: ["owner"],
      runExecuteVisibility: ["owner"],
      allowRunSharing: false,
    });
  });
});
