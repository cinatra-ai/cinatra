import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// service.ts lives in packages/notifications/src/service.ts and reaches Postgres through the
// injected NotificationsHostAdapters (no direct @/lib/database /
// @/lib/postgres-sync import). We register a mock adapter via
// `setNotificationsHostAdapters` (imported from the /server ergonomic
// re-export — the correct path for NON-boot test callers) in beforeEach and
// assert the SQL via the same lastSql()/lastValues() helper shape against
// the adapter's runPostgresQueriesSync mock.
import {
  countUnreadForUser,
  createBackgroundProgressNotification,
  createNotificationForRecipient,
  listNotificationsForUser,
  markAllNotificationsReadForUser,
  markNotificationReadForUser,
  markNotificationsReadByHrefPrefixForUser,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/server";

const runQueriesMock =
  vi.fn<NotificationsHostAdapters["runPostgresQueriesSync"]>();

function registerAdapter(): void {
  setNotificationsHostAdapters({
    getPostgresConnectionString: () => "postgres://stub",
    ensurePostgresSchema: vi.fn(),
    postgresSchema: "cinatra_test",
    runPostgresQueriesSync: runQueriesMock,
    // Not exercised by service.ts, but required by the adapter contract.
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in service.test.ts");
    },
  });
}

function lastSql(): string {
  const calls = runQueriesMock.mock.calls;
  const last = calls[calls.length - 1]![0];
  return last.queries[0]!.text;
}

function lastValues(): unknown[] {
  const calls = runQueriesMock.mock.calls;
  const last = calls[calls.length - 1]![0];
  return last.queries[0]!.values ?? [];
}

beforeEach(() => {
  runQueriesMock.mockReset();
  registerAdapter();
});

describe("listNotificationsForUser", () => {
  afterEach(() => {
    runQueriesMock.mockReset();
  });

  it("returns [] when userId is empty", () => {
    expect(listNotificationsForUser("")).toEqual([]);
    expect(runQueriesMock).not.toHaveBeenCalled();
  });

  it("issues a scoped SELECT and maps rows to NotificationRecord", () => {
    runQueriesMock.mockReturnValueOnce([
      {
        rows: [
          {
            id: "n-1",
            user_id: "u-1",
            recipient_kind: "user",
            recipient_id: "u-1",
            topic: "user:u-1",
            kind: "error",
            title: "Job failed",
            body: "boom",
            href: "/jobs/1",
            metadata: { tag: "x" },
            source_job_id: "j-1",
            source_job_name: "blog-post-idea-generation",
            created_at: new Date("2026-01-01T00:00:00Z"),
            read_at: null,
          },
        ],
      },
    ]);
    const records = listNotificationsForUser("u-1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "n-1",
      userId: "u-1",
      kind: "error",
      title: "Job failed",
      body: "boom",
      href: "/jobs/1",
      sourceJobId: "j-1",
      sourceJobName: "blog-post-idea-generation",
    });
    expect(records[0]!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(records[0]!.readAt).toBeUndefined();
    expect(lastSql()).toContain("WHERE user_id = $1");
    expect(lastValues()).toEqual(["u-1", 200]);
  });

  it("drops rows missing id or user_id (defensive)", () => {
    runQueriesMock.mockReturnValueOnce([
      { rows: [{ id: null, user_id: "u-1" }, { id: "n-2", user_id: null }] },
    ]);
    expect(listNotificationsForUser("u-1")).toEqual([]);
  });
});

describe("countUnreadForUser", () => {
  it("returns 0 when userId is empty", () => {
    expect(countUnreadForUser("")).toBe(0);
    expect(runQueriesMock).not.toHaveBeenCalled();
  });

  it("returns the SELECT COUNT(*) result", () => {
    runQueriesMock.mockReturnValueOnce([{ rows: [{ n: 4 }] }]);
    expect(countUnreadForUser("u-1")).toBe(4);
    expect(lastSql()).toContain("WHERE user_id = $1 AND read_at IS NULL");
  });
});

