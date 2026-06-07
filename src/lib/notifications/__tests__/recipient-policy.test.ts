import { beforeEach, describe, expect, it, vi } from "vitest";

// recipient-policy.ts reaches Postgres and the project schema name through
// injected NotificationsHostAdapters. We register a mock adapter via
// `setNotificationsHostAdapters` (the /server ergonomic re-export — correct
// for NON-boot test callers). These tests cover pure routing logic + the
// resolver fallback paths; DB-backed resolution is integration-tested
// separately when a live Postgres is available.
import {
  getRecipientForJob,
  resolveRecipientToUserIds,
  topicForRecipient,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/server";

const runQueriesMock =
  vi.fn<NotificationsHostAdapters["runPostgresQueriesSync"]>();

beforeEach(() => {
  runQueriesMock.mockReset();
  runQueriesMock.mockReturnValue([{ rows: [] }]);
  setNotificationsHostAdapters({
    getPostgresConnectionString: () => "postgres://stub",
    ensurePostgresSchema: vi.fn(),
    // `postgresSchema` supplies the schema name used by
    // resolveProjectMemberUserIds.
    postgresSchema: "cinatra",
    runPostgresQueriesSync: runQueriesMock,
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in recipient-policy.test.ts");
    },
  });
});

describe("topicForRecipient", () => {
  it("formats stable, prefixed topic strings per recipient kind", () => {
    expect(topicForRecipient({ kind: "user", userId: "u-1" })).toBe("user:u-1");
    expect(topicForRecipient({ kind: "team", teamId: "t-1" })).toBe("team:t-1");
    expect(
      topicForRecipient({ kind: "organization", organizationId: "o-1" }),
    ).toBe("organization:o-1");
    expect(
      topicForRecipient({ kind: "project", projectId: "p-1" }),
    ).toBe("project:p-1");
    expect(topicForRecipient({ kind: "admins" })).toBe("admins");
  });
});

