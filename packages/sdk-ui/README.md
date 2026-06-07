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

## Works with

- `@cinatra-ai/design` (CSS tokens, fonts, utilities — required)
- React 19 + Tailwind v4
- shadcn/ui primitives (not bundled — consumers add via `pnpm dlx shadcn@latest add ...`)

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

This package intentionally ships only Cinatra-specific composition. The underlying shadcn primitives (`Button`, `Input`, `Select`, `Dialog`, `Table`, `Tabs`, `Sidebar`, `Tooltip`, `Avatar`, etc.) are NOT vendored here — every Cinatra-design-strict consumer should run `pnpm dlx shadcn@latest add ...` against its own `components.json` so the consumer owns its primitive copies and can update them independently.

Why this split:
- Maintaining 14+ duplicate shadcn primitives across the cinatra-app and sdk-ui guarantees design drift.
- shadcn's value is "source code in the consumer repo, not a black-box dependency"; re-shipping the primitives breaks that contract.
- The Cinatra design tokens + utility classes in `@cinatra-ai/design` are what make a shadcn primitive Cinatra-design-strict. Wire those imports first, run `shadcn add`, and the primitives inherit the palette.

## TypeScript exports

```ts
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@cinatra-ai/sdk-ui/lib/extension-accent";
```

## Versioning

Tracks the `cinatra` repo's design-system release cadence. Major bumps follow palette / primitive shape changes in the design system.
