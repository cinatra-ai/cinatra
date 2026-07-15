// Shared item reader for the entity-summary portlets (cinatra#702).
// The `entity-metadata` and `entity-count` portlets both render a list of
// `{ label, value }` pairs straight from `config.items` — this parses that
// config defensively (the install validator already rejects a malformed config
// on the write path, but the render path must never throw on an unexpected
// shape, only skip the bad item). No `href` / link field exists — summaries are
// plain label/value, so there is no redirect / `javascript:`-URL surface.
export type SummaryItem = { label: string; value: string | number };

/** Parse `config.items` into a clean `SummaryItem[]`; drops any malformed item. */
export function readSummaryItems(config: Record<string, unknown>): SummaryItem[] {
  const raw = config.items;
  if (!Array.isArray(raw)) return [];
  const out: SummaryItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || item.label.length === 0) continue;
    const v = item.value;
    if (typeof v === "string") {
      out.push({ label: item.label, value: v });
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ label: item.label, value: v });
    }
  }
  return out;
}

/** The optional `config.title`, when it is a non-empty string. */
export function readSummaryTitle(config: Record<string, unknown>): string | null {
  return typeof config.title === "string" && config.title.length > 0 ? config.title : null;
}
