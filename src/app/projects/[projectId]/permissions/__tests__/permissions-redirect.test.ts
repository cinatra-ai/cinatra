/**
 * `/projects/[projectId]/permissions` is a PURE redirect stub since #1733
 * (the settings page absorbed the permissions surface; the teams
 * `[teamId]/dashboards` precedent):
 *   - behavior: rendering the page redirects to `/projects/{id}/settings`
 *   - purity: NO session read, gate, or data load happens before the
 *     redirect — a deleted or inaccessible project must still redirect (the
 *     settings page owns the 404-hide), never 404 from this stub
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
}));

const PAGE_SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/page.tsx",
  "utf-8",
);

describe("permissions → settings redirect stub (#1733)", () => {
  it("redirects to the project settings page", async () => {
    const { default: RedirectStub } = await import("../page");
    await expect(
      RedirectStub({ params: Promise.resolve({ projectId: "proj-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/projects/proj-1/settings");
  });

  it("encodes the id segment", async () => {
    const { default: RedirectStub } = await import("../page");
    await expect(
      RedirectStub({ params: Promise.resolve({ projectId: "p/1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/projects/p%2F1/settings");
  });

  it("stays a PURE stub — no gate or load work before the redirect", () => {
    expect(PAGE_SOURCE).not.toContain("requireAuthSession");
    expect(PAGE_SOURCE).not.toContain("getAuthSession");
    expect(PAGE_SOURCE).not.toContain("enforceResourceAccess");
    expect(PAGE_SOURCE).not.toContain("readProjectById");
    expect(PAGE_SOURCE).not.toContain("notFound");
    expect(PAGE_SOURCE).not.toContain("generateMetadata");
  });
});
