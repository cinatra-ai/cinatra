// ---------------------------------------------------------------------------
// Presentational view for the per-extension Settings page (design §V).
//
// Pure presentation: all data + server actions are injected by the caller
// (extension-settings-screen loads them; the design-conformance fixture seeds
// them). No data access here — the loader/fixture split mirrors the §VI
// installed-empty-states extraction (cinatra#986) so the seeded harness renders
// the SAME surface the real route does.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw, Store, TriangleAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@/lib/extension-accent";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { KIND_LABEL } from "./installed-rows";
import type { ExtensionKind } from "../canonical-types";
import {
  RecoveryActionForm,
  ArchiveActionForm,
  ConfirmActionButton,
  DisabledActionButton,
  ForceDeleteDialog,
} from "./extension-settings-actions";
import type { SettingsUpdateRow } from "./extension-settings-model";
import type { RemovalActionResult } from "../removal-failure";
import type { MarketplaceInstallActionResult } from "./marketplace-failure-copy";

const REGISTRIES_HREF = "/configuration/environment?tab=registries";

export type ExtensionSettingsActions = {
  // NOTE (cinatra#1041): there is deliberately NO update action here — the §V
  // Maintenance · Update row's live button OPENS the §II detail-modal update
  // flow (a link to the Installed page with `?update=<pkg>`); the update
  // itself runs only from that modal footer (dry-run plan → admin confirm).
  // cinatra#1061: archive RETURNS the classified removal refusal (dependents /
  // system) on failure so the client can surface it; it still redirects on
  // success (a returned value always means failure).
  archive: () => void | Promise<RemovalActionResult | void>;
  activate: () => void | Promise<void>;
  // cinatra#2762 recovery pair. Shown only for a PRODUCT install, because a
  // package that only ships in the image has nothing to retry and nothing to
  // roll back to. `retryActivation` re-fires the in-process activate hook after
  // an operator fixes what refused it; `rollBackToBundled` archives the override
  // and puts the image's own version back in service.
  retryActivation: () => void | Promise<MarketplaceInstallActionResult | void>;
  rollBackToBundled: () => void | Promise<MarketplaceInstallActionResult | void>;
  reinstall: () => void | Promise<void>;
  publish: () => void | Promise<void>;
  forceDelete: (formData: FormData) => void | Promise<void>;
};

export type ExtensionSettingsViewProps = {
  kind: ExtensionKind;
  packageName: string;
  displayName: string;
  /** cinatra#2762: which recovery affordances this package can offer. */
  recovery?: { showRetryActivation: boolean; showRollBackToBundled: boolean };
  vendor: string | null;
  /**
   * The §V Maintenance · Update row — the §III card update state spelled out
   * in words (resolveUpdateRow), with the button live only when there is an
   * update to run. This row is where the explanatory wording lives; the §III
   * card carries at most the Update-available chip.
   */
  updateRow: SettingsUpdateRow;
  /** Disabled-action reasons (null ⇒ enabled) — the #1036 lifecycle-ui mechanism
   *  and, since cinatra#2416, the server-derived lifecycle capability. */
  archiveDisabled: string | null;
  activateDisabled: string | null;
  reinstallDisabled: string | null;
  forceDeleteDisabled: string | null;
  /**
   * cinatra#2416: the subset of the four reasons above that a SERVER-DERIVED
   * capability denial produced (addressability / standing — the verdict of the
   * very resolver that enforces the op). Rendered as visible muted copy beside
   * the greyed button, the way §V already renders a disabled action's reason
   * (the Marketplace "…isn't available for this extension yet." line and the
   * Update row's spelled-out description): a scope refusal is not deducible
   * from the page otherwise, unlike "Already archived".
   *
   * Presentation-optional (an unseeded fixture simply renders no line); the
   * REAL loader always supplies it, and the enabled state itself always comes
   * from the server verdict via the four reasons above.
   */
  lifecycleCapabilityReasons?: Partial<
    Record<"archive" | "activate" | "reinstall" | "forceDelete", string>
  >;
  /**
   * cinatra#1061 req 4: package names of ACTIVE dependents that require this
   * extension — the same predicate the archive/uninstall closure gate refuses
   * on. Rendered as a pre-submit preview under the Archive affordance so an
   * operator sees the blockers BEFORE clicking, not just after the refusal.
   */
  archiveDependents?: string[];
  isPublic: boolean;
  isRegisteredVendor: boolean;
  canPublish: boolean;
  /** The Permissions control (access picker) or a deferred note. */
  permissions: ReactNode;
  /**
   * The per-agent EXECUTION config section (exec-plane S3 slice B,
   * cinatra#1708) — execution on/off, the declared L1 environment, and the
   * promotion affordance. Injected as a node so this presentational view takes
   * no execution-plane dependency; absent for every non-agent kind.
   */
  execution?: ReactNode;
  /**
   * The per-agent SKILLS config section (agent-skills S4, cinatra#2349; epic
   * #2345) — the chooser for the skills this agent always uses, plus the
   * chosen rows. Injected as a node for the same reason `execution` is: this
   * presentational view takes no skills-plane dependency. Absent for every
   * non-agent kind AND for assistant-kind agents (the caller decides, from
   * authoritative declaration/registry data — never a name suffix).
   */
  skills?: ReactNode;
  actions: ExtensionSettingsActions;
};

