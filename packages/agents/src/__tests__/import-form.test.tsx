// @vitest-environment jsdom
/**
 * ImportAgentForm state-machine coverage (cinatra#2643 review round).
 *
 * Locks the upload form's picker/preview/cancel behaviour:
 *   1. Initial state: the "Select an extension package" picker renders;
 *      no Cancel button; Upload disabled.
 *   2. Selecting a valid archive HIDES the picker, shows the parsed preview
 *      (agent name from the OAS document), enables Upload, and shows Cancel.
 *   3. The preview carries NO "draft" status pill and the form has NO
 *      "Configure ownership (advanced)" disclosure (both removed).
 *   4. Cancel resets to the picker state: picker back, preview gone,
 *      Cancel gone, name override cleared.
 *   5. An invalid archive surfaces the parse error and keeps Upload disabled.
 *
 * The REAL dropzone, upload-archive parser, and zip-helpers run; only the
 * server action, router, toast, and heavy sibling components are mocked —
 * so a selected file exercises the genuine parse path on a genuine ZIP.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/import-form.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createZipBuffer } from "../zip-helpers";

const routerState = vi.hoisted(() => ({
  push: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push }),
}));

vi.mock("../import-export-actions", () => ({
  importAgentTemplate: vi.fn(async () => ({
    templateId: "t-1",
    upserted: false,
    warnings: [],
  })),
}));

vi.mock("@cinatra-ai/extensions/components/license-warning-dialog", () => ({
  LicenseWarningDialog: () => null,
}));

vi.mock("@/components/access-combobox", () => ({
  AccessCombobox: () => null,
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { ImportAgentForm } from "../import-form";

const OAS_FLOW = JSON.stringify({
  component_type: "Flow",
  agentspec_version: "26.1.0",
  name: "State Machine Agent",
  description: "form state fixture",
});

function zipFile(entries: { name: string; content: string }[], fileName = "fixture.zip"): File {
  const buf = createZipBuffer(entries);
  return new File([new Uint8Array(buf)], fileName, { type: "application/zip" });
}

function standardZip(): File {
  return zipFile([
    {
      name: "slug/package.json",
      content: JSON.stringify({
        name: "@cinatra-ai/state-machine-agent",
        version: "1.0.0",
        license: "MIT",
        cinatra: { kind: "agent", entrypoint: "cinatra/oas.json" },
      }),
    },
    { name: "slug/cinatra/oas.json", content: OAS_FLOW },
  ]);
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

describe("ImportAgentForm — picker / preview / cancel state machine", () => {
  it("renders the picker initially, with no Cancel and a disabled Upload", () => {
    render(<ImportAgentForm />);
    expect(screen.getByText("Select an extension package")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Upload (.zip)" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("hides the picker after selecting a file, shows the parsed preview + Cancel, enables Upload", async () => {
    render(<ImportAgentForm />);
    fireEvent.change(fileInput(), { target: { files: [standardZip()] } });

    await waitFor(() => {
      expect(screen.getByText("State Machine Agent")).toBeTruthy();
    });
    expect(screen.queryByText("Select an extension package")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Upload (.zip)" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows no draft pill and no ownership disclosure on a parsed file", async () => {
    render(<ImportAgentForm />);
    fireEvent.change(fileInput(), { target: { files: [standardZip()] } });
    await waitFor(() => {
      expect(screen.getByText("State Machine Agent")).toBeTruthy();
    });
    expect(screen.queryByText("draft")).toBeNull();
    expect(screen.queryByText(/Configure ownership/)).toBeNull();
  });

  it("Cancel returns to the picker state and clears the name override", async () => {
    render(<ImportAgentForm />);
    fireEvent.change(fileInput(), { target: { files: [standardZip()] } });
    await waitFor(() => {
      expect(screen.getByText("State Machine Agent")).toBeTruthy();
    });

    const nameOverride = screen.getByLabelText(/Name override/) as HTMLInputElement;
    fireEvent.change(nameOverride, { target: { value: "Renamed" } });
    expect(nameOverride.value).toBe("Renamed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByText("Select an extension package")).toBeTruthy();
    });
    expect(screen.queryByText("State Machine Agent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // The name override field only renders with a preview; after cancel it is
    // gone, and re-selecting starts from a cleared value.
    expect(screen.queryByLabelText(/Name override/)).toBeNull();
    fireEvent.change(fileInput(), { target: { files: [standardZip()] } });
    await waitFor(() => {
      expect(screen.getByText("State Machine Agent")).toBeTruthy();
    });
    expect((screen.getByLabelText(/Name override/) as HTMLInputElement).value).toBe("");
  });

  it("surfaces a parse error for an invalid archive and keeps Upload disabled", async () => {
    render(<ImportAgentForm />);
    fireEvent.change(fileInput(), {
      target: { files: [zipFile([{ name: "README.md", content: "hi" }], "not-an-agent.zip")] },
    });
    await waitFor(() => {
      expect(screen.getByText(/no agent definition found/)).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: "Upload (.zip)" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
