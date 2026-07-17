// @vitest-environment jsdom
// Publisher-island contract for the crumb-contributions bus (cinatra#1737):
// pins the epoch-capture guard — entries delivered by a server render are
// published only under the epoch they arrived with; an epoch-context change
// alone (the router cache re-using a page rendered under a previous
// session/org while the root layout re-renders) must NOT republish them into
// the new scope. Fresh entries re-arm the guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/teams/team-1",
}));

import { CrumbContributions } from "../crumb-contributions";
import { CrumbEpochProvider } from "../crumb-epoch-context";
import {
  clearCrumbContributions,
  getCrumbSnapshot,
} from "@/lib/breadcrumb-contributions";

function island(epoch: string, label: string) {
  return (
    <CrumbEpochProvider value={epoch}>
      <CrumbContributions entries={[{ prefix: "/teams/team-1", label }]} />
    </CrumbEpochProvider>
  );
}

describe("CrumbContributions epoch-capture guard", () => {
  beforeEach(() => {
    clearCrumbContributions();
  });

  it("publishes entries under the epoch they were delivered with", () => {
    render(island("user-1:org-a", "Best Team Ever"));
    const snap = getCrumbSnapshot();
    expect(snap?.epoch).toBe("user-1:org-a");
    expect(snap?.entries[0]?.label).toBe("Best Team Ever");
  });

  it("does NOT republish unchanged entries when only the epoch changes (cached page under a new scope)", () => {
    const { rerender } = render(island("user-1:org-a", "Best Team Ever"));
    rerender(island("user-1:org-b", "Best Team Ever"));
    // The parked snapshot stays fenced to the epoch that authorized it — the
    // selector discards it under org-b; nothing was republished.
    expect(getCrumbSnapshot()?.epoch).toBe("user-1:org-a");
  });

  it("re-arms on fresh entries: a new server pass under the new epoch publishes", () => {
    const { rerender } = render(island("user-1:org-a", "Best Team Ever"));
    rerender(island("user-1:org-b", "Renamed By Fresh Render"));
    const snap = getCrumbSnapshot();
    expect(snap?.epoch).toBe("user-1:org-b");
    expect(snap?.entries[0]?.label).toBe("Renamed By Fresh Render");
  });
});