describe("getRecipientForJob", () => {
  it("routes user-launched jobs with initiatorUserId to that user", () => {
    const out = getRecipientForJob({
      jobName: "blog-post-idea-generation",
      jobData: { initiatorUserId: "u-7" },
      status: "completed",
    });
    expect(out).toEqual({ kind: "user", userId: "u-7" });
  });

  it("routes user-launched jobs with HumanUser ActorContext to that user", () => {
    const out = getRecipientForJob({
      jobName: "agent-builder-execution",
      jobData: {
        __actorContext: {
          principalType: "HumanUser",
          principalId: "u-11",
        },
      },
      status: "failed",
    });
    expect(out).toEqual({ kind: "user", userId: "u-11" });
  });

  it("does NOT route user-launched jobs without an initiator (no-spam)", () => {
    const out = getRecipientForJob({
      jobName: "skill-prefill-generation",
      jobData: {},
      status: "completed",
    });
    expect(out).toBeNull();
  });

  it("warns when a user-job without initiator fails (visibility gap signal)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = getRecipientForJob({
      jobName: "blog-post-idea-generation",
      jobData: {},
      status: "failed",
    });
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("blog-post-idea-generation");
    warnSpy.mockRestore();
  });

  it("warns when an unknown job name reaches the policy", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = getRecipientForJob({
      jobName: "totally-new-job",
      jobData: {},
      status: "completed",
    });
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown job 'totally-new-job'"),
    );
    warnSpy.mockRestore();
  });

  it("ignores non-HumanUser principals (ServiceAccount / InternalWorker / System)", () => {
    for (const principalType of [
      "ServiceAccount",
      "InternalWorker",
      "System",
      "ExternalA2AAgent",
    ]) {
      const out = getRecipientForJob({
        jobName: "blog-post-draft-generation",
        jobData: {
          __actorContext: {
            principalType,
            principalId: "x-1",
          },
        },
        status: "completed",
      });
      expect(out).toBeNull();
    }
  });

  it("system jobs: success → no notification", () => {
    for (const jobName of [
      "litellm-pricing-sync",
      "graphiti-projection-repair",
      "artifact-provider-cache-evict",
      "audit-retention-enforce",
      "registry-poll",
      "agent-run-trigger-release",
      "skill-match-batch-submit",
      "skill-match-batch-poll",
    ]) {
      const out = getRecipientForJob({
        jobName,
        jobData: {},
        status: "completed",
      });
      expect(out).toBeNull();
    }
  });

  it("system jobs: failure → admins fanout", () => {
    for (const jobName of [
      "litellm-pricing-sync",
      "graphiti-projection-repair",
      "artifact-provider-cache-evict",
      "audit-retention-enforce",
      "registry-poll",
    ]) {
      const out = getRecipientForJob({
        jobName,
        jobData: {},
        status: "failed",
      });
      expect(out).toEqual({ kind: "admins" });
    }
  });

  it("unknown jobs: never auto-notify", () => {
    const out = getRecipientForJob({
      jobName: "some-future-job",
      jobData: { initiatorUserId: "u-5" },
      status: "failed",
    });
    expect(out).toBeNull();
  });

  // -------------------------------------------------------------------------
  // `started` status (BullMQ worker.on("active") hook).
  // -------------------------------------------------------------------------

  it("started: user-init job → notify initiator (same as completed)", () => {
    const out = getRecipientForJob({
      jobName: "blog-post-idea-generation",
      jobData: { initiatorUserId: "u-7" },
      status: "started",
    });
    expect(out).toEqual({ kind: "user", userId: "u-7" });
  });

  it("started: user-init job without initiator → null (no warn for started)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = getRecipientForJob({
      jobName: "blog-post-idea-generation",
      jobData: {},
      status: "started",
    });
    expect(out).toBeNull();
    // Started gets no warning — the policy only warns when a failed terminal
    // event drops a real user notification. At active-time the absence of an
    // initiator is just "this active wasn't user-attributable", not a bug.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("started: system job → null (running notifications never go to admins)", () => {
    const out = getRecipientForJob({
      jobName: "litellm-pricing-sync",
      jobData: {},
      status: "started",
    });
    expect(out).toBeNull();
  });

  it("started: unknown job → null silently (no warn for activation)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = getRecipientForJob({
      jobName: "totally-new-job",
      jobData: {},
      status: "started",
    });
    expect(out).toBeNull();
    // The "unknown job" warning is suppressed for started so worker.on("active")
    // doesn't spam logs for every unclassified job's activation. The warning
    // still fires at terminal time (failed) where misclassification matters.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("resolveRecipientToUserIds", () => {
  it("returns the user id for {kind:user} without DB access", async () => {
    expect(
      await resolveRecipientToUserIds({ kind: "user", userId: "u-3" }),
    ).toEqual(["u-3"]);
  });

  it("returns [] when {kind:user} has empty userId", async () => {
    expect(
      await resolveRecipientToUserIds({ kind: "user", userId: "" }),
    ).toEqual([]);
  });

  it("returns [] for empty team/org/project ids (no DB query)", async () => {
    expect(
      await resolveRecipientToUserIds({ kind: "team", teamId: "" }),
    ).toEqual([]);
    expect(
      await resolveRecipientToUserIds({
        kind: "organization",
        organizationId: "",
      }),
    ).toEqual([]);
    expect(
      await resolveRecipientToUserIds({ kind: "project", projectId: "" }),
    ).toEqual([]);
  });

  it("delegates to the mocked query runner for admin / team / org / project (no rows in stub)", async () => {
    expect(await resolveRecipientToUserIds({ kind: "admins" })).toEqual([]);
    expect(
      await resolveRecipientToUserIds({ kind: "team", teamId: "t-1" }),
    ).toEqual([]);
    expect(
      await resolveRecipientToUserIds({
        kind: "organization",
        organizationId: "o-1",
      }),
    ).toEqual([]);
    expect(
      await resolveRecipientToUserIds({ kind: "project", projectId: "p-1" }),
    ).toEqual([]);
  });

  it("resolveProjectMemberUserIds uses the injected postgresSchema", async () => {
    runQueriesMock.mockReturnValueOnce([{ rows: [{ id: "u-co" }] }]);
    const out = await resolveRecipientToUserIds({
      kind: "project",
      projectId: "p-9",
    });
    expect(out).toEqual(["u-co"]);
    const calls = runQueriesMock.mock.calls;
    const lastInput = calls[calls.length - 1]![0];
    // The adapter's postgresSchema ("cinatra") is interpolated into the
    // project_co_owners query.
    expect(lastInput.queries[0]!.text).toContain(
      '"cinatra"."project_co_owners"',
    );
  });
});
