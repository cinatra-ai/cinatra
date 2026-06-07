import type { ReactNode } from "react";

export type PrimitiveRowProps = {
  name: string;
  spec?: string;
  conformance?: string;
  children: ReactNode;
};

/**
 * PrimitiveRow — one row in the design-fixtures catalog. Keeps the layout
 * uniform across every fixture module so the visual diff is meaningful.
 */
export function PrimitiveRow({ name, spec, conformance, children }: PrimitiveRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 border-b border-line py-5 last:border-b-0 lg:grid-cols-[18rem_1fr]">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">{name}</h3>
        {spec && (
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            {spec}
          </p>
        )}
        {conformance && (
          <p className="text-xs text-muted-foreground">{conformance}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
