// @vitest-environment jsdom
/**
 * THE CONSENT QUESTION ON THE SCREEN, ON BOTH SUPPLIED ROADS
 * (cinatra#3204 leg 3 — the issue's recorded decision on consent parity).
 *
 * "Consent is an explicit act, never inferred from supplying a package." An
 * operator who hands over a skill package is shown the closure and the
 * data-egress advisory and ticks a box that starts OFF; the install carries
 * whatever the box says, and nothing else.
 *
 * The two negative claims matter as much as the positive one: with the
 * workspace opt-in OFF nothing can egress, so the box is not shown at all
 * (asking would be misleading); and a kind the Skills API never uploads is
 * never asked.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createZipBuffer } from "../zip-helpers";

const routerState = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerState.push }) }));

const PROMPT = {
  headline: "Allow Anthropic uploads for @acme/thing-skill?",
  advisory: "The skill files leave this instance.",
  closureLines: ["@acme/thing-skill (local:@acme/thing-skill)"],
  closureDigest: "d".repeat(64),
  consentApplies: true,
};

const actions = vi.hoisted(() => ({
  installSuppliedArchiveAction: vi.fn(async () => ({
    ok: true as const,
    kind: "skill" as const,
    packageName: "@acme/thing-skill",
    version: "1.0.0",
    observable: { label: "See it in the skills catalog", href: "/skills" },
    uploadConsent: { granted: false, reason: "no-explicit-consent", outcome: "…" },
  })),
  readSuppliedUploadConsentPromptAction: vi.fn(async () => null as unknown),
  installSuppliedRepositoryAction: vi.fn(),
  previewSuppliedRepositoryAction: vi.fn(),
  readGitHubUploadPreconditionAction: vi.fn(async () => ({ state: "ready" as const })),
}));
vi.mock("../supplied-install-actions", () => actions);

const toastState = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: toastState }));

import { ImportAgentForm } from "../import-form";
import { ImportPackageFromGitHubForm } from "../import-skill-from-github-form";

const INSTALL_SCOPE = {
  installTargets: [
    { value: "workspace", label: "Workspace: All", level: "workspace" as const, id: "org-1", disabled: false },
    { value: "org:org-1", label: "Acme", level: "organization" as const, id: "org-1", disabled: false },
  ],
  ownerEntityNames: { "org:org-1": "Acme" },
  activeOrgId: "org-1",
  availability: { state: "ready" as const, defaultValue: "workspace" },
};

function skillZip(): File {
  const buf = createZipBuffer([
    {
      name: "package.json",
      content: JSON.stringify({
        name: "@acme/thing-skill",
        version: "1.0.0",
        cinatra: { kind: "skill" },
      }),
    },
    { name: "skills/thing/SKILL.md", content: "# thing" },
  ]);
  return new File([new Uint8Array(buf)], "skill.zip", { type: "application/zip" });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input as HTMLInputElement;
}

async function supplySkillArchive() {
  render(<ImportAgentForm installScope={INSTALL_SCOPE} />);
  fireEvent.change(fileInput(), { target: { files: [skillZip()] } });
  await waitFor(() => expect(screen.getByTestId("upload-install-scope")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  actions.readSuppliedUploadConsentPromptAction.mockResolvedValue(null as never);
});

describe("the File tab asks for upload consent, explicitly and default-off", () => {
  it("shows the closure and the advisory, with the box unticked", async () => {
    actions.readSuppliedUploadConsentPromptAction.mockResolvedValue(PROMPT as never);
    await supplySkillArchive();

    await waitFor(() =>
      expect(screen.getByTestId("supplied-upload-consent")).toBeTruthy(),
    );
    expect(screen.getByText(PROMPT.advisory)).toBeTruthy();
    expect(screen.getByText(PROMPT.closureLines[0]!)).toBeTruthy();
    const box = screen.getByTestId("supplied-upload-consent-checkbox");
    expect(box.getAttribute("data-state")).toBe("unchecked");
  });

  it("installs with NO consent when the box is left alone", async () => {
    actions.readSuppliedUploadConsentPromptAction.mockResolvedValue(PROMPT as never);
    await supplySkillArchive();
    await waitFor(() => expect(screen.getByTestId("supplied-upload-consent")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /install now/i }));

    await waitFor(() => expect(actions.installSuppliedArchiveAction).toHaveBeenCalled());
    const arg = (actions.installSuppliedArchiveAction.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(arg.anthropicUploadConsent).toBeUndefined();
  });

  it("carries the explicit consent AND the digest of what was shown when ticked", async () => {
    actions.readSuppliedUploadConsentPromptAction.mockResolvedValue(PROMPT as never);
    await supplySkillArchive();
    await waitFor(() => expect(screen.getByTestId("supplied-upload-consent")).toBeTruthy());

    fireEvent.click(screen.getByTestId("supplied-upload-consent-checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /install now/i }));

    await waitFor(() => expect(actions.installSuppliedArchiveAction).toHaveBeenCalled());
    const arg = (actions.installSuppliedArchiveAction.mock.calls as unknown as unknown[][])[0]![0] as {
      anthropicUploadConsent?: { granted?: unknown; confirmedClosureDigest?: unknown };
    };
    expect(arg.anthropicUploadConsent).toEqual({
      granted: true,
      confirmedClosureDigest: PROMPT.closureDigest,
    });
  });

  it("asks nothing when the workspace opt-in is OFF — nothing can egress", async () => {
    actions.readSuppliedUploadConsentPromptAction.mockResolvedValue({
      ...PROMPT,
      consentApplies: false,
    } as never);
    await supplySkillArchive();

    await waitFor(() => expect(screen.getByTestId("upload-install-scope")).toBeTruthy());
    expect(screen.queryByTestId("supplied-upload-consent")).toBeNull();
  });
});

describe("the GitHub tab asks the same question the same way", () => {
  it("renders the consent block from the preview and carries the tick", async () => {
    actions.previewSuppliedRepositoryAction.mockResolvedValue({
      ok: true,
      preview: {
        kind: "skill",
        packageName: "@acme/thing-skill",
        version: "1.0.0",
        contentDigest: "a".repeat(64),
        resolvedSha: "c".repeat(40),
        repo: "acme/thing",
        ref: "main",
        consentPrompt: PROMPT,
      },
    } as never);
    actions.installSuppliedRepositoryAction.mockResolvedValue({
      ok: true,
      kind: "skill",
      packageName: "@acme/thing-skill",
      version: "1.0.0",
      observable: { label: "See it in the skills catalog", href: "/skills" },
    } as never);

    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        precondition={{ state: "ready" }}
      />,
    );
    fireEvent.change(screen.getByLabelText(/repository url/i), {
      target: { value: "https://github.com/acme/thing" },
    });
    fireEvent.click(screen.getByTestId("github-upload-submit"));

    await waitFor(() => expect(screen.getByTestId("supplied-upload-consent")).toBeTruthy());
    expect(screen.getByTestId("supplied-upload-consent-checkbox").getAttribute("data-state")).toBe(
      "unchecked",
    );

    fireEvent.click(screen.getByTestId("supplied-upload-consent-checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /install now/i }));

    await waitFor(() => expect(actions.installSuppliedRepositoryAction).toHaveBeenCalled());
    const arg = (actions.installSuppliedRepositoryAction.mock.calls as unknown as unknown[][])[0]![0] as {
      anthropicUploadConsent?: unknown;
    };
    expect(arg.anthropicUploadConsent).toEqual({
      granted: true,
      confirmedClosureDigest: PROMPT.closureDigest,
    });
  });
});
