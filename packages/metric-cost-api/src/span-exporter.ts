import "server-only";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { SpanStatusCode } from "@opentelemetry/api";
import { db } from "./db";
import { traces } from "./schema";

// ---------------------------------------------------------------------------
// Postgres SpanExporter.
// Implements the OTel SpanExporter interface by writing each span to the
// cinatra.traces table. Never throws — failures are logged and reported via
// ExportResultCode.FAILED so the SDK can decide whether to retry (we do not,
// because duplicate exports are idempotent via .onConflictDoNothing()).
//
// Registered by src/lib/otel-bootstrap.ts.
// Schema: packages/metric-cost-api/src/schema.ts — `traces` table.
// ---------------------------------------------------------------------------
export class PostgresSpanExporter implements SpanExporter {
  async export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    // allSettled instead of all so a single span failure does not abort the batch.
    // A rejected span is reported as FAILED to the SDK without crashing other writes.
    const results = await Promise.allSettled(spans.map((s) => this._writeSpan(s)));
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length > 0) {
      const first = failures[0].reason as unknown;
      console.error(
        `[metric-cost-api:span-exporter] ${failures.length}/${spans.length} spans failed to write:`,
        first,
      );
      resultCallback({
        code: ExportResultCode.FAILED,
        error: first instanceof Error ? first : new Error(String(first)),
      });
    } else {
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  async shutdown(): Promise<void> {
    // No buffering — each export call is synchronous w.r.t. DB writes.
  }

  async forceFlush(): Promise<void> {
    // No-op for the same reason.
  }

  private async _writeSpan(span: ReadableSpan): Promise<void> {
    const ctx = span.spanContext();
    const startedAt = hrTimeToDate(span.startTime);
    const endedAt = hrTimeToDate(span.endTime);
    const durationMs = hrTimeToMs(span.duration);
    const status = mapStatus(span.status.code);
    const service =
      (span.resource.attributes["service.name"] as string | undefined) ??
      "cinatra-app";
    const agentRunId =
      (span.attributes["agent.run_id"] as string | undefined) ?? null;

    try {
      await db
        .insert(traces)
        .values({
          traceId:      ctx.traceId,
          spanId:       ctx.spanId,
          parentSpanId: span.parentSpanId ?? null,
          name:         span.name,
          service,
          startedAt,
          endedAt,
          durationMs,
          status,
          attributes:   span.attributes as Record<string, unknown>,
          events:       span.events as unknown as unknown[],
          agentRunId,
        })
        .onConflictDoNothing();
    } catch (err) {
      // Per-span failure: log but do not abort the batch — the Promise.all
      // will still collect other successes; we re-throw so the outer catch
      // reports FAILED to the SDK.
      console.error(
        "[metric-cost-api:span-exporter] Failed to write span:",
        { traceId: ctx.traceId, spanId: ctx.spanId, name: span.name },
        err,
      );
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// HRTime helpers. @opentelemetry/api defines HrTime as [seconds, nanoseconds].
// ---------------------------------------------------------------------------
function hrTimeToDate(hr: [number, number]): Date {
  return new Date(hr[0] * 1000 + hr[1] / 1e6);
}

function hrTimeToMs(hr: [number, number]): number {
  return Math.round((hr[0] * 1e9 + hr[1]) / 1e6);
}

function mapStatus(code: SpanStatusCode): "unset" | "ok" | "error" {
  // @opentelemetry/api: UNSET=0, OK=1, ERROR=2
  if (code === SpanStatusCode.OK) return "ok";
  if (code === SpanStatusCode.ERROR) return "error";
  return "unset";
}
