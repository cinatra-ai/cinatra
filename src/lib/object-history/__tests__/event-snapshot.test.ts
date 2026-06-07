import { describe, expect, it } from "vitest";

import {
  buildSnapshotFromRow,
  canonicalJsonStringify,
  computeEventChecksum,
  diffSnapshotFields,
} from "../event-snapshot";

describe("canonicalJsonStringify", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: 3 });
    const b = canonicalJsonStringify({ a: 2, c: 3, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("recursively sorts nested objects", () => {
    const out = canonicalJsonStringify({
      outer: { z: 1, a: 2, m: { y: 5, x: 4 } },
    });
    expect(out).toBe('{"outer":{"a":2,"m":{"x":4,"y":5},"z":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalJsonStringify({ list: [3, 1, 2] })).toBe(
      '{"list":[3,1,2]}',
    );
  });

  it("normalizes Date to ISO string", () => {
    const d = new Date("2026-05-23T10:30:00.000Z");
    expect(canonicalJsonStringify({ at: d })).toBe(
      '{"at":"2026-05-23T10:30:00.000Z"}',
    );
  });
});

describe("computeEventChecksum", () => {
  it("stable across equivalent inputs (key order)", () => {
    const a = computeEventChecksum({
      objectId: "obj_1",
      operation: "update",
      historyEffect: "reversible-internal",
      before: { payload: { a: 1, b: 2 } },
      after: { payload: { b: 2, a: 1 } },
      baseVersion: 1,
      resultVersion: 2,
      idempotencyKey: "che_test",
    });
    const b = computeEventChecksum({
      objectId: "obj_1",
      operation: "update",
      historyEffect: "reversible-internal",
      before: { payload: { b: 2, a: 1 } },
      after: { payload: { a: 1, b: 2 } },
      baseVersion: 1,
      resultVersion: 2,
      idempotencyKey: "che_test",
    });
    expect(a).toBe(b);
  });

  it("differs when result version changes", () => {
    const base = {
      objectId: "obj_1",
      operation: "update" as const,
      historyEffect: "reversible-internal" as const,
      before: { payload: { a: 1 } },
      after: { payload: { a: 2 } },
      baseVersion: 1,
      idempotencyKey: "che_test",
    };
    expect(
      computeEventChecksum({ ...base, resultVersion: 2 }),
    ).not.toBe(computeEventChecksum({ ...base, resultVersion: 3 }));
  });

  it("includes idempotency key in the hash", () => {
    const a = computeEventChecksum({
      objectId: "obj_1",
      operation: "create",
      historyEffect: "reversible-internal",
      before: null,
      after: { payload: { a: 1 } },
      baseVersion: null,
      resultVersion: 1,
      idempotencyKey: "che_one",
    });
    const b = computeEventChecksum({
      objectId: "obj_1",
      operation: "create",
      historyEffect: "reversible-internal",
      before: null,
      after: { payload: { a: 1 } },
      baseVersion: null,
      resultVersion: 1,
      idempotencyKey: "che_two",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildSnapshotFromRow", () => {
  it("strips graphiti_* projection metadata", () => {
    const snap = buildSnapshotFromRow({
      id: "obj_1",
      type: "blog.post",
      data: { title: "hi" },
      version: 1,
      graphiti_sync_status: "pending",
      graphiti_projected_version: 1,
      graphiti_episode_uuid: "abc",
    });
    expect(snap).not.toBeNull();
    const payload = snap?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual([
      "data",
      "id",
      "type",
      "version",
    ]);
  });

  it("returns null for null/undefined input", () => {
    expect(buildSnapshotFromRow(null)).toBeNull();
    expect(buildSnapshotFromRow(undefined)).toBeNull();
  });
});

describe("diffSnapshotFields", () => {
  it("returns empty for identical payloads", () => {
    const a = { payload: { x: 1, y: 2 } };
    const b = { payload: { x: 1, y: 2 } };
    expect(diffSnapshotFields(a, b)).toEqual([]);
  });

  it("detects top-level changed fields", () => {
    const a = { payload: { x: 1, y: 2 } };
    const b = { payload: { x: 1, y: 3 } };
    expect(diffSnapshotFields(a, b)).toEqual(["y"]);
  });

  it("detects deep changes at the top-level key", () => {
    const a = { payload: { data: { subject: "old" } } };
    const b = { payload: { data: { subject: "new" } } };
    expect(diffSnapshotFields(a, b)).toEqual(["data"]);
  });

  it("returns all keys when one side is null", () => {
    const a = { payload: { x: 1, y: 2 } };
    expect(diffSnapshotFields(null, a).sort()).toEqual(["x", "y"]);
    expect(diffSnapshotFields(a, null).sort()).toEqual(["x", "y"]);
  });
});
