// Pure presentation logic for a span's status in the API Requests table (#414).
//
// OpenTelemetry spans default to UNSET and success is rarely marked OK — only
// failures set ERROR — so most successful requests persist status="unset". A raw
// "unset" badge therefore carries no signal. Render it as a muted "—" with an
// explanatory tooltip, and keep ok/error as badges. Actually instrumenting span
// status (setting OK/ERROR centrally) is tracked separately in #492.
type SpanStatusDisplay =
  | { kind: "badge"; label: string; variant: "default" | "destructive" }
  | { kind: "muted"; label: string; title: string };

export function spanStatusDisplay(status: string): SpanStatusDisplay {
  if (status === "ok") {
    return { kind: "badge", label: "ok", variant: "default" };
  }
  if (status === "error") {
    return { kind: "badge", label: "error", variant: "destructive" };
  }
  // "unset" (the OTel default) and any unrecognized value: no useful signal, so
  // show a muted em-dash with a tooltip rather than a meaningless badge.
  return {
    kind: "muted",
    label: "—",
    title:
      "No explicit status recorded. OpenTelemetry spans default to UNSET and " +
      "successful requests are not marked OK (only failures set ERROR), so most " +
      "spans show no status. Span-status instrumentation is tracked in #492.",
  };
}