describe("createNotificationForRecipient", () => {
  it("inserts exactly one row for a {kind:user} recipient with sourceJobId dedupe", async () => {
    runQueriesMock.mockReturnValueOnce([
      {
        rows: [
          {
            id: "n-x",
            user_id: "u-1",
            recipient_kind: "user",
            recipient_id: "u-1",
            topic: "user:u-1",
            kind: "success",
            title: "Done",
            body: "ok",
          },
        ],
      },
    ]);
    const out = await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      {
        title: "Done",
        body: "ok",
        kind: "success",
        sourceJobId: "j-7",
        sourceJobName: "blog-post-idea-generation",
      },
    );
    expect(out).toHaveLength(1);
    expect(runQueriesMock).toHaveBeenCalledTimes(1);
    const sql = lastSql();
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain("ON CONFLICT (user_id, source_job_id, kind)");
    expect(sql).toContain("DO NOTHING");
    const values = lastValues();
    // params: id, user_id, recipient_kind, recipient_id, topic, kind, title,
    //         body, href, metadata, source_job_id, source_job_name, dedupe_key
    expect(values[1]).toBe("u-1");
    expect(values[2]).toBe("user");
    expect(values[4]).toBe("user:u-1");
    expect(values[5]).toBe("success");
    expect(values[10]).toBe("j-7");
    expect(values[11]).toBe("blog-post-idea-generation");
  });

  it("returns [] when ON CONFLICT swallows a duplicate insert", async () => {
    runQueriesMock.mockReturnValueOnce([{ rows: [] }]);
    const out = await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      { title: "dup", sourceJobId: "j-7" },
    );
    expect(out).toEqual([]);
  });

  it("returns [] when an admins recipient has zero matching users", async () => {
    // first call: resolveRecipientToUserIds → admins query → []
    runQueriesMock.mockReturnValueOnce([{ rows: [] }]);
    const out = await createNotificationForRecipient(
      { kind: "admins" },
      { title: "x" },
    );
    expect(out).toEqual([]);
  });

  it("autoMarkRead inlines read_at = now() in the INSERT", async () => {
    runQueriesMock.mockReturnValueOnce([
      {
        rows: [
          {
            id: "n-1",
            user_id: "u-1",
            recipient_kind: "user",
            recipient_id: "u-1",
            topic: "user:u-1",
            kind: "info",
            title: "Running",
            body: "Started.",
            read_at: new Date("2026-05-15T20:00:00Z"),
          },
        ],
      },
    ]);
    const out = await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      { title: "Running", body: "Started.", kind: "info", sourceJobId: "j-9" },
      { autoMarkRead: true },
    );
    expect(out).toHaveLength(1);
    const sql = lastSql();
    // The SQL must inline `now()` as the read_at value when autoMarkRead is on,
    // NOT a separate UPDATE statement — keeps the LISTEN/NOTIFY trigger
    // payload carrying the final read state to SSE flyout listeners on the
    // initial INSERT (drizzle-store.ts:573 has no AFTER UPDATE trigger).
    expect(sql).toContain("created_at, read_at");
    expect(sql).toContain("now(), now()");
    expect(sql).not.toContain("UPDATE");
  });

  it("default (no options) leaves read_at NULL in the INSERT", async () => {
    runQueriesMock.mockReturnValueOnce([
      {
        rows: [
          {
            id: "n-1",
            user_id: "u-1",
            recipient_kind: "user",
            recipient_id: "u-1",
            topic: "user:u-1",
            kind: "success",
            title: "Done",
            body: "ok",
          },
        ],
      },
    ]);
    await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      { title: "Done", kind: "success" },
    );
    const sql = lastSql();
    expect(sql).toContain("now(), NULL");
  });
});

