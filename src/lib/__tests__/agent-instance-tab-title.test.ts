/**
 * THE TAB TITLE MIRRORS THE RESOLVED TRAIL (cinatra#2934, fix leg 9).
 *
 * The ratified drawing: "The browser-tab title mirrors the resolved trail under
 * the same rules: an id-bearing route never shows a raw id in the tab."
 *
 * The measured defect these tests close: on the run's own page the trail read
 * "Agents > Blog Pipeline Agent (1)" while the tab held the route file's static
 * literal. The title is now derived on the server from the same trail builder,
 * so this suite asserts the derivation itself — a resolved run name versus an
 * id — and the gate-repeating read that feeds it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_INSTANCE_GENERIC_TAB_TITLE,
  agentInstancePathname,
  agentInstanceTabTitle,
  resolveAgentInstanceMetadata,
} from "../agent-instance-tab-title";

const RUN_ID = "2494bd7d-c047-4d90-a8fc-b6ae154956fc";
const BASE = { vendor: "acme", packageName: "blog-pipeline", instanceId: RUN_ID };

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

const SESSION = {
  user: { id: "user-1" },
  session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockReturnValue(false);
  resolveOrgRoleForSession.mockResolvedValue("member");
});

describe("agentInstancePathname", () => {
  it("is the run's own path, and the sub-route path when a sub-route is given", () => {
    expect(agentInstancePathname(BASE)).toBe(
      `/agents/acme/blog-pipeline/${RUN_ID}`,
    );
    expect(agentInstancePathname({ ...BASE, subRoute: "trigger" })).toBe(
      `/agents/acme/blog-pipeline/${RUN_ID}/trigger`,
    );
  });
});

describe("agentInstanceTabTitle — the tab is the trail's resolved leaf", () => {
  it("is the RESOLVED run name on the run's own page (the measured defect)", () => {
    expect(
      agentInstanceTabTitle({
        ...BASE,
        resolvedInstanceLabel: "Blog Pipeline Agent (1)",
      }),
    ).toBe("Blog Pipeline Agent (1)");
  });

  it("never shows the raw id when nothing resolved — it names the kind, as the trail does", () => {
    const title = agentInstanceTabTitle(BASE);
    expect(title).toBe(AGENT_INSTANCE_GENERIC_TAB_TITLE);
    expect(title).not.toContain(RUN_ID);
    expect(title).not.toContain(RUN_ID.slice(0, 8));
  });

  it("rejects an identifying label — a truncated id is still an id", () => {
    const title = agentInstanceTabTitle({
      ...BASE,
      resolvedInstanceLabel: `${RUN_ID.slice(0, 8)}…`,
    });
    expect(title).toBe(AGENT_INSTANCE_GENERIC_TAB_TITLE);
    expect(title).not.toContain(RUN_ID.slice(0, 8));
  });

  it("is the sub-route's own word on a sub-route, matching the trail's leaf", () => {
    // The schedule surface answers at /trigger and the trail says Schedule
    // (cinatra#3004), so the tab says Schedule too.
    expect(
      agentInstanceTabTitle({
        ...BASE,
        subRoute: "trigger",
        resolvedInstanceLabel: "Blog Pipeline Agent (1)",
      }),
    ).toBe("Schedule");
    expect(agentInstanceTabTitle({ ...BASE, subRoute: "results" })).toBe("Results");
    expect(agentInstanceTabTitle({ ...BASE, subRoute: "review" })).toBe("Review");
    expect(agentInstanceTabTitle({ ...BASE, subRoute: "skills" })).toBe("Skills");
  });
});

describe("resolveAgentInstanceMetadata — the gate-repeating read", () => {
  it("discloses the resolved run name to an authorized reader", async () => {
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

    await expect(resolveAgentInstanceMetadata(BASE)).resolves.toEqual({
      title: "Blog Pipeline Agent (1)",
    });
    expect(readAgentRunById).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({ actorOrganizationId: "org-1" }),
    );
  });

  it("falls back to the template name for a pre-run instance (no auto-name yet)", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    readAgentTemplateBySlug.mockResolvedValue({ name: "Blog Pipeline Agent" });
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      title: null,
      status: "pending_input",
      templateId: "tpl-1",
      runBy: "user-1",
    });

    await expect(resolveAgentInstanceMetadata(BASE)).resolves.toEqual({
      title: "Blog Pipeline Agent",
    });
    expect(ensureRunTitle).not.toHaveBeenCalled();
  });

  it("answers the generic title on a refusal, and names no id", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    readAgentTemplateBySlug.mockResolvedValue({ name: "Blog Pipeline Agent" });
    readAgentRunById.mockRejectedValue(
      Object.assign(new Error("forbidden"), { statusCode: 403 }),
    );

    const meta = await resolveAgentInstanceMetadata(BASE);
    expect(meta).toEqual({ title: AGENT_INSTANCE_GENERIC_TAB_TITLE });
    expect(String(meta.title)).not.toContain(RUN_ID.slice(0, 8));
  });

  it("answers the generic title with no session, and reads no run", async () => {
    getAuthSession.mockResolvedValue(null);
    await expect(resolveAgentInstanceMetadata(BASE)).resolves.toEqual({
      title: AGENT_INSTANCE_GENERIC_TAB_TITLE,
    });
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("reads no run data for a sub-route — its leaf is the sub-route's own word", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    await expect(
      resolveAgentInstanceMetadata({ ...BASE, subRoute: "review" }),
    ).resolves.toEqual({ title: "Review" });
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("reads no run for the creation route", async () => {
    await expect(
      resolveAgentInstanceMetadata({ ...BASE, instanceId: "new" }),
    ).resolves.toEqual({ title: "New" });
    expect(readAgentRunById).not.toHaveBeenCalled();
  });
});

/**
 * A TAB READ NEVER WRITES (convergence round of fix leg 9).
 *
 * The first cut of this helper repeated the run screen's auto-naming call, and
 * that call PERSISTS a numbered name. Metadata runs on every request - including
 * one whose page then answers not-found, and concurrently with the page render
 * that does the naming itself - so a tab read could consume a numbered slot for
 * a page nobody ever saw, and two writers could race over one run's name. The
 * tab reads what is already there; the run screen remains the one place a run is
 * named.
 */
describe("resolveAgentInstanceMetadata never names the run", () => {
  it("names a started but unnamed run by its template and writes nothing", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    readAgentTemplateBySlug.mockResolvedValue({ name: "Blog Pipeline Agent" });
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      title: null,
      status: "running",
      templateId: "tpl-1",
      runBy: "user-1",
    });
    ensureRunTitle.mockResolvedValue("Blog Pipeline Agent (7)");

    await expect(resolveAgentInstanceMetadata(BASE)).resolves.toEqual({
      title: "Blog Pipeline Agent",
    });
    expect(ensureRunTitle).not.toHaveBeenCalled();
  });

  it("prefers the run's persisted name over the template's, and still writes nothing", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    readAgentTemplateBySlug.mockResolvedValue({ name: "Blog Pipeline Agent" });
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      title: "Blog Pipeline Agent (2)",
      status: "completed",
      templateId: "tpl-1",
      runBy: "user-1",
    });

    await expect(resolveAgentInstanceMetadata(BASE)).resolves.toEqual({
      title: "Blog Pipeline Agent (2)",
    });
    expect(ensureRunTitle).not.toHaveBeenCalled();
  });
});
