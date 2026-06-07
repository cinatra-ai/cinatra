import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock both the session helper and the notifications wrapper. The route's
// only job is auth + delegation.
const getAuthSessionMock = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSessionMock(),
}));

const listNotificationsMock = vi.fn();
const markAllMock = vi.fn();
const markReadMock = vi.fn();
const markByHrefMock = vi.fn();
vi.mock("@/lib/notifications", () => ({
  listNotifications: () => listNotificationsMock(),
  markAllNotificationsRead: () => markAllMock(),
  markNotificationRead: (id: string) => markReadMock(id),
  markNotificationsReadByHrefPrefix: (h: string) => markByHrefMock(h),
}));

import { GET, PATCH } from "../route";

beforeEach(() => {
  getAuthSessionMock.mockReset();
  listNotificationsMock.mockReset();
  markAllMock.mockReset();
  markReadMock.mockReset();
  markByHrefMock.mockReset();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/notifications", () => {
  it("returns 401 when no session", async () => {
    getAuthSessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listNotificationsMock).not.toHaveBeenCalled();
  });

  it("returns 401 when session has no user.id", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "" } });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 200 with notifications when authenticated and no `processes` field", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    listNotificationsMock.mockResolvedValue([
      {
        id: "n-1",
        title: "Hi",
        body: "",
        kind: "success",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.notifications).toHaveLength(1);
    // The empty `processes:[]` stub is gone. In-progress background tasks live
    // in the `notifications` array with `metadata.category = "background_process"`.
    expect(json).not.toHaveProperty("processes");
  });

  it("surfaces sourceJobId/sourceJobName/metadata on the GET shape", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    listNotificationsMock.mockResolvedValue([
      {
        id: "n-1",
        title: "Blog post draft generation in progress",
        body: "Started.",
        kind: "info",
        sourceJobId: "job-77",
        sourceJobName: "blog-post-draft-generation",
        metadata: {
          category: "background_process",
          progress: {
            status: "running",
            jobId: "job-77",
            jobName: "blog-post-draft-generation",
            startedAt: "2026-05-15T20:00:00Z",
          },
        },
        createdAt: "2026-05-15T20:00:00Z",
      },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.notifications[0].sourceJobId).toBe("job-77");
    expect(json.notifications[0].sourceJobName).toBe("blog-post-draft-generation");
    expect(json.notifications[0].metadata.category).toBe("background_process");
    expect(json.notifications[0].metadata.progress.status).toBe("running");
    expect(json.notifications[0].kind).toBe("info");
  });
});

describe("PATCH /api/notifications", () => {
  function buildRequest(body: unknown): Request {
    return new Request("http://test/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when no session, regardless of payload", async () => {
    getAuthSessionMock.mockResolvedValue(null);
    const res = await PATCH(buildRequest({ all: true }));
    expect(res.status).toBe(401);
    expect(markAllMock).not.toHaveBeenCalled();
  });

  it("delegates mark-all when {all:true}", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    const res = await PATCH(buildRequest({ all: true }));
    expect(res.status).toBe(200);
    expect(markAllMock).toHaveBeenCalledTimes(1);
  });

  it("delegates mark-by-id when {id}", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    const res = await PATCH(buildRequest({ id: "n-7" }));
    expect(res.status).toBe(200);
    expect(markReadMock).toHaveBeenCalledWith("n-7");
  });

  it("delegates mark-by-href when {href}", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    const res = await PATCH(buildRequest({ href: "/jobs" }));
    expect(res.status).toBe(200);
    expect(markByHrefMock).toHaveBeenCalledWith("/jobs");
  });

  it("returns 400 when payload has no actionable fields", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    const res = await PATCH(buildRequest({}));
    expect(res.status).toBe(400);
  });
});
