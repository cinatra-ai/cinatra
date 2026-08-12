/**
 * The parent-session leaf (cinatra#2684).
 *
 * Two questions and nothing else: is the Better Auth session a widget row was
 * minted under still signed in, and — when it ends — which rows go with it. Both
 * answers are security decisions, so the tests here are as much about the SHAPE
 * of the statement as about the boolean: a liveness read that forgot its expiry
 * clause, or a cascade that deleted by user instead of by session, would still
 * return the right answer to most callers most of the time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runPostgresQueriesSyncMock, ensureSchemaMock } = vi.hoisted(() => ({
  runPostgresQueriesSyncMock: vi.fn(),
  ensureSchemaMock: vi.fn(),
}));

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: ensureSchemaMock }));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPostgresQueriesSyncMock,
  quotePostgresIdentifier: (v: string) => `"${v.replaceAll('"', '""')}"`,
}));

import {
  isWidgetAuthSessionId,
  normalizeWidgetAuthSessionId,
  readWidgetAuthSessionLiveness,
  readWidgetTokenParentLiveness,
  widgetAuthSessionIsLive,
} from "@/lib/widget-session-binding";

type Query = { text: string; values?: unknown[] };

function lastCall(): { queries: Query[]; transaction?: boolean } {
  const calls = runPostgresQueriesSyncMock.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  runPostgresQueriesSyncMock.mockImplementation((input: { queries: Query[] }) =>
    input.queries.map(() => ({ rows: [], rowCount: 0 })),
  );
});

describe("what counts as a session id", () => {
  it("accepts a plain id and normalizes surrounding space", () => {
    expect(isWidgetAuthSessionId("sess-1")).toBe(true);
    expect(normalizeWidgetAuthSessionId("  sess-1  ")).toBe("sess-1");
  });

  it("rejects everything that is not one: blank, whitespace, oversized, non-strings", () => {
    for (const bad of ["", "   ", "x".repeat(256), null, undefined, 7, {}, []]) {
      expect(isWidgetAuthSessionId(bad), String(bad)).toBe(false);
      expect(normalizeWidgetAuthSessionId(bad)).toBe("");
    }
  });
});

describe("widgetAuthSessionIsLive", () => {
  it("is true only while a row with that id exists", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [{ alive: 1 }], rowCount: 1 }]);
    expect(widgetAuthSessionIsLive("sess-1")).toBe(true);

    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(widgetAuthSessionIsLive("sess-1")).toBe(false);
  });

  it("asks Better Auth's own table, by id, and refuses an EXPIRED session", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [{ alive: 1 }], rowCount: 1 }]);
    widgetAuthSessionIsLive("sess-1");
    const [q] = lastCall().queries;
    expect(q.text).toContain('"public"."session"');
    expect(q.text).toContain("WHERE id = $1");
    // The expiry half is load-bearing: an expired session is a signed-out
    // person, and the comparison must happen where the value lives so no node's
    // clock enters it.
    expect(q.text).toContain('"expiresAt" > now()');
    expect(q.values).toEqual(["sess-1"]);
  });

  it("refuses an unusable id WITHOUT touching the database", () => {
    for (const bad of ["", "   ", null, undefined, "x".repeat(256)]) {
      expect(widgetAuthSessionIsLive(bad)).toBe(false);
    }
    expect(runPostgresQueriesSyncMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on any store failure — false, never a throw", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error('relation "session" does not exist');
    });
    expect(() => widgetAuthSessionIsLive("sess-1")).not.toThrow();
    expect(widgetAuthSessionIsLive("sess-1")).toBe(false);
  });
});

// codex round 0, finding 4. "The session is gone" and "I could not find out"
// must refuse alike and be told apart, because only one of them is a reason to
// destroy the widget row. A two-second store hiccup must not sign people out.
describe("readWidgetAuthSessionLiveness — three answers, not two", () => {
  it("live for a present unexpired row, dead for none, unknown for a store failure", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [{ alive: 1 }], rowCount: 1 }]);
    expect(readWidgetAuthSessionLiveness("sess-1")).toBe("live");

    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(readWidgetAuthSessionLiveness("sess-1")).toBe("dead");

    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error("connection terminated");
    });
    expect(readWidgetAuthSessionLiveness("sess-1")).toBe("unknown");
  });

  it("an unusable id is DEAD, not unknown — a row naming no session never can", () => {
    // Nothing indeterminate about it, so reaping such a row is correct.
    for (const bad of ["", "  ", null, undefined]) {
      expect(readWidgetAuthSessionLiveness(bad)).toBe("dead");
    }
    expect(runPostgresQueriesSyncMock).not.toHaveBeenCalled();
  });

  it("the boolean form refuses on BOTH dead and unknown", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(widgetAuthSessionIsLive("sess-1")).toBe(false);
    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error("down");
    });
    expect(widgetAuthSessionIsLive("sess-1")).toBe(false);
  });
});

// The jti-keyed form, for credentials that cannot present the bearer: the
// capture capability, the review island, and the run-bound chat resume token.
describe("readWidgetTokenParentLiveness — from a jti alone", () => {
  it("reads the session named on the row, then asks the same question about it", () => {
    runPostgresQueriesSyncMock
      .mockReturnValueOnce([{ rows: [{ auth_session_id: "sess-1" }], rowCount: 1 }])
      .mockReturnValueOnce([{ rows: [{ alive: 1 }], rowCount: 1 }]);
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("live");

    const [rowRead] = runPostgresQueriesSyncMock.mock.calls[0][0].queries;
    expect(rowRead.text).toContain("widget_user_tokens");
    expect(rowRead.text).toContain("WHERE jti = $1");
    // Expiry is part of the row read: an expired parent is a dead parent.
    expect(rowRead.text).toContain("expires_at > now()");
    expect(rowRead.values).toEqual(["jti-1"]);
  });

  it("DEAD when the row is gone, expired, or names no session", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("dead");

    runPostgresQueriesSyncMock.mockReturnValue([
      { rows: [{ auth_session_id: null }], rowCount: 1 },
    ]);
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("dead");
  });

  it("DEAD for an absent or oversized jti, without touching the database", () => {
    for (const bad of ["", "  ", null, "x".repeat(129)]) {
      expect(readWidgetTokenParentLiveness(bad)).toBe("dead");
    }
    expect(runPostgresQueriesSyncMock).not.toHaveBeenCalled();
  });

  it("UNKNOWN — never a throw — when the row read itself fails", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error("store down");
    });
    expect(() => readWidgetTokenParentLiveness("jti-1")).not.toThrow();
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("unknown");
  });
});

// codex round 0, finding 4. "The session is gone" and "I could not find out"
// must refuse alike and be told apart, because only one of them is a reason to
// destroy the widget row. A two-second store hiccup must not sign people out.
describe("readWidgetAuthSessionLiveness — three answers, not two", () => {
  it("live for a present unexpired row, dead for none, unknown for a store failure", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [{ alive: 1 }], rowCount: 1 }]);
    expect(readWidgetAuthSessionLiveness("sess-1")).toBe("live");

    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(readWidgetAuthSessionLiveness("sess-1")).toBe("dead");

    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error("connection terminated");
    });
    expect(readWidgetAuthSessionLiveness("sess-1")).toBe("unknown");
  });

  it("an unusable id is DEAD, not unknown — a row naming no session never can", () => {
    // Nothing indeterminate about it, so reaping such a row is correct.
    for (const bad of ["", "  ", null, undefined]) {
      expect(readWidgetAuthSessionLiveness(bad)).toBe("dead");
    }
    expect(runPostgresQueriesSyncMock).not.toHaveBeenCalled();
  });

  it("the boolean form refuses on BOTH dead and unknown", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(widgetAuthSessionIsLive("sess-1")).toBe(false);
    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error("down");
    });
    expect(widgetAuthSessionIsLive("sess-1")).toBe(false);
  });
});

// The jti-keyed form, for credentials that cannot present the bearer: the
// capture capability, the review island, and the run-bound chat resume token.
describe("readWidgetTokenParentLiveness — from a jti alone", () => {
  it("reads the session named on the row, then asks the same question about it", () => {
    runPostgresQueriesSyncMock
      .mockReturnValueOnce([{ rows: [{ auth_session_id: "sess-1" }], rowCount: 1 }])
      .mockReturnValueOnce([{ rows: [{ alive: 1 }], rowCount: 1 }]);
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("live");

    const [rowRead] = runPostgresQueriesSyncMock.mock.calls[0][0].queries;
    expect(rowRead.text).toContain("widget_user_tokens");
    expect(rowRead.text).toContain("WHERE jti = $1");
    // Expiry is part of the row read: an expired parent is a dead parent.
    expect(rowRead.text).toContain("expires_at > now()");
    expect(rowRead.values).toEqual(["jti-1"]);
  });

  it("DEAD when the row is gone, expired, or names no session", () => {
    runPostgresQueriesSyncMock.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("dead");

    runPostgresQueriesSyncMock.mockReturnValue([
      { rows: [{ auth_session_id: null }], rowCount: 1 },
    ]);
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("dead");
  });

  it("DEAD for an absent or oversized jti, without touching the database", () => {
    for (const bad of ["", "  ", null, "x".repeat(129)]) {
      expect(readWidgetTokenParentLiveness(bad)).toBe("dead");
    }
    expect(runPostgresQueriesSyncMock).not.toHaveBeenCalled();
  });

  it("UNKNOWN — never a throw — when the row read itself fails", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => {
      throw new Error("store down");
    });
    expect(() => readWidgetTokenParentLiveness("jti-1")).not.toThrow();
    expect(readWidgetTokenParentLiveness("jti-1")).toBe("unknown");
  });
});
