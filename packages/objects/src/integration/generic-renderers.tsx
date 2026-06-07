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
