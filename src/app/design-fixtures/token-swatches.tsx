import type { ReactNode } from "react";

type Swatch = { token: string; utility: string; note: string; ground?: "default" | "dark" };

const SURFACES: Swatch[] = [
  { token: "--background", utility: "bg-background", note: "Page background (#f1f1ed cream)" },
  { token: "--surface", utility: "bg-surface", note: "Soft panel — no touch" },
  { token: "--surface-strong", utility: "bg-surface-strong", note: "Touchable — inputs/cards" },
  { token: "--surface-muted", utility: "bg-surface-muted", note: "Secondary chrome" },
  { token: "--accent-soft", utility: "bg-accent", note: "Hover tint" },
];

const ACCENTS: Swatch[] = [
  { token: "--primary", utility: "bg-primary text-primary-foreground", note: "Indigo · running · primary action" },
  { token: "--destructive", utility: "bg-destructive text-destructive-foreground", note: "Red · failed · destructive" },
  { token: "--success", utility: "bg-success text-success-foreground", note: "Sea-green · approved" },
  { token: "--warning", utility: "bg-warning text-warning-foreground", note: "Mustard · on hold / needs you" },
  { token: "--info", utility: "bg-info text-info-foreground", note: "Indigo · scheduled / queued" },
];

const INK: Swatch[] = [
  { token: "--foreground", utility: "bg-foreground text-background", note: "Navy ink · all primary text" },
  { token: "--muted", utility: "bg-muted text-muted-foreground", note: "Slate muted · captions / headers" },
  { token: "--line", utility: "border-line border-2 bg-surface", note: "Hairline · navy low-alpha" },
];

function SwatchRow({ title, list }: { title: string; list: Swatch[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </h4>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {list.map((s) => (
          <div key={s.token} className="flex items-center gap-3 rounded-panel border border-line bg-surface-strong p-3">
            <div className={`${s.utility} h-12 w-16 rounded-chip`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {s.token}
              </p>
              <p className="truncate text-sm text-foreground">{s.note}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TokenSwatches(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <SwatchRow title="Surfaces" list={SURFACES} />
      <SwatchRow title="Accents" list={ACCENTS} />
      <SwatchRow title="Ink + structure" list={INK} />
    </div>
  );
}
