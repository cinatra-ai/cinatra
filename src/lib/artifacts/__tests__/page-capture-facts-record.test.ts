// The page capture's per-revision facts record over a query double
// (cinatra#4223). The real-database proof is in
// page-capture-facts-record.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The bridge doubles: by default no database is reachable; the default-path cases set what the bridge answers.
const bridge = vi.hoisted(() => ({ connection: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => bridge.connection(),
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) => bridge.sync(...args),
}));

import {
  PAGE_CAPTURE_FACTS_AUDIT_ACTION,
  PAGE_CAPTURE_FACTS_REFUSED,
  PageCaptureFactsRecordError,
  buildPageCaptureFactsRecordOp,
  parsePageCaptureFacts,
  readPageCaptureFactsForRevision,
} from "@/lib/artifacts/page-capture-facts-record";

const TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
const FACTS = {
  capturedUrl: "https://shop.example/checkout?step=2",
  viewport: { width: 1440, height: 900 },
  capturedAt: "2026-11-03T07:00:00.000Z",
};
const IDS = { orgId: "org-1", artifactId: "art-1", representationRevisionId: "rev-1" };

beforeEach(() => {
  bridge.connection.mockReset();
  bridge.sync.mockReset();
  bridge.connection.mockImplementation(() => {
    throw new Error("no database in this suite");
  });
  bridge.sync.mockImplementation(() => {
    throw new Error("no database in this suite");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parsePageCaptureFacts (cinatra#4223)", () => {
  it("takes exactly the three facts", () => {
    expect(parsePageCaptureFacts(FACTS)).toEqual(FACTS);
    expect(parsePageCaptureFacts({ ...FACTS, capturedAt: "2026-11-03T08:00:00+01:00" })).not.toBeNull();
    const bare = Object.assign(Object.create(null), FACTS);
    expect(parsePageCaptureFacts(bare)).toEqual(FACTS);
  });

  it("refuses a value that is not exactly a facts object", () => {
    class Facts {
      capturedUrl = FACTS.capturedUrl;
      viewport = FACTS.viewport;
      capturedAt = FACTS.capturedAt;
    }
    for (const bad of [
      null,
      undefined,
      "facts",
      [FACTS],
      new Facts(),
      { ...FACTS, title: "extra" },
      { capturedUrl: FACTS.capturedUrl, viewport: FACTS.viewport },
      { ...FACTS, viewport: { width: 1440, height: 900, scale: 2 } },
      { ...FACTS, viewport: { width: 0, height: 900 } },
      { ...FACTS, viewport: { width: -1, height: 900 } },
      { ...FACTS, viewport: { width: 1440.5, height: 900 } },
      { ...FACTS, viewport: { width: "1440", height: 900 } },
      { ...FACTS, viewport: { width: 70000, height: 900 } },
      { ...FACTS, viewport: [1440, 900] },
      { ...FACTS, capturedUrl: "/checkout" },
      { ...FACTS, capturedUrl: "ftp://shop.example/" },
      { ...FACTS, capturedUrl: "javascript:alert(1)" },
      { ...FACTS, capturedUrl: "https://user:pass@shop.example/" },
      { ...FACTS, capturedUrl: "https://user@shop.example/" },
      { ...FACTS, capturedUrl: `https://shop.example/${"a".repeat(2100)}` },
      { ...FACTS, capturedUrl: "" },
      { ...FACTS, capturedAt: "2026-11-03T07:00:00" },
      { ...FACTS, capturedAt: "2026-11-03" },
      { ...FACTS, capturedAt: "2026-13-45T99:00:00Z" },
      { ...FACTS, capturedAt: 1762153200000 },
    ]) {
      expect(parsePageCaptureFacts(bad)).toBeNull();
    }
  });

  it("refuses a capturedAt that is not a real calendar moment, and takes the real edge moments", () => {
    for (const capturedAt of [
      "2026-02-30T00:00:00Z",
      "2026-02-31T10:00:00Z",
      "2026-04-31T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-11-03T24:00:00Z",
      "2026-11-03T07:60:00Z",
      "2026-11-03T07:00:60Z",
      "2026-11-03T07:00:00+24:00",
      "2026-11-03T07:00:00+01:60",
    ]) {
      expect(parsePageCaptureFacts({ ...FACTS, capturedAt }), capturedAt).toBeNull();
    }
    for (const capturedAt of ["2024-02-29T23:59:59Z", "2026-12-31T23:59:59.999-05:00", "2026-01-01T00:00:00+23:59"]) {
      expect(parsePageCaptureFacts({ ...FACTS, capturedAt }), capturedAt).toEqual({ ...FACTS, capturedAt });
    }
  });

  it("refuses a capturedUrl with a control character or empty user information, and takes an @ outside the authority", () => {
    for (const capturedUrl of [
      "https://shop.example/a\nb",
      "https://shop.example/a\tb",
      "https://shop.example/a\rb",
      "https://shop.example/\u0000",
      "https://shop.example/\u007f",
      "https://shop.example/\u0085",
      "http://@shop.example/",
      "https://:@shop.example/",
      "http:\\\\@shop.example/",
    ]) {
      expect(parsePageCaptureFacts({ ...FACTS, capturedUrl }), JSON.stringify(capturedUrl)).toBeNull();
    }
    const capturedUrl = "https://shop.example/a@b?c=d@e#f@g";
    expect(parsePageCaptureFacts({ ...FACTS, capturedUrl })).toEqual({ ...FACTS, capturedUrl });
  });

  it("answers null for facts whose reading throws, and names nothing of the throw", () => {
    const getter = {
      capturedUrl: FACTS.capturedUrl,
      viewport: FACTS.viewport,
      get capturedAt(): string {
        throw new Error("getter-secret-42");
      },
    };
    const nested = {
      ...FACTS,
      viewport: {
        get width(): number {
          throw new Error("getter-secret-42");
        },
        height: 900,
      },
    };
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getter-secret-42");
        },
      },
    );
    for (const facts of [getter, nested, proxy]) {
      expect(parsePageCaptureFacts(facts)).toBeNull();
    }
  });
});

