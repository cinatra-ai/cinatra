/**
 * `@cinatra-ai/sdk-ui/marketplace` — portable Cinatra-design React primitives.
 *
 * Consumer-portable subpath: every export here resolves only to
 * `./lib/utils`, `./lib/extension-accent`, and other files inside this
 * package. NO `@/components/*` or `@/lib/utils` app-local aliases. Safe to
 * `pnpm install @cinatra-ai/sdk-ui` from any Cinatra-design-strict surface
 * (e.g. the marketplace public app) and import via this subpath.
 *
 * The package's root export (`@cinatra-ai/sdk-ui`) still re-exports the
 * cinatra-app-internal modules (background-process-modal, prompt-field,
 * widget shell, etc.) which import `@/components/app-dialog` and
 * `@/components/ui/*` from the cinatra-app monorepo. Those are NOT
 * consumer-portable; external consumers MUST import from this subpath.
 */

export { Main } from "./main";
export { PageHeader } from "./page-header";
export type { PageHeaderSize, PageHeaderTone } from "./page-header";
export { PageContent } from "./page-content";
export {
  SectionHeader,
  Kicker,
  kickerVariants,
  sectionTitleVariants,
} from "./section-header";
export type { SectionHeaderProps, KickerProps } from "./section-header";


export { StatusPill } from "./status-pill";
export type { StatusPillStatus, StatusPillProps } from "./status-pill";
export { NangoUserConnectButton } from "./nango-user-connect-button";
export type { NangoFrontendConfig } from "./nango-user-connect-button";
export { ExtensionCard } from "./extension-card";
export type {
  ExtensionAccent,
  ExtensionCardProps,
  ExtensionIndicator,
} from "./extension-card";
export {
  EXTENSION_ACCENTS,
  ACCENT_PALETTE,
  asExtensionAccent,
  deriveExtensionAccent,
} from "./lib/extension-accent";
export type { AccentTone } from "./lib/extension-accent";
export { cn } from "./lib/utils";

// NOTE: the accessible design-system `Tabs` primitive is deliberately NOT
// re-exported here — it ships only from its own `@cinatra-ai/sdk-ui/tabs`
// subpath. Re-exporting it from this barrel would pull it onto the reachable
// module graph of every app route that transitively imports `/marketplace`
// (via a connector), tripping the route-graph no-new-rot ratchet. Extension
// setup pages import it directly: `import { Tabs } from "@cinatra-ai/sdk-ui/tabs"`.