// ---------------------------------------------------------------------------
// General dedupeKey (issue #50 — "notification flyout shows the same
// notification twice"). A stable dedupeKey makes repeated writes of the same
// LOGICAL notification collapse via ON CONFLICT (user_id, dedupe_key)
// DO NOTHING, so the flyout never receives two same-content rows with
// different ids.
// ---------------------------------------------------------------------------
describe("createNotificationForRecipient — general dedupeKey (issue #50)", () => {
  const insertedRow = {
    id: "n-1",
    user_id: "u-1",
    recipient_kind: "user",
    recipient_id: "u-1",
    topic: "user:u-1",
    kind: "info",
    title: "Writing files",
    body: "",
    dedupe_key: "agent-creation-progress:run-1:writing_files",
  };

  it("arbitrates on (user_id, dedupe_key) and binds the key when dedupeKey is set", async () => {
    runQueriesMock.mockReturnValueOnce([{ rows: [insertedRow] }]);
    const out = await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      {
        title: "Writing files",
        kind: "info",
        dedupeKey: "agent-creation-progress:run-1:writing_files",
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.dedupeKey).toBe(
      "agent-creation-progress:run-1:writing_files",
    );
    const sql = lastSql();
    expect(sql).toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(sql).toContain("WHERE dedupe_key IS NOT NULL AND user_id IS NOT NULL");
    expect(sql).toContain("DO NOTHING");
    // The dedupeKey row must NOT arbitrate on the legacy job index — Postgres
    // accepts exactly one conflict target per INSERT.
    expect(sql).not.toContain("ON CONFLICT (user_id, source_job_id, kind)");
    const values = lastValues();
    expect(values[12]).toBe("agent-creation-progress:run-1:writing_files");
  });

  it("keeps the legacy job conflict target and a NULL dedupe_key when dedupeKey is absent", async () => {
    runQueriesMock.mockReturnValueOnce([{ rows: [insertedRow] }]);
    await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      { title: "Done", kind: "success", sourceJobId: "j-7" },
    );
    const sql = lastSql();
    expect(sql).toContain("ON CONFLICT (user_id, source_job_id, kind)");
    expect(sql).not.toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(lastValues()[12]).toBeNull();
  });

  it("normalizes a blank dedupeKey to NULL (an empty string must never become a unique key)", async () => {
    runQueriesMock.mockReturnValueOnce([{ rows: [insertedRow] }]);
    await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      { title: "Done", kind: "success", dedupeKey: "   " },
    );
    const sql = lastSql();
    expect(sql).toContain("ON CONFLICT (user_id, source_job_id, kind)");
    expect(sql).not.toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(lastValues()[12]).toBeNull();
  });

  it("returns [] when the dedupe_key conflict swallows the duplicate write (regression: issue #50)", async () => {
    // Second write of the same logical notification: ON CONFLICT DO NOTHING
    // returns no row — no second flyout entry, no SSE trigger fire.
    runQueriesMock.mockReturnValueOnce([{ rows: [] }]);
    const out = await createNotificationForRecipient(
      { kind: "user", userId: "u-1" },
      {
        title: "Writing files",
        kind: "info",
        dedupeKey: "agent-creation-progress:run-1:writing_files",
      },
    );
    expect(out).toEqual([]);
  });
});

