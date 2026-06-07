import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";

// ---------------------------------------------------------------------------
// Mock db and schema BEFORE importing the exporter so the module-level
// `import { db } from "./db"` picks up the mock.
//
// vi.hoisted() ensures these variables are initialized before vi.mock factories
// run (vi.mock calls are hoisted to the top of the file by vitest's transformer).
// ---------------------------------------------------------------------------
const { mockOnConflictDoNothing, mockValues, mockInsert } = vi.hoisted(() => {
  const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockOnConflictDoNothing, mockValues, mockInsert };
});

vi.mock("../src/db", () => ({ db: { insert: mockInsert } }));
vi.mock("../src/schema", () => ({ traces: {} }));

// Import after mocks are in place.
import { PostgresSpanExporter } from "../src/span-exporter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(overrides: {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  statusCode?: SpanStatusCode;
  serviceName?: string;
  agentRunId?: string;
} = {}): ReadableSpan {
  return {
    spanContext: () => ({
      traceId: overrides.traceId ?? "trace-abc",
      spanId:  overrides.spanId  ?? "span-001",
      traceFlags: 1,
    }),
    parentSpanId: overrides.parentSpanId,
    name:         overrides.name ?? "test.span",
    startTime:    [1700000000, 0] as [number, number],
    endTime:      [1700000001, 0] as [number, number],
    duration:     [1, 0] as [number, number],
    status: {
      code: overrides.statusCode ?? SpanStatusCode.UNSET,
    },
    resource: {
      attributes: {
        ...(overrides.serviceName ? { "service.name": overrides.serviceName } : {}),
      },
    },
    attributes: {
      ...(overrides.agentRunId ? { "agent.run_id": overrides.agentRunId } : {}),
    },
    events: [],
  } as unknown as ReadableSpan;
}

function captureResult(exporter: PostgresSpanExporter, spans: ReadableSpan[]): Promise<ExportResult> {
  return new Promise((resolve) => {
    exporter.export(spans, resolve);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostgresSpanExporter", () => {
  let exporter: PostgresSpanExporter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnConflictDoNothing.mockResolvedValue(undefined);
    exporter = new PostgresSpanExporter();
  });

  // -------------------------------------------------------------------------
  // Behavior 1: empty batch
  // -------------------------------------------------------------------------
  it("calls resultCallback with SUCCESS immediately for an empty span batch", async () => {
    const result = await captureResult(exporter, []);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Behavior 2: SpanStatusCode.OK → status: "ok" + correct field mapping
  // -------------------------------------------------------------------------
  it("inserts a span with status 'ok' when SpanStatusCode.OK and maps fields correctly", async () => {
    const span = makeSpan({
      traceId:     "trace-111",
      spanId:      "span-222",
      parentSpanId: "span-parent",
      name:        "llm.call",
      statusCode:  SpanStatusCode.OK,
      serviceName: "cinatra-test",
      agentRunId:  "run-xyz",
    });

    const result = await captureResult(exporter, [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockValues).toHaveBeenCalledOnce();

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.traceId).toBe("trace-111");
    expect(insertedRow.spanId).toBe("span-222");
    expect(insertedRow.parentSpanId).toBe("span-parent");
    expect(insertedRow.name).toBe("llm.call");
    expect(insertedRow.service).toBe("cinatra-test");
    expect(insertedRow.status).toBe("ok");
    expect(insertedRow.agentRunId).toBe("run-xyz");
    expect(insertedRow.durationMs).toBe(1000); // [1, 0] → 1000 ms
    expect(insertedRow.startedAt).toBeInstanceOf(Date);
    expect(insertedRow.endedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Behavior 3: SpanStatusCode.ERROR → status: "error"
  // -------------------------------------------------------------------------
  it("inserts a span with status 'error' when SpanStatusCode.ERROR", async () => {
    const span = makeSpan({ statusCode: SpanStatusCode.ERROR });

    const result = await captureResult(exporter, [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.status).toBe("error");
  });

  // -------------------------------------------------------------------------
  // Behavior 4: SpanStatusCode.UNSET (0) → status: "unset"
  // -------------------------------------------------------------------------
  it("inserts a span with status 'unset' when SpanStatusCode.UNSET", async () => {
    const span = makeSpan({ statusCode: SpanStatusCode.UNSET });

    const result = await captureResult(exporter, [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.status).toBe("unset");
    // Confirm UNSET is the numeric value 0
    expect(SpanStatusCode.UNSET).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Behavior 5: per-span DB failure → FAILED + other spans still attempted
  // -------------------------------------------------------------------------
  it("reports FAILED when one span fails to write and still attempts all spans", async () => {
    const dbError = new Error("db connection refused");

    // First call rejects, second succeeds — verify both are attempted (allSettled)
    mockOnConflictDoNothing
      .mockRejectedValueOnce(dbError)
      .mockResolvedValueOnce(undefined);

    const spans = [
      makeSpan({ spanId: "span-fail", name: "span.fails" }),
      makeSpan({ spanId: "span-ok",   name: "span.succeeds" }),
    ];

    const result = await captureResult(exporter, spans);

    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("db connection refused");

    // Both spans were attempted — insert called twice
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Behavior 6: all spans succeed → SUCCESS
  // -------------------------------------------------------------------------
  it("reports SUCCESS when all spans in the batch write successfully", async () => {
    const spans = [
      makeSpan({ spanId: "span-a", statusCode: SpanStatusCode.OK }),
      makeSpan({ spanId: "span-b", statusCode: SpanStatusCode.ERROR }),
      makeSpan({ spanId: "span-c", statusCode: SpanStatusCode.UNSET }),
    ];

    const result = await captureResult(exporter, spans);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });
});
