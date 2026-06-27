// Pure normalization of the /analytics/api trace filters from raw query params
// (#491). The traces screen turns from/to/service URL params into a validated
// filter for the server-side query. Kept dependency-free (no DB/drizzle) so it
// is unit-testable in isolation.
export type ParsedTraceFilters = {
  from?: Date;
  to?: Date;
  service?: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseInstant(
  value: string | null | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // A bare yyyy-mm-dd (from <input type="date">) is taken as a UTC day. The
  // upper bound includes the whole day so "to = the 26th" covers all of the
  // 26th rather than stopping at its midnight.
  const iso = DATE_ONLY.test(trimmed)
    ? `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseTraceFilters(params: {
  from?: string | null;
  to?: string | null;
  service?: string | null;
}): ParsedTraceFilters {
  const out: ParsedTraceFilters = {};
  const from = parseInstant(params.from, false);
  if (from) out.from = from;
  const to = parseInstant(params.to, true);
  if (to) out.to = to;
  const service = (params.service ?? "").trim();
  if (service && service.toLowerCase() !== "all") out.service = service;
  return out;
}
