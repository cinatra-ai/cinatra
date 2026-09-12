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

### The Sharing tab: `@cinatra-ai/sdk-ui/connector-sharing-panels`

The connector setup page's SECOND fixed tab (`design/specs/app-connectors.html` §II, the Sharing tab): a roll-up card above a list of panels, one panel per connection the actor owns on this connector, each panel the connection's identity row (name + mono line, no status badge and no per-row action) over the access picker and its ownership card. The app GENERATES the setup page of the connectors whose pack declares `cinatra.uiSurface: "schema-config"` in its `package.json` — at the time of writing anthropic, apify, apollo, gemini, google-appointment-schedules, mcp-server and openai — and draws this tab on it. A connector that ships its own React setup page draws its own header and tab strip, so the app has no seam to inject a tab into and injects nothing: that pack draws the tab itself, from here. Like `Tabs` and the connection primitives above, it is **shared, not copied**, from its own dedicated subpath — one implementation, so the same DOM is graded wherever the tab is drawn.

**The one addition a pack makes** — the component, as the tab right after its own Setup tab:

```tsx
import { ConnectorSharingPanels } from "@cinatra-ai/sdk-ui/connector-sharing-panels";

<TabsContent value="sharing">
  <ConnectorSharingPanels panels={panels} />
</TabsContent>
```

**Props.**

- **`panels`** — one `ConnectorSharingPanelView` per owned connection, in list order: `key` (the connection identity row id), `name` (the connection's display name), `url` (the mono secondary line), `scopeConstraint` (`"locked"` where the connector declares a ceiling on how far its connections travel, `"recommended"` where it only recommends a scope, `null` where it constrains nothing), and `permissions` — that panel's access picker and ownership card, handed in as a NODE whose actions are already bound as callbacks. The pack resolves the views through the same read road its own setup page already uses for its connections. The component is presentational and server-safe (no session, no database) and mounts no client of its own, so a pack never ends up drawing a connector-specific copy of the two controls.
- **`state`** — `"loading"` draws the declared loading treatment in the list's place; `"ready"` (the default) draws the list.
- **`rollup`** — `"always"` (the default, and the tab's own rule) heads the list with the roll-up card whenever there IS a list; `"multiple"` keeps the plural-only rule of the pages that draw no tab strip.
- **`CONNECTOR_SHARING_INTRO`** carries the drawing's own line for the tab, so every page says the same words.

**The surfaces it emits, and what the pack declares.** The component emits three design-conformance surfaces: `connector-sharing` (one panel — the `name`, `url`, `access` and `co-owners` bindings, the `select-scope` / `search-people` / `remove-co-owner` / `save-access` actions, and the `loading` state), `connector-sharing-rollup` (the roll-up card: no Check and no "All connections" link) and `connector-sharing-locked` (`data-variant="locked"` or `data-variant="recommended"`). Those three ids are declared by the ratified drawing's own `app-connectors` conformance manifest and answered by the functional-acceptance drivers of the same names, so a pack that draws this component is graded against the same drawing as the app's generated page: it declares no id of its own, adds none, and renames none. The pack-side declaration is the UI-surface one it already carries — a pack that draws its own setup page is the one that does NOT declare `cinatra.uiSurface: "schema-config"`, and it is that pack which makes the addition above.

### First-party glyphs: `@cinatra-ai/sdk-ui/icons`

Design-spec marks the lucide set does not carry, built with lucide's own public `createLucideIcon` factory so each one is a drop-in for a lucide icon (same `LucideProps`, same 24x24 `stroke="currentColor"` chrome, same automatic `aria-hidden`). Exported from its own `@cinatra-ai/sdk-ui/icons` subpath — never from the root or `/marketplace` barrels.

```tsx
import { PlugConnected } from "@cinatra-ai/sdk-ui/icons";
```

- **`PlugConnected`** — the joined plug (`design/specs/app-connectors.html` 0.7.0): the two halves of lucide's `Unplug` with the gap closed and the loose prong strokes dropped. The Connected counterpart of `Unplug` everywhere connection status is shown — the `/connectors` toggle segment and card badge, the setup page's `ConnectionStatusBadge`, and the setup form's Connect action.
- **`PlugConnectorKind`** — the "connector" extension-KIND emblem (the ratified card spec's byline drawing): the lower half of the joined plug, recentred and rescaled across the full 24-unit viewBox so it reads clean at the 13px byline size. The KIND sibling of the STATUS mark above — one icon family, two distinct exports that never substitute for each other.

The module is a registry, not a single-glyph file: each glyph exports its `IconNode` path set alongside the component, so a new first-party mark is one node + one `createLucideIcon` line.

## TypeScript exports

```ts
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@cinatra-ai/sdk-ui/lib/extension-accent";
```

## Versioning

Tracks the `cinatra` repo's design-system release cadence. Major bumps follow palette / primitive shape changes in the design system.