export function ExtensionSettingsView({
  kind,
  packageName,
  displayName,
  recovery,
  vendor,
  updateRow,
  archiveDisabled,
  activateDisabled,
  reinstallDisabled,
  forceDeleteDisabled,
  lifecycleCapabilityReasons,
  archiveDependents,
  isPublic,
  isRegisteredVendor,
  canPublish,
  permissions,
  execution,
  skills,
  actions,
}: ExtensionSettingsViewProps) {
  const { bg } = ACCENT_PALETTE[deriveExtensionAccent(packageName)];

  return (
    <main data-surface-id="extension-settings" className="min-h-screen">
      <div className="mx-auto w-full max-w-[576px] px-6 py-8 sm:py-10">
        {/* §V settings header — the §II detail header (name + byline CENTRED
            vertically against the logo, 0.5.0), with nothing in the top-right. */}
        <div className="flex items-center gap-4.5">
          <div
            data-slot="extension-settings-tile"
            className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[15px] border border-line bg-surface-strong shadow-sm"
            style={{ color: bg }}
          >
            {extensionKindEmblem(kind as ExtensionEmblemKind, "size-8.5")}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1
              data-slot="extension-settings-name"
              className="font-display text-modal-title font-extrabold italic text-foreground"
            >
              {displayName}
            </h1>
            <p className="flex items-center gap-1.25 text-sm text-muted-foreground">
              <span aria-hidden="true" className="shrink-0" style={{ color: bg }}>
                {extensionKindEmblem(kind as ExtensionEmblemKind, "size-3.5")}
              </span>
              <span className="min-w-0 truncate">
                <span className="text-foreground">{KIND_LABEL[kind]}</span>
                {vendor ? (
                  <>
                    {" by "}
                    <span className="text-foreground">{vendor}</span>
                  </>
                ) : null}
              </span>
            </p>
          </div>
        </div>

        {/* Double-etched header rule. */}
        <div className="my-5 h-[5px] border-y border-line-strong" />

        {/* Permissions */}
        <section data-slot="settings-permissions" className="border-b border-line py-5.5">
          <h2 className="mb-3.5 text-lg font-bold text-foreground">Permissions</h2>
          {permissions}
        </section>

        {/* Execution — the per-agent execution config (agent kind only).
            Sits directly under Permissions: both answer "what is this agent
            allowed to do here", and both are per-agent grants on the same
            config surface. */}
        {execution ? (
          <section data-slot="settings-execution" className="border-b border-line py-5.5">
            <h2 className="mb-3.5 text-lg font-bold text-foreground">Execution</h2>
            {execution}
          </section>
        ) : null}

        {/* Skills — the per-agent skill choices (agent kind only, assistants
            excluded). LAST of the per-agent configuration group, directly
            above Marketplace: Permissions / Execution / Skills all answer
            "how does this agent behave here", and the lifecycle actions stay
            below them (design §V). */}
        {skills ? (
          <section data-slot="settings-skills" className="border-b border-line py-5.5">
            <h2 className="mb-3.5 text-lg font-bold text-foreground">Skills</h2>
            {skills}
          </section>
        ) : null}

        {/* Marketplace */}
        <section data-slot="settings-marketplace" className="border-b border-line py-5.5">
          <h2 className="mb-3.5 text-lg font-bold text-foreground">Marketplace</h2>
          {isPublic ? (
            <p className="text-sm text-muted-foreground">Published on the marketplace.</p>
          ) : canPublish ? (
            <ConfirmActionButton
              triggerLabel="Publish on marketplace"
              triggerIcon={<Store data-icon="inline-start" />}
              triggerVariant="destructive"
              title="Publish on the marketplace?"
              description={
                <>
                  Publishes <strong className="text-foreground">{displayName}</strong> to the
                  marketplace, where anyone can install it. This is{" "}
                  <strong className="text-destructive">one-way</strong> — it cannot be demoted
                  back to private.
                </>
              }
              confirmLabel="Publish on marketplace"
              confirmVariant="default"
              action={actions.publish}
            />
          ) : !isRegisteredVendor ? (
            <div className="flex flex-wrap items-center gap-2">
              <DisabledActionButton
                label="Publish on marketplace"
                icon={<Store data-icon="inline-start" />}
                variant="destructive"
                reason="Register this instance as a marketplace vendor to publish."
              />
              <Button asChild variant="outline">
                <Link href={REGISTRIES_HREF}>
                  <ExternalLink data-icon="inline-start" />
                  Register for marketplace
                </Link>
              </Button>
            </div>
          ) : (
            <DisabledActionButton
              label="Publish on marketplace"
              icon={<Store data-icon="inline-start" />}
              variant="destructive"
              reason="Marketplace publishing isn't available for this extension yet."
            />
          )}
        </section>

        {/* Maintenance */}
        <section data-slot="settings-maintenance" className="py-5.5">
          <h2 className="mb-3.5 text-lg font-bold text-foreground">Maintenance</h2>

          {/* §V Maintenance · Update — the update status as the row's
              description (the §III card states spelled out in words); the
              button greys out whenever there is nothing to run. The LIVE
              button opens the §II detail-modal update flow on the Installed
              page (`?update=<pkg>` auto-opens this extension's modal) — the
              update itself runs ONLY there (dry-run plan → admin confirm),
              never directly from this row (cinatra#1041). */}
          <SettingsRow
            title="Update"
            description={updateRow.description}
            action={
              updateRow.enabled ? (
                <Button asChild className="flex-none">
                  <Link
                    data-slot="settings-update-link"
                    href={`/configuration/extensions?update=${encodeURIComponent(packageName)}`}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Update
                  </Link>
                </Button>
              ) : (
                <DisabledActionButton
                  label="Update"
                  icon={<RefreshCw data-icon="inline-start" />}
                  variant="default"
                  reason={updateRow.disabledReason}
                />
              )
            }
          />

          <SettingsRow
            title="Archive"
            description="Deactivate the extension. It moves to the Archived tab and can be restored."
            action={
              archiveDisabled ? (
                <DisabledLifecycleAction
                  label="Archive"
                  variant="outline"
                  reason={archiveDisabled}
                  capabilityReason={lifecycleCapabilityReasons?.archive}
                />
              ) : (
                <ArchiveActionForm
                  action={actions.archive}
                  displayName={displayName}
                  dependents={archiveDependents}
                />
              )
            }
          />

          {/* Activate — complementary to Archive: exactly one is live. */}
          <SettingsRow
            title="Activate"
            description="Reactivate an archived extension. Available once the extension is archived."
            last={!recovery?.showRetryActivation && !recovery?.showRollBackToBundled}
            muted={Boolean(activateDisabled)}
            action={
              activateDisabled ? (
                <DisabledLifecycleAction
                  label="Activate"
                  variant="outline"
                  reason={activateDisabled}
                  capabilityReason={lifecycleCapabilityReasons?.activate}
                />
              ) : (
                <form action={actions.activate}>
                  <Button type="submit" variant="outline" className="flex-none">
                    Activate
                  </Button>
                </form>
              )
            }
          />
          {/* cinatra#2762: the operator path out of an install that will not
              serve. Rendered only for a product install (the image's own copy has
              nothing to retry), and Roll back only when the image actually
              carries a version to fall back to. */}
          {recovery?.showRetryActivation ? (
            <SettingsRow
              title="Retry activation"
              description="Try to start this version again in the running app. Use it after fixing what refused it, such as a missing signing key or an untrusted registry."
              last={!recovery?.showRollBackToBundled}
              action={
                <RecoveryActionForm
                  action={actions.retryActivation}
                  label="Retry activation"
                  pendingLabel="Retrying…"
                  failureMessage={`Couldn't start ${displayName} in the running app. The version bundled with the app is unaffected.`}
                />
              }
            />
          ) : null}
          {recovery?.showRollBackToBundled ? (
            <SettingsRow
              title="Roll back to bundled"
              description="Archive this install and go back to the version that ships with the app. The archived install keeps its data and can be restored."
              last
              action={
                <RecoveryActionForm
                  action={actions.rollBackToBundled}
                  label="Roll back to bundled"
                  pendingLabel="Rolling back…"
                  failureMessage={`Rolled ${displayName} back, but the bundled version couldn't be started in the running app. It returns after the next restart.`}
                />
              }
            />
          ) : null}
        </section>

        {/* Danger zone */}
        <div
          data-slot="settings-danger-zone"
          className="mt-5.5 rounded-[10px] border border-destructive/34 bg-destructive/5 px-4.5 py-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
            <h2 className="text-lg font-bold text-destructive">Danger zone</h2>
          </div>

          <DangerRow
            title="Reinstall latest"
            description={
              <>
                Uninstall → reinstall at the newest version. For an{" "}
                <strong className="text-foreground">unused</strong> extension the uninstall is a
                hard delete — if the reinstall fails there is nothing to restore.
              </>
            }
            action={
              reinstallDisabled ? (
                <DisabledLifecycleAction
                  label="Reinstall latest"
                  variant="destructive"
                  reason={reinstallDisabled}
                  capabilityReason={lifecycleCapabilityReasons?.reinstall}
                />
              ) : (
                <ConfirmActionButton
                  triggerLabel="Reinstall latest"
                  triggerVariant="destructive"
                  title={`Reinstall ${displayName}?`}
                  description="Uninstalls, then reinstalls at the newest version. For an unused extension the uninstall is a hard delete — if the reinstall fails there is nothing to restore."
                  confirmLabel="Reinstall latest"
                  confirmVariant="destructive"
                  action={actions.reinstall}
                />
              )
            }
          />

          <DangerRow
            title="Force-delete"
            description="Hard delete + dangling-reference cleanup. Bypasses restore entirely and requires a typed reason for the audit log."
            last
            action={
              forceDeleteDisabled ? (
                <DisabledLifecycleAction
                  label="Force-delete…"
                  variant="destructive"
                  reason={forceDeleteDisabled}
                  capabilityReason={lifecycleCapabilityReasons?.forceDelete}
                />
              ) : (
                <ForceDeleteDialog
                  displayName={displayName}
                  triggerIcon={<Trash2 data-icon="inline-start" />}
                  action={actions.forceDelete}
                />
              )
            }
          />
        </div>
      </div>
    </main>
  );
}

