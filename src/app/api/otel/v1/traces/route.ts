import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db, traces } from "@cinatra-ai/metric-cost-api";

// ---------------------------------------------------------------------------
// OTLP/HTTP traces receiver.
// Accepts JSON-encoded OTLP payloads from LangGraph Server (or any OTel emitter
// configured with OTEL_EXPORTER_OTLP_ENDPOINT pointing here). Writes each span
// to cinatra.traces using the same schema as PostgresSpanExporter.
//
// Security: gated on x-otel-token header matching OTEL_INGEST_TOKEN env var
// when set. When unset (local dev), accepts loopback/Docker-bridge requests only
// and warns on first invocation. The route must never be fully open.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OtlpAttrVal =
  | { stringValue?: string }
  | { intValue?: string }
  | { doubleValue?: number }
  | { boolValue?: boolean };
type OtlpAttr = { key: string; value: OtlpAttrVal };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code?: number; message?: string };
  attributes?: OtlpAttr[];
  events?: unknown[];
};
type OtlpResourceSpans = {
  resource?: { attributes?: OtlpAttr[] };
  scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
};
type OtlpPayload = { resourceSpans?: OtlpResourceSpans[] };

let warnedOnNoToken = false;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- auth gate ---
  const expectedToken = process.env.OTEL_INGEST_TOKEN?.trim();
  if (expectedToken) {
    const provided = request.headers.get("x-otel-token");
    if (provided !== expectedToken) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    // No token configured — enforce loopback / Docker bridge only.
    // The threat model requires loopback-only when no token is set.
    const forwarded = request.headers.get("x-forwarded-for");
    const remoteIp = (forwarded?.split(",")[0]?.trim() ?? "").toLowerCase();
    const isLoopback =
      !forwarded ||
      remoteIp === "127.0.0.1" ||
      remoteIp === "::1" ||
      remoteIp === "localhost" ||
      remoteIp.startsWith("172.17.") || // Docker default bridge subnet
      remoteIp.startsWith("192.168."); // common local network
    if (!isLoopback) {
      console.error(
        "[otel-receiver] OTEL_INGEST_TOKEN is not set and request is not from loopback/docker. Rejecting. IP:",
        remoteIp || "(no x-forwarded-for header)",
      );
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!warnedOnNoToken) {
      console.warn(
        "[otel-receiver] OTEL_INGEST_TOKEN is not set — accepting loopback/docker-bridge trace ingress only. Set OTEL_INGEST_TOKEN for any non-local deployment.",
      );
      warnedOnNoToken = true;
    }
  }

  // --- parse ---
  let payload: OtlpPayload;
  try {
    payload = (await request.json()) as OtlpPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const resourceSpans = payload.resourceSpans ?? [];

  // Collect all rows first, then batch-insert in a single round-trip.
  // Serial inserts inside nested loops produced N DB round-trips per request.
  type SpanRow = typeof traces.$inferInsert;
  const rows: SpanRow[] = [];
  for (const rs of resourceSpans) {
    const serviceName =
      flattenAttrs(rs.resource?.attributes ?? [])["service.name"] ?? "unknown";
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = flattenAttrs(span.attributes ?? []);
        const startedAt = nsToDate(span.startTimeUnixNano);
        const endedAt = nsToDate(span.endTimeUnixNano);
        const durationMs = Math.max(
          0,
          Math.round(endedAt.getTime() - startedAt.getTime()),
        );
        rows.push({
          traceId:      span.traceId,
          spanId:       span.spanId,
          parentSpanId: span.parentSpanId ?? null,
          name:         span.name,
          service:      typeof serviceName === "string" ? serviceName : "unknown",
          startedAt,
          endedAt,
          durationMs,
          status:       mapStatus(span.status?.code),
          attributes:   attrs,
          events:       (span.events ?? []) as unknown[],
          agentRunId:   typeof attrs["agent.run_id"] === "string"
                          ? (attrs["agent.run_id"] as string)
                          : null,
        });
      }
    }
  }

  const inserted = rows.length;
  if (rows.length > 0) {
    try {
      await db.insert(traces).values(rows).onConflictDoNothing();
    } catch (err) {
      console.error("[otel-receiver] Failed to persist OTLP spans:", err);
      return NextResponse.json(
        { error: "persist_failed" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ partialSuccess: {}, accepted: inserted }, { status: 202 });
}

function flattenAttrs(attrs: OtlpAttr[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs) {
    const v = a.value as {
      stringValue?: string;
      intValue?: string;
      doubleValue?: number;
      boolValue?: boolean;
    };
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
  }
  return out;
}

function nsToDate(ns: string): Date {
  // Nanosecond string → ms number via BigInt to avoid precision loss.
  // BigInt literals (1_000_000n) require ES2020 target; use BigInt() constructor instead.
  try {
    const ms = Number(BigInt(ns) / BigInt(1_000_000));
    return new Date(ms);
  } catch {
    return new Date(0);
  }
}

function mapStatus(code?: number): "unset" | "ok" | "error" {
  if (code === 1) return "ok";
  if (code === 2) return "error";
  return "unset";
}