describe("buildPageCaptureFactsRecordOp (cinatra#4223)", () => {
  it("writes one artifact_audit row of the facts action, binding the organisation, artifact, revision and type", () => {
    const op = buildPageCaptureFactsRecordOp({ schema: "cinatra", objectType: TYPE, facts: FACTS, ...IDS });
    expect(op.text).toContain('INSERT INTO "cinatra"."artifact_audit"');
    expect(op.text).toContain("(id, org_id, artifact_id, representation_revision_id, action, actor, detail)");
    expect(op.values.slice(0, 4)).toEqual(["org-1", "art-1", "rev-1", PAGE_CAPTURE_FACTS_AUDIT_ACTION]);
    expect(PAGE_CAPTURE_FACTS_AUDIT_ACTION).toBe("page_capture_facts");
    expect(JSON.parse(op.values[4] as string)).toEqual({ v: 1, objectType: TYPE, ...FACTS });
  });

  it("escapes the schema name", () => {
    const op = buildPageCaptureFactsRecordOp({ schema: 'we"ird', objectType: TYPE, facts: FACTS, ...IDS });
    expect(op.text).toContain('INSERT INTO "we""ird"."artifact_audit"');
  });

  it("refuses facts that do not parse, or an empty id, with a fixed text that names no input", () => {
    const secretUrl = "https://user:token-123@shop.example/";
    const cases = [
      { ...IDS, objectType: TYPE, facts: { ...FACTS, capturedUrl: secretUrl } },
      { ...IDS, objectType: TYPE, facts: { ...FACTS, extra: true } },
      { ...IDS, objectType: "", facts: FACTS },
      { ...IDS, orgId: "", objectType: TYPE, facts: FACTS },
      { ...IDS, artifactId: "", objectType: TYPE, facts: FACTS },
      { ...IDS, representationRevisionId: "", objectType: TYPE, facts: FACTS },
    ];
    for (const input of cases) {
      let thrown: unknown;
      try {
        buildPageCaptureFactsRecordOp({ schema: "cinatra", ...input });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(PageCaptureFactsRecordError);
      expect((thrown as Error).message).toBe(PAGE_CAPTURE_FACTS_REFUSED);
      expect((thrown as Error).message).not.toContain("token-123");
    }
  });

  it("keeps the fixed refusal sentence when reading the facts throws", () => {
    const facts = {
      capturedUrl: FACTS.capturedUrl,
      viewport: FACTS.viewport,
      get capturedAt(): string {
        throw new Error("getter-secret-42");
      },
    };
    let thrown: unknown;
    try {
      buildPageCaptureFactsRecordOp({ schema: "cinatra", ...IDS, objectType: TYPE, facts });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PageCaptureFactsRecordError);
    expect((thrown as Error).message).toBe(PAGE_CAPTURE_FACTS_REFUSED);
    expect((thrown as Error).message).not.toContain("getter-secret-42");
  });
});

describe("readPageCaptureFactsForRevision (cinatra#4223)", () => {
  const record = (detail: unknown) => ({ detail });
  const good = { v: 1, objectType: TYPE, ...FACTS };
  const input = { ...IDS, objectType: TYPE };

  it("reads by organisation, artifact, revision and the facts action, at most two rows", () => {
    const seen: { text: string; values: unknown[] }[] = [];
    const answer = readPageCaptureFactsForRevision(input, {
      schema: "cinatra",
      runQuery: (q) => {
        seen.push(q);
        return [record(good)];
      },
    });
    expect(answer).toEqual({ status: "recorded", facts: FACTS });
    expect(seen).toHaveLength(1);
    expect(seen[0].values).toEqual(["org-1", "art-1", "rev-1", "page_capture_facts"]);
    expect(seen[0].text).toContain('FROM "cinatra"."artifact_audit"');
    expect(seen[0].text).toContain(
      "WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3 AND action = $4",
    );
    expect(seen[0].text).toContain("LIMIT 2");
  });

  it("answers absent for a revision without a record, and for a record of another type", () => {
    expect(readPageCaptureFactsForRevision(input, { runQuery: () => [] })).toEqual({ status: "absent" });
    expect(
      readPageCaptureFactsForRevision(input, {
        runQuery: () => [record({ ...good, objectType: "@cinatra-ai/chart-artifact:chart" })],
      }),
    ).toEqual({ status: "absent" });
  });

  it("answers unreadable for two records of one revision, an unknown shape, or facts that do not parse", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const rows of [
      [record(good), record(good)],
      [record({ ...good, v: 2 })],
      [record({ ...good, note: "extra" })],
      [record({ objectType: TYPE, ...FACTS })],
      [record({ ...good, viewport: { width: 0, height: 900 } })],
      [record({ ...good, capturedUrl: "https://user:pass@shop.example/" })],
      [record("not an object")],
      [record(null)],
      ["not a row"],
    ]) {
      expect(readPageCaptureFactsForRevision(input, { runQuery: () => rows })).toEqual({ status: "unreadable" });
    }
    const notAList = (() => ({ rows: [record(good)] })) as unknown as () => unknown[];
    expect(readPageCaptureFactsForRevision(input, { runQuery: notAList })).toEqual({ status: "unreadable" });
  });

  it("answers unreadable, not absent, for two records of one revision whose types differ", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const other = record({ ...good, objectType: "@cinatra-ai/chart-artifact:chart" });
    for (const type of [TYPE, "@cinatra-ai/chart-artifact:chart", "@cinatra-ai/other-artifact:other"]) {
      expect(
        readPageCaptureFactsForRevision({ ...input, objectType: type }, { runQuery: () => [record(good), other] }),
      ).toEqual({ status: "unreadable" });
    }
  });

  it("answers unreadable when the read throws, and its log line carries no text of the error", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = readPageCaptureFactsForRevision(input, {
      runQuery: () => {
        throw new Error("read failed: postgres://fixture-user:fixture-secret@db.invalid/x");
      },
    });
    expect(answer).toEqual({ status: "unreadable" });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("fixture-secret");
    expect(logged).toContain("rev-1");
  });

  it("answers absent for an empty id without a read", () => {
    const runQuery = vi.fn(() => [record(good)]);
    for (const k of ["orgId", "artifactId", "representationRevisionId", "objectType"] as const) {
      expect(readPageCaptureFactsForRevision({ ...input, [k]: "" }, { runQuery })).toEqual({ status: "absent" });
    }
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("answers unreadable on the configured store when no database is reachable (it never throws)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readPageCaptureFactsForRevision(input)).toEqual({ status: "unreadable" });
  });
});

