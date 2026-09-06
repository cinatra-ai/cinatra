/**
 * cinatra#3254 — A FAILED WORKER QUERY IS A FAILURE, NEVER AN EMPTY RESULT SET.
 *
 * The synchronous bridge answers its caller from a file the worker writes. The
 * parent used to throw only when that file carried a NON-EMPTY `error.message`,
 * so an error carrying no message of its own came back as `results ?? []` — the
 * caller read success and an empty page. `pg` produces exactly that shape: when
 * every address a name resolves to refuses the connection, Node rejects with an
 * `AggregateError` whose own `message` is the empty string and whose `errors`
 * carry the ECONNREFUSED detail. Four artifact unit suites went green over a
 * real socket attempt on the strength of it.
 *
 * The worker is faked here — it writes the response file and raises the signal
 * exactly the way the real one does — so the whole worker/parent path is pinned
 * without a database, a thread or a socket.
 */
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the fake worker writes for the next call. */
let nextResponse: unknown = { results: [] };

vi.mock("node:worker_threads", () => ({
  Worker: class FakeWorker {
    constructor(
      _source: string,
      options: { workerData: { responsePath: string; signalBuffer: SharedArrayBuffer } },
    ) {
      writeFileSync(options.workerData.responsePath, JSON.stringify(nextResponse));
      const signal = new Int32Array(options.workerData.signalBuffer);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
    terminate() {
      return Promise.resolve(0);
    }
  },
}));

const { runPostgresQueriesSync, serializeWorkerError } = await import("@/lib/postgres-sync");

const CALL = {
  connectionString: "postgres://unused:unused@localhost:1/unused",
  queries: [{ text: "SELECT 1" }],
};

/** The response file holds JSON, so every payload crosses that boundary here. */
function asWorkerWritesIt(error: unknown) {
  return JSON.parse(JSON.stringify({ error })) as unknown;
}

afterEach(() => {
  nextResponse = { results: [] };
});

describe("the synchronous Postgres bridge answers a failed worker with a throw", () => {
  it("throws for an error payload whose message is empty", () => {
    nextResponse = { error: { message: "", stack: "AggregateError\n    at internalConnectMultiple" } };
    expect(() => runPostgresQueriesSync(CALL)).toThrow();
  });

  it("never answers such a failure with an empty result set", () => {
    nextResponse = { error: { message: "" } };
    let answered: unknown = "answered without throwing";
    try {
      answered = runPostgresQueriesSync(CALL);
      answered = "answered without throwing";
    } catch {
      answered = "threw";
    }
    expect(answered).toBe("threw");
  });

  it("describes an AggregateError with an empty message from the errors it carries", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
    });
    nextResponse = asWorkerWritesIt(serializeWorkerError(new AggregateError([refused], "")));
    expect(() => runPostgresQueriesSync(CALL)).toThrow(/ECONNREFUSED/);
  });

  it("describes an error that carries only a code", () => {
    nextResponse = asWorkerWritesIt(
      serializeWorkerError(Object.assign(new Error(""), { code: "57P01" })),
    );
    expect(() => runPostgresQueriesSync(CALL)).toThrow(/57P01/);
  });

  it("still throws for an error that describes nothing at all", () => {
    nextResponse = { error: {} };
    expect(() => runPostgresQueriesSync(CALL)).toThrow(/worker/i);
  });

  it("keeps answering a successful worker with its results", () => {
    nextResponse = { results: [{ rows: [{ one: 1 }], rowCount: 1 }] };
    expect(runPostgresQueriesSync(CALL)).toEqual([{ rows: [{ one: 1 }], rowCount: 1 }]);
  });
});
