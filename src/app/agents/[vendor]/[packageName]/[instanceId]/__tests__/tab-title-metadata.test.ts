/**
 * EVERY ID-BEARING ROUTE UNDER THE SHELL DERIVES ITS TAB FROM THE TRAIL
 * (cinatra#2934, fix leg 9).
 *
 * The ratified drawing: "The browser-tab title mirrors the resolved trail under
 * the same rules: an id-bearing route never shows a raw id in the tab."
 *
 * The measured defect was a route-level one: each route under the run exported
 * a STATIC title, so a live poll's re-render re-applied that literal over the
 * mirrored title the shell had written once. These tests read each route family
 * at its own seam — the route's `generateMetadata` — with the run resolved and
 * with the read refused, and assert the static literals are gone.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "2494bd7d-c047-4d90-a8fc-b6ae154956fc";
const PARAMS = { vendor: "acme", packageName: "blog-pipeline", instanceId: RUN_ID };

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForSession: vi.fn(async () => "member"),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
  readAgentTemplateBySlug: vi.fn(),
  readAgentRunById: vi.fn(),
  ensureRunTitle: vi.fn(),
  readAgentTemplateById: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
  resolveOrgRoleForSession: mocks.resolveOrgRoleForSession,
  signInRedirectTarget: mocks.signInRedirectTarget,
}));

vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentTemplateBySlug: mocks.readAgentTemplateBySlug,
  readAgentRunById: mocks.readAgentRunById,
  ensureRunTitle: mocks.ensureRunTitle,
  readAgentTemplateById: mocks.readAgentTemplateById,
}));

const {
  getAuthSession,
  isPlatformAdmin,
  resolveOrgRoleForSession,
  readAgentTemplateBySlug,
  readAgentRunById,
  ensureRunTitle,
} = mocks;

const SESSION = { user: { id: "user-1" }, session: { activeOrganizationId: "org-1" } };

function authorize(): void {
  getAuthSession.mockResolvedValue(SESSION);
  readAgentTemplateBySlug.mockResolvedValue({ name: "Blog Pipeline Agent" });
  readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    title: "Blog Pipeline Agent (1)",
    status: "armed",
    templateId: "tpl-1",
    runBy: "user-1",
  });
  ensureRunTitle.mockResolvedValue("Blog Pipeline Agent (1)");
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockReturnValue(false);
  resolveOrgRoleForSession.mockResolvedValue("member");
});

// The run's own page — the route the trail proof round measured.
describe("the run's own page", () => {
  it("mirrors the resolved trail instead of a static literal", async () => {
    authorize();
    const mod = await import("../page");
    expect((mod as { metadata?: unknown }).metadata).toBeUndefined();
    await expect(
      mod.generateMetadata({ params: Promise.resolve(PARAMS) }),
    ).resolves.toEqual({ title: "Blog Pipeline Agent (1)" });
  });

  it("names no id when the read is refused", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    readAgentTemplateBySlug.mockResolvedValue({ name: "Blog Pipeline Agent" });
    readAgentRunById.mockRejectedValue(new Error("forbidden"));
    const mod = await import("../page");
    const meta = await mod.generateMetadata({ params: Promise.resolve(PARAMS) });
    expect(String(meta.title)).not.toContain(RUN_ID.slice(0, 8));
    expect(meta).toEqual({ title: "Agent run" });
  });
});

// The sub-route family — one leaf word each, the trail's own.
const SUB_ROUTES: ReadonlyArray<
  [string, string, () => Promise<Record<string, unknown>>]
> = [
  ["trigger", "Schedule", () => import("../trigger/page")],
  ["results", "Results", () => import("../results/page")],
  ["data", "Data", () => import("../data/page")],
  ["permissions", "Permissions", () => import("../permissions/page")],
  ["optimization", "Optimization", () => import("../optimization/page")],
  ["skills", "Skills", () => import("../skills/page")],
];

describe.each(SUB_ROUTES)("the %s sub-route", (_subRoute, expected, load) => {
  it("mirrors the trail's leaf and exports no static title", async () => {
    authorize();
    const mod = (await load()) as {
      metadata?: unknown;
      generateMetadata: (a: unknown) => Promise<{ title: string }>;
    };
    expect((mod as { metadata?: unknown }).metadata).toBeUndefined();
    await expect(
      mod.generateMetadata({ params: Promise.resolve(PARAMS) }),
    ).resolves.toEqual({ title: expected });
  });
});

// The review page — it carried no metadata export at all, so it inherited the
// root layout's generic default and never mirrored the trail.
describe("the review page", () => {
  it("carries a title that mirrors the trail's Review leaf", async () => {
    authorize();
    const mod = await import("../review/[reviewTaskId]/page");
    await expect(
      mod.generateMetadata({
        params: Promise.resolve({ ...PARAMS, reviewTaskId: "gate-1" }),
      }),
    ).resolves.toEqual({ title: "Review" });
  });
});

// A source-level floor, so a later edit cannot quietly reintroduce the literal
// that caused the defect on any route under the run.
describe("no id-bearing route under the run keeps a static title", () => {
  it("has no `export const metadata` left in the instance route tree", () => {
    const root = path.join(
      process.cwd(),
      "src/app/agents/[vendor]/[packageName]/[instanceId]",
    );
    const files = [
      "page.tsx",
      "trigger/page.tsx",
      "results/page.tsx",
      "data/page.tsx",
      "permissions/page.tsx",
      "optimization/page.tsx",
      "skills/page.tsx",
      "review/[reviewTaskId]/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/export const metadata/);
      expect(source, file).toMatch(/export async function generateMetadata/);
    }
  });
});
