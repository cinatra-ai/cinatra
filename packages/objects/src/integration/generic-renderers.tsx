// Placeholder renderers for the generic `@cinatra-ai/objects:object` type.
// Static, unstyled key/value views; the objects browser already provides
// richer detail screens via `ObjectDetailDrawer` so these are a defensive
// fallback for any UI that renders by registry slot. Specialised renderers can
// replace these without changing the type registration.

import type { ObjectRendererSlotProps } from "../renderer-types";

type GenericObjectData = Record<string, unknown>;

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pickName(data: GenericObjectData): string {
  for (const key of ["name", "title", "displayName", "email", "slug"] as const) {
    const v = data[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "(unnamed object)";
}

export function GenericObjectListRow({ value, compact }: ObjectRendererSlotProps<GenericObjectData>) {
  const name = pickName(value);
  if (compact) return <span className="text-sm">{name}</span>;
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-sm font-medium">{name}</span>
      <span className="ml-auto text-xs text-muted-foreground">generic object</span>
    </div>
  );
}

export function GenericObjectCard({ value }: ObjectRendererSlotProps<GenericObjectData>) {
  const name = pickName(value);
  return (
    <article className="soft-panel rounded-card p-4">
      <header className="text-base font-semibold">{name}</header>
      <p className="mt-1 text-xs text-muted-foreground">Generic object — no specialised renderer</p>
    </article>
  );
}

export function GenericObjectDetail({ value }: ObjectRendererSlotProps<GenericObjectData>) {
  const entries = Object.entries(value);
  return (
    <section className="soft-panel rounded-card p-4">
      <header className="text-base font-semibold">{pickName(value)}</header>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">(empty object)</p>
      ) : (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-muted-foreground">{k}</dt>
              <dd className="font-mono break-all">{renderValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// `@cinatra-ai/memory:concept` renderers (cinatra#1376, epic #1373).
//
// Housed in THIS module (not a sibling file) on purpose: this module is
// reachable from the locked route-graph budgets via register-types.ts, so a
// new first-party sibling renderer module would grow every locked route by
// one. Generic renderers derive a display name from TOP-LEVEL fields, so a
// memory concept would render as its raw envelope; these memory-specific
// renderers surface the nested `frontmatter.title` plus the concept path
// (`conceptId`). Markdown is rendered as PLAIN TEXT (memory files are
// untrusted input; no HTML/Markdown interpretation here).
// ---------------------------------------------------------------------------

type MemoryConceptData = Record<string, unknown>;

/** `frontmatter.title` when present and non-empty; falls back to the concept
 *  path (path = identity), then to a fixed placeholder. */
export function memoryConceptTitle(data: MemoryConceptData): string {
  const frontmatter = data.frontmatter;
  if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
    const title = (frontmatter as Record<string, unknown>).title;
    if (typeof title === "string" && title.trim().length > 0) return title;
  }
  const path = memoryConceptPath(data);
  return path.length > 0 ? path : "(untitled concept)";
}

/** The concept path (`conceptId`), or "" when absent/malformed. */
export function memoryConceptPath(data: MemoryConceptData): string {
  const conceptId = data.conceptId;
  return typeof conceptId === "string" ? conceptId : "";
}

function okfType(data: MemoryConceptData): string | null {
  const t = data.okfType;
  return typeof t === "string" && t.length > 0 ? t : null;
}

export function MemoryConceptListRow({
  value,
  compact,
}: ObjectRendererSlotProps<MemoryConceptData>) {
  const title = memoryConceptTitle(value);
  const path = memoryConceptPath(value);
  if (compact) return <span className="text-sm">{title}</span>;
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-sm font-medium">{title}</span>
      {path.length > 0 && (
        <span className="font-mono text-xs text-muted-foreground">{path}</span>
      )}
      <span className="ml-auto text-xs text-muted-foreground">memory concept</span>
    </div>
  );
}

export function MemoryConceptCard({
  value,
}: ObjectRendererSlotProps<MemoryConceptData>) {
  const title = memoryConceptTitle(value);
  const path = memoryConceptPath(value);
  const type = okfType(value);
  return (
    <article className="soft-panel rounded-card p-4">
      <header className="text-base font-semibold">{title}</header>
      {path.length > 0 && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">{path}</p>
      )}
      {type && <p className="mt-1 text-xs text-muted-foreground">{type}</p>}
    </article>
  );
}

export function MemoryConceptDetail({
  value,
}: ObjectRendererSlotProps<MemoryConceptData>) {
  const title = memoryConceptTitle(value);
  const path = memoryConceptPath(value);
  const type = okfType(value);
  const body = typeof value.bodyMarkdown === "string" ? value.bodyMarkdown : "";
  return (
    <section className="soft-panel rounded-card p-4">
      <header className="text-base font-semibold">{title}</header>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {path.length > 0 && (
          <div className="contents">
            <dt className="font-mono text-muted-foreground">path</dt>
            <dd className="font-mono break-all">{path}</dd>
          </div>
        )}
        {type && (
          <div className="contents">
            <dt className="font-mono text-muted-foreground">type</dt>
            <dd className="font-mono break-all">{type}</dd>
          </div>
        )}
      </dl>
      {body.length > 0 && (
        <pre className="mt-3 text-xs whitespace-pre-wrap break-words">{body}</pre>
      )}
    </section>
  );
}
