// @vitest-environment jsdom
/**
 * The Upload Extension screen's FILE tab (cinatra#3204 leg 3 — criteria 1, 4, 5,
 * 11, 17, and the screen half of CELL1 / CELL5).
 *
 * REPLACES the agent-only state-machine test this file used to hold. That test
 * asserted a form that no longer exists: a name-override field, an "Upload
 * (.zip)" button, an agent-shaped preview and a run-visibility checkbox picker.
 * Preserving it would have meant preserving the agent-only road, which is the
 * bug this issue fixes.
 *
 * The REAL dropzone, the REAL archive reader and the REAL store install panel
 * render; only the server actions, the router and the toast are mocked — so the
 * assertion "the store's own panel is what is mounted" is made against the real
 * component, not a stand-in.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createZipBuffer } from "../zip-helpers";

const routerState = vi.hoisted(() => ({ push: vi.fn() as ReturnType<typeof vi.fn> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerState.push }) }));

const actions = vi.hoisted(() => ({
  installSuppliedArchiveAction: vi.fn(async () => ({
    ok: true as const,
    kind: "artifact" as const,
    packageName: "@acme/thing-artifact",
    version: "1.0.0",
    observable: { label: "See it in installed extensions", href: "/configuration/extensions" },
  })),
  // The upload-consent lookup the form makes once a kind is known. Null here:
  // an artifact package is never asked, and this suite is about the kind road.
  readSuppliedUploadConsentPromptAction: vi.fn(async () => null),
}));
vi.mock("../supplied-install-actions", () => actions);

const toastState = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/lib/cinatra-toast", () => ({ toast: toastState }));

import { ImportAgentForm } from "../import-form";

const INSTALL_SCOPE = {
  installTargets: [
    { value: "workspace", label: "Workspace: All", level: "workspace" as const, id: "org-1", disabled: false },
    { value: "admin", label: "Workspace: Admins only", level: "admin" as const, id: "org-1", disabled: false },
    { value: "org:org-1", label: "Acme", level: "organization" as const, id: "org-1", disabled: false },
  ],
  ownerEntityNames: { "org:org-1": "Acme" },
  activeOrgId: "org-1",
  availability: { state: "ready" as const, defaultValue: "workspace" },
};

function zipFile(entries: { name: string; content: string }[], fileName = "fixture.zip"): File {
  const buf = createZipBuffer(entries);
  return new File([new Uint8Array(buf)], fileName, { type: "application/zip" });
}

function artifactZip(): File {
  return zipFile([
    {
      name: "package.json",
      content: JSON.stringify({
        name: "@acme/thing-artifact",
        version: "1.0.0",
        cinatra: { kind: "artifact" },
      }),
    },
    { name: "cinatra/artifact.json", content: JSON.stringify({ accepts: [] }) },
  ]);
}

function agentZip(): File {
  return zipFile([
    {
      name: "package.json",
      content: JSON.stringify({
        name: "@acme/thing-agent",
        version: "1.0.0",
        cinatra: { kind: "agent" },
      }),
    },
    {
      name: "cinatra/oas.json",
      content: JSON.stringify({
        component_type: "Flow",
        agentspec_version: "26.1.0",
        name: "Thing Agent",
      }),
    },
  ], "agent.zip");
}

function skillZip(): File {
  return zipFile([
    {
      name: "package.json",
      content: JSON.stringify({
        name: "@acme/thing-skill",
        version: "1.0.0",
        cinatra: { kind: "skill" },
      }),
    },
    {
      name: "skills/one/SKILL.md",
      content: "---\nname: one\ndescription: One skill.\n---\nbody",
    },
  ], "skill.zip");
}

function workflowZip(): File {
  return zipFile([
    {
      name: "package.json",
      content: JSON.stringify({
        name: "@acme/retired",
        version: "1.0.0",
        cinatra: { kind: "workflow" },
      }),
    },
  ], "retired.zip");
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the File tab takes any kind and asks for its scope", () => {
  it("shows the picker and no scope panel before a package is supplied", () => {
    render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
    expect(screen.getByText("Select an extension package")).toBeTruthy();
    expect(screen.queryByTestId("upload-install-scope")).toBeNull();
  });

  it("reads an ARTIFACT package and mounts the store's own install panel (criteria 1, 11)", async () => {
    render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(fileInput(), { target: { files: [artifactZip()] } });

    await waitFor(() => {
      expect(screen.getByTestId("upload-resolved-kind").textContent).toBe("Artifact");
    });
    expect(screen.getByText("@acme/thing-artifact")).toBeTruthy();
    // The STORE's panel, by its own stable hooks — not a second implementation.
    const panel = screen.getByTestId("extension-install-panel-body");
    expect(panel.getAttribute("data-availability")).toBe("ready");
    expect(screen.getByTestId("extension-install-panel-picker")).toBeTruthy();
    expect(screen.getByTestId("extension-install-panel-submit")).toBeTruthy();
    expect(screen.getByTestId("extension-install-panel-cancel")).toBeTruthy();
  });

  it("refuses a retired-kind archive through the toast surface, with no panel (criterion 1, CELL5)", async () => {
    render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(fileInput(), { target: { files: [workflowZip()] } });

    await waitFor(() => {
      expect(toastState.error).toHaveBeenCalled();
    });
    expect(String(toastState.error.mock.calls[0]?.[0])).toMatch(/retired extension kind/);
    expect(screen.queryByTestId("upload-install-scope")).toBeNull();
    expect(actions.installSuppliedArchiveAction).not.toHaveBeenCalled();
  });

  it("asks the scope question ONCE — the run-visibility picker is gone (criterion 17)", async () => {
    render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(fileInput(), { target: { files: [artifactZip()] } });
    await waitFor(() => {
      expect(screen.getByTestId("upload-install-scope")).toBeTruthy();
    });
    expect(screen.queryByText(/Choose which scopes can access the uploaded extension/)).toBeNull();
    expect(screen.queryByText(/Configure access & ownership/)).toBeNull();
    expect(screen.queryByLabelText(/Name override/)).toBeNull();
  });

  it("Cancel discards the selection and returns to the picker", async () => {
    render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(fileInput(), { target: { files: [artifactZip()] } });
    await waitFor(() => {
      expect(screen.getByTestId("upload-install-scope")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("extension-install-panel-cancel"));
    await waitFor(() => {
      expect(screen.getByText("Select an extension package")).toBeTruthy();
    });
    expect(screen.queryByTestId("upload-install-scope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WHERE A COMPLETED INSTALL TAKES THE OPERATOR (cinatra#3204 criterion 21).
//
// Every kind's install ends somewhere the kind can actually be SEEN, and the
// screen goes there. Asserted per kind because the three kinds are listed on
// three different surfaces and a single artifact-shaped test proves nothing
// about the other two.
// ---------------------------------------------------------------------------
describe("a completed install navigates to where the kind lives", () => {
  const CASES = [
    {
      kind: "agent" as const,
      zip: agentZip,
      packageName: "@acme/thing-agent",
      label: "See it in the agents list",
      href: "/agents",
    },
    {
      kind: "skill" as const,
      zip: skillZip,
      packageName: "@acme/thing-skill",
      label: "See it in the skills catalog",
      href: "/skills",
    },
    {
      kind: "artifact" as const,
      zip: artifactZip,
      packageName: "@acme/thing-artifact",
      label: "See it in installed extensions",
      href: "/configuration/extensions",
    },
  ];

  for (const testCase of CASES) {
    it(`a ${testCase.kind} package lands on ${testCase.href}`, async () => {
      actions.installSuppliedArchiveAction.mockResolvedValueOnce({
        ok: true,
        kind: testCase.kind,
        packageName: testCase.packageName,
        version: "1.0.0",
        observable: { label: testCase.label, href: testCase.href },
      } as never);

      render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
      fireEvent.change(fileInput(), { target: { files: [testCase.zip()] } });
      await waitFor(() => {
        expect(screen.getByTestId("extension-install-panel-submit")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("extension-install-panel-submit"));

      await waitFor(() => {
        expect(routerState.push).toHaveBeenCalledWith(testCase.href);
      });
      expect(toastState.error).not.toHaveBeenCalled();
    });
  }

  it("a refusal toasts and never navigates — the panel keeps the selection", async () => {
    actions.installSuppliedArchiveAction.mockResolvedValueOnce({
      ok: false,
      error: "nope",
    } as never);
    render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(fileInput(), { target: { files: [agentZip()] } });
    await waitFor(() => {
      expect(screen.getByTestId("extension-install-panel-submit")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("extension-install-panel-submit"));
    await waitFor(() => {
      expect(toastState.error).toHaveBeenCalledWith("nope");
    });
    expect(routerState.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("extension-install-panel-picker")).toBeTruthy();
  });
});