describe("readPageCaptureFactsForRevision on the configured store (cinatra#4223)", () => {
  const CONNECTION = "postgres://fixture-user:fixture-secret@db.invalid/fixture";
  const good = { v: 1, objectType: TYPE, ...FACTS };
  const input = { ...IDS, objectType: TYPE };

  it("reads recorded or absent from the row list the bridge returns, with the revision's own values", () => {
    bridge.connection.mockReturnValue(CONNECTION);
    bridge.sync.mockReturnValue([{ rows: [{ detail: good }], rowCount: 1 }]);
    expect(readPageCaptureFactsForRevision(input)).toEqual({ status: "recorded", facts: FACTS });
    expect(bridge.sync).toHaveBeenCalledTimes(1);
    expect(bridge.sync).toHaveBeenCalledWith({
      connectionString: CONNECTION,
      queries: [
        {
          text: expect.stringContaining('FROM "cinatra"."artifact_audit"'),
          values: ["org-1", "art-1", "rev-1", "page_capture_facts"],
        },
      ],
    });
    bridge.sync.mockReturnValue([{ rows: [], rowCount: 0 }]);
    expect(readPageCaptureFactsForRevision(input)).toEqual({ status: "absent" });
  });

  it("answers unreadable, never absent, for a missing result or rows that are not a list", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bridge.connection.mockReturnValue(CONNECTION);
    for (const answer of [
      [],
      [undefined],
      [null],
      [{}],
      [{ rows: null }],
      [{ rows: "none" }],
      [{ rows: { length: 0 } }],
      undefined,
    ]) {
      bridge.sync.mockReturnValue(answer);
      expect(readPageCaptureFactsForRevision(input), JSON.stringify(answer)).toEqual({ status: "unreadable" });
    }
  });

  it("answers unreadable, not absent, for the empty answers the bridge gives during a production build", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    bridge.connection.mockReturnValue(CONNECTION);
    bridge.sync.mockReturnValue([{ rows: [], rowCount: 0 }]);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(readPageCaptureFactsForRevision(input)).toEqual({ status: "unreadable" });
    expect(bridge.sync).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    expect(readPageCaptureFactsForRevision(input)).toEqual({ status: "absent" });
    expect(bridge.sync).toHaveBeenCalledTimes(1);
  });
});
