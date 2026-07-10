# @cinatra-ai/sdk-ui

Cinatra-design-strict React composition primitives — the page-chrome layer that sits above shadcn primitives in any Cinatra-design-system consumer.

## Capabilities

- ✓ Page-chrome shell: `<Main>` + `<PageHeader>` + `<PageContent>` — the canonical three-component page wrapper
- ✓ `<StatusPill>` — ten-state status indicator with built-in icons (running, approved, hold, needs-review, scheduled, queued, idle, archived, failed, declined)
- ✓ `<ExtensionCard>` — the §V card pattern with drew-palette ground + emblem badge + indicator chip
- ✓ Extension accent palette helpers — `ACCENT_PALETTE`, `deriveExtensionAccent(seed)`, type-narrowing
- ✓ `cn(...)` class-merge helper (clsx + tailwind-merge)
- ✓ Background-process modals + status banners
- ✓ HITL assist field, prompt field, inline page title
- ✓ Widget shell + data hooks
- ✓ `<Tabs>` — the shared, accessible design-system underline tablist for connector setup pages (Setup / custom / always-last Help), exported from its own `/tabs` subpath

## Works with

- `@cinatra-ai/design` (CSS tokens, fonts, utilities — required)
- React 19 + Tailwind v4
- shadcn/ui primitives (not bundled — consumers add via `pnpm dlx shadcn@latest add ...`; the one exception is the shared `Tabs` primitive, see below)

## Quick start

```css
/* In the consumer's globals.css */
@import "tailwindcss";
@import "@cinatra-ai/design/index.css";
```

**External consumers — import from the `/marketplace` subpath:**

```tsx
import {
  Main,
  PageHeader,
  PageContent,
  ExtensionCard,
  deriveExtensionAccent,
} from "@cinatra-ai/sdk-ui/marketplace";

export default function MarketplacePage() {
  return (
    <Main className="min-h-screen">
      <PageHeader title="Cinatra Marketplace" description="Discover, install, and publish free extensions." />
      <PageContent className="flex flex-col gap-6 pb-8">
        <ExtensionCard
          name="Email Outreach Agent"
          accentColor={deriveExtensionAccent("email-outreach-agent")}
          emblem={<MyIcon />}
          description="Reach out to prospects in their native language."
          footer={<button type="button">Install</button>}
        />
      </PageContent>
    </Main>
  );
}
```

The `/marketplace` subpath is the consumer-portable surface — every import in that file resolves only to files inside this package. The package's root export (`@cinatra-ai/sdk-ui`) ALSO re-exports the new primitives, but it includes cinatra-app-internal modules (background-process modal, prompt field, widget shell) that import `@/components/app-dialog` and `@/components/ui/*` from the cinatra-app monorepo. Those app-local aliases do NOT resolve outside the cinatra-app, so external consumers MUST import from `/marketplace`.

## What is NOT in this package

This package intentionally ships only Cinatra-specific composition. The underlying shadcn primitives (`Button`, `Input`, `Select`, `Dialog`, `Table`, `Sidebar`, `Tooltip`, `Avatar`, etc.) are NOT vendored here — every Cinatra-design-strict consumer should run `pnpm dlx shadcn@latest add ...` against its own `components.json` so the consumer owns its primitive copies and can update them independently.

Why this split:
- Maintaining 14+ duplicate shadcn primitives across the cinatra-app and sdk-ui guarantees design drift.
- shadcn's value is "source code in the consumer repo, not a black-box dependency"; re-shipping the primitives breaks that contract.
- The Cinatra design tokens + utility classes in `@cinatra-ai/design` are what make a shadcn primitive Cinatra-design-strict. Wire those imports first, run `shadcn add`, and the primitives inherit the palette.

### The one deliberately-exported primitive: `Tabs`

`Tabs` is the sole exception, exported from its own `@cinatra-ai/sdk-ui/tabs` subpath. Connector setup pages that ship their own bundled React (github, gmail, google-calendar, wordpress-assistant) all render the SAME design-system tablist — the underline tabs that host each connector's Setup / custom / always-last Help tabs. Here the split logic inverts: a `shadcn add tabs` per extension would create N independently-drifting copies of the one tablist users read as a single component across every connector, which is exactly the drift the split guards against. So this primitive is shared, not copied. It is pure accessible UI infra (Radix tab semantics + the design-system underline) with no connector behaviour, layout, or Help-tab policy — the extension still owns its content and composition.

It ships from a **dedicated subpath** (not the `/marketplace` barrel) on purpose: re-exporting it from `/marketplace` would pull it onto the reachable-module graph of every app route that transitively imports that barrel, tripping the route-graph no-new-rot ratchet. Import it directly:

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@cinatra-ai/sdk-ui/tabs";
```

### Connection-status + multi-connection setup primitives

The same reasoning extends to the connector setup page's **connection(s) status card**, the **Connections** list, and the **two-column setup body** (`design/specs/app-connectors.html` §II). Every connector setup page — schema-config or bundled-react — renders the SAME right-column status card and, where a connector holds many connections, the SAME Connections-tab rows and roll-up. They are pure, portable, presentational compositions (no `@/` app alias, no Radix, only design tokens + `lucide-react`), so like `Tabs` they are **shared, not copied**, and each ships from its own dedicated subpath (kept off the `/marketplace` route graph):

```tsx
import { ConnectorSetupColumns } from "@cinatra-ai/sdk-ui/connector-setup-columns";
import { ConnectionStatusCard, ConnectionsStatusCard } from "@cinatra-ai/sdk-ui/connection-status-card";
import { ConnectionStatusBadge } from "@cinatra-ai/sdk-ui/connection-status-badge";
import { ConnectionsList, ConnectionRow } from "@cinatra-ai/sdk-ui/connections-list";
```

- **`ConnectorSetupColumns`** — the `minmax(0,1fr) 236px` body (fields left, status card right; emits `connector-setup` / `connector-multi-setup`), collapsing to one column on narrow viewports.
- **`ConnectionStatusCard`** (single) / **`ConnectionsStatusCard`** (multi roll-up: one count badge per status in play, an "All connections" link, no Check).
- **`ConnectionStatusBadge`** — the solid green/red plug/unplug chip + the transient indigo **Checking…** state, in visual lockstep with the `@cinatra-ai/connectors` `ConnectorBadge`.
- **`ConnectionsList` / `ConnectionRow`** — the Connections tab's stacked per-connection cards (name, URL, badge, per-row status-following action).

The interactive controls (Check, All connections, Connect/Disconnect, the disconnect confirm dialog) are passed in as slots, so the primitives stay server-safe and the consuming connector owns the probe, navigation, and connection-level confirm copy.

## TypeScript exports

```ts
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@cinatra-ai/sdk-ui/lib/extension-accent";
```

## Versioning

Tracks the `cinatra` repo's design-system release cadence. Major bumps follow palette / primitive shape changes in the design system.
