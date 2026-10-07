// Cinatra design-system page chrome + canonical patterns.
export { Main } from "./main";
export { PageHeader } from "./page-header";

export type { PageHeaderSize, PageHeaderTone } from "./page-header";
export { PageContent } from "./page-content";
export { StatusPill } from "./status-pill";
export type { StatusPillStatus, StatusPillProps } from "./status-pill";
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

// Public field-renderer props contract (cinatra#1625, epic #1620 S8 — M3). The
// stable public mirror a claiming extension's migrated HITL renderer imports its
// props TYPE from; `@cinatra-ai/agents` re-exports the same types for in-core
// code. Only the structural TYPES are re-exported from this root barrel — they
// are erased at build, so a route reaching this hot barrel does not pull the
// props leaf into its first-party module graph. The runtime
// `FIELD_RENDERER_PROPS_API_VERSION` constant is intentionally NOT re-exported
// here: its sole host consumer (packages/agents/src/field-renderer-components.ts)
// reads it from the zero-runtime `@cinatra-ai/sdk-ui/field-renderer-props`
// subpath — which is also the canonical path an extension uses — so no consumer
// needs the value from this barrel. Re-exporting the value here would accrete the
// leaf into every route that touches sdk-ui (the route-graph ratchet caught
// exactly that: /sign-in grew by one module). The subpath test locks this in.
export type {
  FieldRendererProps,
  FieldRendererContext,
  RendererMode,
  GmailSendAsAliasOption,
} from "./field-renderer-props";

// Connector/dialog UI primitives + notification context (consumed by extension
// settings/setup pages so they need no `@/` host edge).
export { AppDialog } from "./app-dialog";
export { ConnectorSettingsDialog } from "./connector-settings-dialog";
export { NotificationContext, useNotify } from "./notification-context";
export type {
  AddNotificationInput,
  NotificationContextValue,
} from "./notification-context";

// Widget / background-process / hitl primitives.
export { LoadingSpinner } from "./loading-spinner";
export { InlinePageTitle } from "./inline-page-title";
export type { InlinePageTitleProps, InlinePageTitleHandle } from "./inline-page-title";
export { PromptField } from "./prompt-field";
export type { PromptFieldHandle, PromptFieldProps, PromptFieldAutosave, Mentionable } from "./prompt-field";
export { WidgetShell, useWidgetData } from "./widget";
export type {
  WidgetProps,
  WidgetSubmitHandle,
  WidgetDefinition,
  WidgetManifest,
  WizardDeclaration,
  WizardStep,
  DataBinding,
  StagingDeclaration,
  ConfirmationDeclaration,
  WidgetDetector,
} from "./widget";
export { BackgroundProcessModal } from "./background-process-modal";
export { BackgroundProcessModalActions } from "./background-process-modal-actions";
export { BackgroundProcessStatusBanner } from "./background-process-status-banner";
export { ProcessProgressList } from "./process-progress";
export { useBackgroundProcessModalSession } from "./use-background-process-modal-session";
export type { ProcessProgressStep } from "./process-progress";
export type {
  BackgroundProcessJobState,
  BackgroundProcessPromptState,
  BackgroundProcessRunStatus,
  BackgroundProcessSaveStatus,
  BackgroundProcessState,
} from "./state";
