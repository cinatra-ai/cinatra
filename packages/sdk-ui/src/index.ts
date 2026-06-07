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
export { HitlAssistField } from "./hitl-assist-field";
export type { HitlAssistFieldProps } from "./hitl-assist-field";
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
export { useBackgroundProcessModalVisibility } from "./use-background-process-modal-visibility";
export { useBackgroundProcessModalSession } from "./use-background-process-modal-session";
export { useBackgroundProcessEventStream } from "./use-background-process-event-stream";
export type { ProcessProgressStep } from "./process-progress";
export type {
  BackgroundProcessJobState,
  BackgroundProcessPromptState,
  BackgroundProcessRunStatus,
  BackgroundProcessSaveStatus,
  BackgroundProcessState,
} from "./state";
