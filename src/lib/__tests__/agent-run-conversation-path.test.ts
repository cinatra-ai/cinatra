// WHICH CONVERSATION IS THIS AGENT RUN PLAYING OUT IN (cinatra#2729).
//
// The "needs your input" notification returns the reader to the conversation
// carrying the run card, so the notifier has to resolve a run id to a `/chat`
// path. `agent_runs` has no conversation column and this lookup does not add
// one: it reads the link the chat already persists — the run card's own part
// inside the turn's content.
//
// The postgres sync leaves are mocked, so this exercises the exact query the
// resolver assembles and the path it builds, without a database. The path is
// pinned against the CHAT CODEC's own builder, so the two can never drift.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "app_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => undefined,
}));

import { buildChatPath } from "@cinatra-ai/chat/chat-path-codec";
import { findChatConversationPathForAgentRun } from "../assistant-thread-store";

const RUN_ID = "85bd2267-3f9a-4f0d-a1da-bb3a54f1a50d";
const THREAD_ID = "cc862657-cbad-4aa9-b815-36eb839510da";

function rowsOnce(rows: Array<Record<string, unknown>>) {
  runPostgresQueriesSync.mockReturnValueOnce([{ rows }]);
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
});

describe("findChatConversationPathForAgentRun", () => {
  it("asks for the turn whose persisted parts carry THIS agent run", () => {
    rowsOnce([]);

    findChatConversationPathForAgentRun(RUN_ID);

    const call = runPostgresQueriesSync.mock.calls[0]![0] as {
      queries: Array<{ text: string; values: unknown[] }>;
    };
    expect(call.queries[0]!.text).toContain("assistant_turns");
    expect(call.queries[0]!.text).toContain("assistant_threads");
    expect(call.queries[0]!.text).toContain("@>");
    expect(JSON.parse(String(call.queries[0]!.values[0]))).toEqual({
      parts: [{ name: "agent_run", runId: RUN_ID }],
    });
  });

  it("builds the bound container's path, exactly as the chat codec does", () => {
    rowsOnce([
      {
        id: THREAD_ID,
        assistant_package: "@cinatra-ai/cinatra-assistant",
        instance_id: null,
        title_slug: "draft-a-blog-post",
      },
    ]);

    expect(findChatConversationPathForAgentRun(RUN_ID)).toBe(
      buildChatPath({
        vendor: "cinatra-ai",
        slug: "cinatra-assistant",
        titleSlug: "draft-a-blog-post",
      }),
    );
  });

  it("keeps the site instance for an instance-scoped thread", () => {
    rowsOnce([
      {
        id: THREAD_ID,
        assistant_package: "@acme/site-assistant",
        instance_id: "site-3",
        title_slug: "weekly-sync",
      },
    ]);

    expect(findChatConversationPathForAgentRun(RUN_ID)).toBe(
      buildChatPath({
        vendor: "acme",
        slug: "site-assistant",
        instance: "site-3",
        titleSlug: "weekly-sync",
      }),
    );
  });

  it("addresses a thread by its id before a title slug is minted", () => {
    rowsOnce([
      {
        id: THREAD_ID,
        assistant_package: "@cinatra-ai/cinatra-assistant",
        instance_id: null,
        title_slug: null,
      },
    ]);

    expect(findChatConversationPathForAgentRun(RUN_ID)).toBe(
      buildChatPath({
        vendor: "cinatra-ai",
        slug: "cinatra-assistant",
        titleSlug: THREAD_ID,
      }),
    );
  });

  it("puts an UNBOUND thread in the implicit-default container", () => {
    rowsOnce([
      {
        id: THREAD_ID,
        assistant_package: null,
        instance_id: null,
        title_slug: "draft-a-blog-post",
      },
    ]);

    expect(findChatConversationPathForAgentRun(RUN_ID)).toBe(
      buildChatPath({
        vendor: "cinatra-ai",
        slug: "cinatra-assistant",
        titleSlug: "draft-a-blog-post",
      }),
    );
  });

  it("returns null when no conversation carries the run", () => {
    rowsOnce([]);

    expect(findChatConversationPathForAgentRun(RUN_ID)).toBeNull();
  });

  it("returns null for an empty run id, without asking the store", () => {
    expect(findChatConversationPathForAgentRun("  ")).toBeNull();
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("returns null when the store cannot answer", () => {
    runPostgresQueriesSync.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    expect(findChatConversationPathForAgentRun(RUN_ID)).toBeNull();
  });
});
