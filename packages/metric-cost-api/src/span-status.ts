// Pure status derivation for persisted trace spans (#492). OTel spans default to
// UNSET and success is rarely marked OK (only failures set ERROR), so virtually
// every row landed as "unset" and the /analytics/api Status column carried no
// signal. When a span left its status UNSET but carries an HTTP response status
// code, derive a meaningful outcome from it; an explicitly-recorded ok/error is
// always respected. Spans with neither stay "unset" (genuinely unknown) — the
// UI renders those as "—" (#414).
export type SpanStatus = "unset" | "ok" | "error";

// OTel HTTP semconv: stable `http.response.status_code`, legacy `http.status_code`.
const HTTP_STATUS_CODE_KEYS = [
  "http.response.status_code",
  "http.status_code",
] as const;

function readHttpStatusCode(attributes: Record<string, unknown>): number | null {
  for (const key of HTTP_STATUS_CODE_KEYS) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function refineStatusFromHttp(
  base: SpanStatus,
  attributes: Record<string, unknown>,
): SpanStatus {
  // Respect an explicitly-recorded outcome; only fill in when UNSET.
  if (base !== "unset") return base;
  const code = readHttpStatusCode(attributes);
  if (code === null) return "unset";
  // A 4xx/5xx response is a failed HTTP completion; 1xx–3xx is a success.
  return code >= 400 ? "error" : "ok";
}
