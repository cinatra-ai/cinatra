// @vitest-environment jsdom
// OrganizationArchiveDangerForm (cinatra#1942 V5) — the archive-mode name
// confirmation arming, direct component coverage (not stubbed away, unlike
// organization-manage-panel.test.tsx / organization-settings.test.tsx which
// stub this component to test composition instead).
//
// Locks the CodeRabbit-flagged gap on PR #2273: `orgName` can be "" (the
// settings screen falls back to `org.name ?? ""`), and without a non-empty
// guard `confirmName === orgName === ""` arms the destructive Archive button
// with zero typing. `armed` must require `orgName.length > 0` in addition to
// the match.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../../screens/organization-manage-actions", () => ({
  archiveOrganizationAction: vi.fn(),
  unarchiveOrganizationAction: vi.fn(),
}));

import { OrganizationArchiveDangerForm } from "../organization-archive-danger-form";

afterEach(() => cleanup());

describe("OrganizationArchiveDangerForm — archive mode arming", () => {
  test("empty orgName: the Archive button stays disabled with zero typing (the planted gap)", () => {
    render(
      <OrganizationArchiveDangerForm
        organizationId="org_1"
        orgName=""
        mode="archive"
      />,
    );
    const button = screen.getByRole("button", { name: "Archive organization" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("empty orgName: still disabled even if the confirm field somehow holds an empty-string match", () => {
    render(
      <OrganizationArchiveDangerForm
        organizationId="org_1"
        orgName=""
        mode="archive"
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    const button = screen.getByRole("button", { name: "Archive organization" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("non-empty orgName: disabled before typing, enabled once the typed name matches exactly", () => {
    render(
      <OrganizationArchiveDangerForm
        organizationId="org_1"
        orgName="Acme Inc"
        mode="archive"
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Archive organization" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Acme In" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Acme Inc" } });
    expect(button.disabled).toBe(false);
  });
});

describe("OrganizationArchiveDangerForm — unarchive mode", () => {
  test("no name-confirmation surface: the Unarchive button is enabled with no typing (recovery stays easy, by design)", () => {
    render(
      <OrganizationArchiveDangerForm
        organizationId="org_1"
        orgName=""
        mode="unarchive"
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    const button = screen.getByRole("button", { name: "Unarchive organization" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