/**
 * A greyed lifecycle affordance (cinatra#2416). The button keeps §V's existing
 * disabled treatment — `disabled` + `aria-disabled` + the reason as its tooltip
 * (`DisabledActionButton`, the same treatment the access picker uses for its
 * standing-refused rows). When the refusal came from the SERVER-DERIVED
 * capability, the reason ALSO renders as a visible muted line beside it, the way
 * §V already spells out a disabled action's reason — a scope refusal is not
 * deducible from anything else on the page.
 */
function DisabledLifecycleAction({
  label,
  variant,
  reason,
  capabilityReason,
}: {
  label: string;
  variant: "outline" | "destructive";
  reason: string;
  capabilityReason?: string;
}) {
  if (!capabilityReason) {
    return <DisabledActionButton label={label} variant={variant} reason={reason} />;
  }
  return (
    <div className="flex flex-none flex-col items-end gap-1.5">
      <DisabledActionButton label={label} variant={variant} reason={reason} />
      <p
        data-slot="lifecycle-capability-reason"
        className="max-w-xs text-right text-xs text-muted-foreground"
      >
        {capabilityReason}
      </p>
    </div>
  );
}

/** A Maintenance row: title + description on the left, an action on the right. */
function SettingsRow({
  title,
  description,
  action,
  last = false,
  muted = false,
}: {
  title: string;
  description: string;
  action: ReactNode;
  last?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-center justify-between gap-4 py-3.5",
        last ? "" : "border-b border-line",
        muted ? "opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="max-w-[56ch]">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>
      </div>
      {action}
    </div>
  );
}

/** A Danger-zone row: red-hairline divided. */
function DangerRow({
  title,
  description,
  action,
  last = false,
}: {
  title: string;
  description: ReactNode;
  action: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-center justify-between gap-4 py-3",
        last ? "" : "border-b border-destructive/20",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="max-w-[56ch]">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>
      </div>
      {action}
    </div>
  );
}