describe("createBackgroundProgressNotification", () => {
  it("emits an info-kind, auto-read row with metadata.progress.running", async () => {
    runQueriesMock.mockReturnValueOnce([
      {
        rows: [
          {
            id: "n-1",
            user_id: "u-1",
            recipient_kind: "user",
            recipient_id: "u-1",
            topic: "user:u-1",
            kind: "info",
            title: "Blog Post Idea Generation in progress",
            body: "Started.",
            source_job_id: "j-42",
            source_job_name: "blog-post-idea-generation",
            metadata: {
              category: "background_process",
              progress: { status: "running", jobId: "j-42" },
            },
            read_at: new Date("2026-05-15T20:00:00Z"),
          },
        ],
      },
    ]);
    const out = await createBackgroundProgressNotification({
      recipient: { kind: "user", userId: "u-1" },
      jobId: "j-42",
      jobName: "blog-post-idea-generation",
      title: "Blog Post Idea Generation in progress",
      body: "Started.",
    });
    expect(out).toHaveLength(1);
    const values = lastValues();
    // kind index is 5; metadata index is 9; source_job_id index is 10
    expect(values[5]).toBe("info");
    expect(values[10]).toBe("j-42");
    expect(values[11]).toBe("blog-post-idea-generation");
    const metadata = JSON.parse(values[9] as string) as {
      category: string;
      progress: { status: string; jobId: string; jobName: string };
    };
    expect(metadata.category).toBe("background_process");
    expect(metadata.progress.status).toBe("running");
    expect(metadata.progress.jobId).toBe("j-42");
    expect(metadata.progress.jobName).toBe("blog-post-idea-generation");
    const sql = lastSql();
    // autoMarkRead path → read_at = now() inline.
    expect(sql).toContain("now(), now()");
  });

  it("threads an optional href into the INSERT", async () => {
    runQueriesMock.mockReturnValueOnce([
      {
        rows: [
          {
            id: "n-1",
            user_id: "u-1",
            recipient_kind: "user",
            recipient_id: "u-1",
            topic: "user:u-1",
            kind: "info",
            title: "Agent run in progress",
            body: "Started.",
            href: "/agents/cinatra-ai/foo/R1",
            source_job_id: "j-99",
            read_at: new Date("2026-05-17T20:00:00Z"),
          },
        ],
      },
    ]);
    await createBackgroundProgressNotification({
      recipient: { kind: "user", userId: "u-1" },
      jobId: "j-99",
      jobName: "agent-builder-execution",
      title: "Agent run in progress",
      href: "/agents/cinatra-ai/foo/R1",
    });
    // href is param index 8.
    expect(lastValues()[8]).toBe("/agents/cinatra-ai/foo/R1");
  });
});

describe("markNotificationReadForUser", () => {
  it("UPDATE is scoped to the caller's userId AND notification id", () => {
    markNotificationReadForUser({ userId: "u-9", notificationId: "n-2" });
    expect(runQueriesMock).toHaveBeenCalledTimes(1);
    expect(lastSql()).toContain("UPDATE");
    expect(lastSql()).toContain("WHERE user_id = $1 AND id = $2");
    expect(lastValues()).toEqual(["u-9", "n-2"]);
  });

  it("no-ops when userId is empty", () => {
    markNotificationReadForUser({ userId: "", notificationId: "n-2" });
    expect(runQueriesMock).not.toHaveBeenCalled();
  });

  it("no-ops when notificationId is empty", () => {
    markNotificationReadForUser({ userId: "u-9", notificationId: "" });
    expect(runQueriesMock).not.toHaveBeenCalled();
  });
});

describe("markNotificationsReadByHrefPrefixForUser", () => {
  it("matches exact href OR href LIKE prefix/% scoped to userId", () => {
    markNotificationsReadByHrefPrefixForUser({
      userId: "u-9",
      hrefPrefix: "/jobs",
    });
    expect(runQueriesMock).toHaveBeenCalledTimes(1);
    expect(lastSql()).toContain("href = $2 OR href LIKE $3");
    expect(lastValues()).toEqual(["u-9", "/jobs", "/jobs/%"]);
  });

  it("no-ops on empty userId or empty prefix", () => {
    markNotificationsReadByHrefPrefixForUser({
      userId: "",
      hrefPrefix: "/x",
    });
    markNotificationsReadByHrefPrefixForUser({
      userId: "u-1",
      hrefPrefix: "",
    });
    expect(runQueriesMock).not.toHaveBeenCalled();
  });
});

describe("markAllNotificationsReadForUser", () => {
  it("UPDATE is scoped to the caller's unread rows only", () => {
    markAllNotificationsReadForUser("u-9");
    expect(runQueriesMock).toHaveBeenCalledTimes(1);
    expect(lastSql()).toContain("UPDATE");
    expect(lastSql()).toContain("WHERE user_id = $1 AND read_at IS NULL");
    expect(lastValues()).toEqual(["u-9"]);
  });

  it("no-ops when userId is empty", () => {
    markAllNotificationsReadForUser("");
    expect(runQueriesMock).not.toHaveBeenCalled();
  });
});
