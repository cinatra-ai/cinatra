// Ships ONLY from its own `@cinatra-ai/sdk-ui/connector-setup-page` subpath —
// deliberately NOT re-exported from the `.` (index) or `/marketplace` barrels,
// exactly like the `Tabs` primitive. Adding a module to a barrel puts it on the
// reachable first-party module graph of every app route that transitively
// imports that barrel, which trips the route-graph no-new-rot ratchet. Extension
// setup pages import it directly:
//   import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
import type { ReactNode } from "react";
import { Main } from "./main";
import {
  PageHeader,
  type PageHeaderSize,
  type PageHeaderTone,
} from "./page-header";
import { PageContent } from "./page-content";
import { cn } from "./lib/utils";

/** The design-system "Wide" content column — max-w-3xl · 768px (app-connectors.html §II). */
const SETUP_WIDE_COLUMN = "max-w-3xl";

export interface ConnectorSetupPageProps {
  /** Connector name — the page-title h1. */
  title: string;
  /** Small contextual label rendered above the h1. */
  label?: string;
  /** Sub-title beneath the h1 (e.g. "Connector setup"). */
  description?: string;
  /** Right-side header actions (e.g. the connection-status badge). */
  actions?: ReactNode;
  /** Page-title display scale — see {@link PageHeader}. */
  size?: PageHeaderSize;
  /** Page-title color tone — see {@link PageHeader}. */
  tone?: PageHeaderTone;
  /**
   * Render the etched section rule beneath the header. Default ON (matches the
   * single-connection spec chrome). A tabbed setup page whose tab row already
   * carries the rule passes `divider={false}` so the two rules never stack.
   */
  divider?: boolean;
  /** The setup-page body (form, tabs, cards…). */
  children: ReactNode;
  /** Extra classes on the content region beneath the header. */
  className?: string;
  /** Extra classes on the outer `<main>`. */
  mainClassName?: string;
}

/**
 * ConnectorSetupPage — the canonical connector setup-page shell.
 *
 * Renders the page header AND the content in the single centered "Wide" column
 * (`max-w-3xl` · 768px, per `design/specs/app-connectors.html` §II — "The page
 * holds to the Wide column and never spans full width"), so the header's left
 * edge always aligns with the content's — the header never spans full width.
 *
 * It does this by constraining BOTH the shared `PageHeader` and `PageContent`
 * to the same Wide width. Those two primitives already share an alignment
 * contract ("PageContent matches the max-width and horizontal padding of
 * PageHeader so columns stay aligned"); this shell simply pins both to the Wide
 * width instead of the default `max-w-7xl`, so their left edges coincide at
 * every breakpoint. The Wide width is applied AFTER the consumer `className`,
 * so a plain `max-w-*` in `className` cannot silently narrow one side and
 * re-introduce the header↔content misalignment this component exists to
 * prevent (a deliberately breakpoint- or `!`-flagged width would still win,
 * but that is out of contract).
 *
 * Every connector setup page composes this instead of hand-rolling
 * `Main` + `PageHeader` + a separate content frame, so the alignment is
 * structural and uniform across connectors.
 *
 * @example
 * <ConnectorSetupPage title="OpenAI" description="Connector setup" actions={statusBadge}>
 *   <ConfigForm … />
 * </ConnectorSetupPage>
 *
 * @example  // tabbed page — its tab row owns the section rule
 * <ConnectorSetupPage title="WordPress Widget" description="…" divider={false}>
 *   <Tabs …>…</Tabs>
 * </ConnectorSetupPage>
 */
export function ConnectorSetupPage({
  title,
  label,
  description,
  actions,
  size,
  tone,
  divider = true,
  children,
  className,
  mainClassName,
}: ConnectorSetupPageProps) {
  return (
    <Main className={cn("min-h-screen", mainClassName)}>
      <PageHeader
        title={title}
        label={label}
        description={description}
        actions={actions}
        size={size}
        tone={tone}
        divider={divider}
        className={SETUP_WIDE_COLUMN}
      />
      <PageContent className={cn(className, SETUP_WIDE_COLUMN)}>
        {children}
      </PageContent>
    </Main>
  );
}
