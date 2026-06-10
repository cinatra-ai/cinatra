import type { ReactNode } from "react";

/**
 * MarketplaceReadmeSection — the PRIMARY-BODY slot of the in-app marketplace
 * detail view, mirroring the public page's Description tab (the README body).
 * This component owns only the POSITION of the block: it must be the first
 * section of the detail body for every extension kind. What renders inside is
 * the caller's concern — full README markdown parity (rendering, sanitization,
 * typography, heading demotion) is a separate follow-up and will fill this
 * slot.
 */
export function MarketplaceReadmeSection({ children }: { children: ReactNode }) {
  return (
    <section
      data-slot="marketplace-readme"
      className="soft-panel rounded-card px-6 py-5"
    >
      <h2 className="mb-3 text-sm font-semibold text-foreground">Description</h2>
      {children}
    </section>
  );
}
