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
  ArchiveActionForm,
  ConfirmActionButton,
  DisabledActionButton,
  ForceDeleteDialog,
} from "./extension-settings-actions";
import type { SettingsUpdateRow } from "./extension-settings-model";
import type { RemovalActionResult } from "../removal-failure";

const REGISTRIES_HREF = "/configuration/environment?tab=registries";

export type ExtensionSettingsActions = {
  update: () => void | Promise<void>;
  // cinatra#1061: archive RETURNS the classified removal refusal (dependents /
  // system) on failure so the client can surface it; it still redirects on
  // success (a returned value always means failure).
  archive: () => void | Promise<RemovalActionResult | void>;
  activate: () => void | Promise<void>;
  reinstall: () => void | Promise<void>;
  publish: () => void | Promise<void>;
  forceDelete: (formData: FormData) => void | Promise<void>;
};

export type ExtensionSettingsViewProps = {
  kind: ExtensionKind;
  packageName: string;
  displayName: string;
  vendor: string | null;
  /**
   * The §V Maintenance · Update row — the §III card update state spelled out
   * in words (resolveUpdateRow), with the button live only when there is an
   * update to run. This row is where the explanatory wording lives; the §III
   * card carries at most the Update-available chip.
   */
  updateRow: SettingsUpdateRow;
  /** Disabled-action reasons (null ⇒ enabled) — the #1036 lifecycle-ui mechanism. */
  archiveDisabled: string | null;
  activateDisabled: string | null;
  reinstallDisabled: string | null;
  forceDeleteDisabled: string | null;
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
  actions: ExtensionSettingsActions;
};

export function ExtensionSettingsView({
  kind,
  packageName,
  displayName,
  vendor,
  updateRow,
  archiveDisabled,
  activateDisabled,
  reinstallDisabled,
  forceDeleteDisabled,
  archiveDependents,
  isPublic,
  isRegisteredVendor,
  canPublish,
  permissions,
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
              button greys out whenever there is nothing to run. */}
          <SettingsRow
            title="Update"
            description={updateRow.description}
            action={
              updateRow.enabled ? (
                <form action={actions.update}>
                  <Button type="submit" className="flex-none">
                    <RefreshCw data-icon="inline-start" />
                    Update
                  </Button>
                </form>
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
                <DisabledActionButton label="Archive" variant="outline" reason={archiveDisabled} />
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
            last
            muted={Boolean(activateDisabled)}
            action={
              activateDisabled ? (
                <DisabledActionButton label="Activate" variant="outline" reason={activateDisabled} />
              ) : (
                <form action={actions.activate}>
                  <Button type="submit" variant="outline" className="flex-none">
                    Activate
                  </Button>
                </form>
              )
            }
          />
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
                <DisabledActionButton
                  label="Reinstall latest"
                  variant="destructive"
                  reason={reinstallDisabled}
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
                <DisabledActionButton
                  label="Force-delete…"
                  variant="destructive"
                  reason={forceDeleteDisabled}
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
