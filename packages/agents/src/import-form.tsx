"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileIcon, Trash2Icon, CloudUploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dropzone,
  DropZoneArea,
  DropzoneFileList,
  DropzoneFileListItem,
  DropzoneFileMessage,
  DropzoneMessage,
  DropzoneRemoveFile,
  DropzoneTrigger,
  InfiniteProgress,
  useDropzone,
} from "@/components/ui/dropzone";
import { importAgentTemplate } from "./import-export-actions";
import { LicenseWarningDialog } from "@cinatra-ai/extensions/components/license-warning-dialog";
// The upload form's first-class scope picker: the checkbox multi-select
// mode of the unified access picker. It configures which scopes can access
// the uploaded extension; the publish destination is no longer user-facing —
// an uploaded extension always lands in the local registry by default
// (owner ruling on cinatra#2644).
import { AccessCombobox } from "@/components/access-combobox";
import {
  normalizeVisibilitySelection,
  type AgentAuthPolicyVisibility,
} from "./auth-policy-types";

// The permissions draft SHAPE is shared with the GitHub install form; the
// advanced ownership PANEL itself was removed from this form (cinatra#2643
// review round — ownership is managed post-upload on the extension's own
// permissions surface).
import type { PermissionsFormDraftValue } from "@/components/permissions-form-draft";
import type { AvailableScopes } from "@/components/access-combobox";
import { toast } from "@/lib/cinatra-toast";

// Archive reading lives in upload-archive.ts (cinatra#2643): it accepts the
// standardized published-package layout (package.json cinatra.entrypoint →
// cinatra/oas.json, optionally under one top-level <slug>/ folder) plus the
// legacy flat agent.json shape, inflates deflate-compressed entries, and
// repacks the resolved files into the flat stored-method ZIP the server
// importer consumes.
import {
  readZipArchive,
  resolveAgentArchive,
  resolveUploadedExtensionArchive,
  buildCanonicalAgentZip,
  computeCanonicalAgentZipDigest,
  bytesToBase64,
  type UploadableExtensionKind,
} from "./upload-archive";
// cinatra#3204 (criterion 11): the store's OWN install-scope picker, mounted
// here rather than re-implemented. The Upload screen resolves the same
// server-computed rows the marketplace grid resolves and hands them down.
import {
  InstallScopePickerBody,
  resolveInstallScopeSelection,
  type InstallScopeFieldContext,
} from "@cinatra-ai/extensions/screens/install-scope-field";

type AgentPreview = {
  name: string;
  description: string | null;
  sourceNl: string;
  zipBase64: string;
  fileName: string;
  /** The kind READ from the package (cinatra#3204), never assumed. */
  kind: UploadableExtensionKind;
  packageName: string | null;
  packageVersion: string | null;
  /** The D2 digest over the DELIVERED tree — what the operator handed over. */
  contentDigest: string;
  /**
   * The D2 digest over the tree the request actually CARRIES (the canonical
   * repack). It is a different file set from the delivered tree, so it is a
   * different digest, and it is this one the server can recompute from the
   * bytes it received. Null for a kind this screen cannot submit yet.
   */
  sentTreeDigest: string | null;
};

async function parseZipFile(file: File): Promise<AgentPreview> {
  const buf = await file.arrayBuffer();
  // cinatra#3204 (criteria 1-5): hardened, KIND-AWARE intake. The archive is
  // read under path/symlink/entry-count/size refusals, its declared kind is
  // resolved and checked against the payload that backs it, and the delivered
  // tree is digested — all before anything is shown, and without executing a
  // single byte of the package.
  const entries = await readZipArchive(buf);
  const pkg = await resolveUploadedExtensionArchive(entries);

  // Only an AGENT package continues into the agent import path below. The other
  // three kinds are READ and previewed here (their kind, name and version are
  // known and shown), and the submit states plainly that this screen cannot
  // finish their install yet — see the disabled-submit copy in the form.
  if (pkg.kind !== "agent") {
    return {
      name: pkg.packageName ?? file.name,
      description: null,
      sourceNl: "",
      zipBase64: "",
      fileName: file.name,
      kind: pkg.kind,
      packageName: pkg.packageName,
      packageVersion: pkg.packageVersion,
      contentDigest: pkg.contentDigest,
      sentTreeDigest: null,
    };
  }
  const resolved = resolveAgentArchive(entries);

  if (resolved.manifestJson) {
    let m: { version?: number };
    try {
      m = JSON.parse(resolved.manifestJson) as { version?: number };
    } catch {
      throw new Error("Invalid archive: manifest.json is not valid JSON.");
    }
    if (m.version !== 1) throw new Error(`Unsupported manifest version: ${m.version}`);
  }

  let agent: {
    component_type?: string;
    agentspec_version?: string;
    name?: string;
    description?: string | null;
    status?: string;
    sourceNl?: string;
    metadata?: { cinatra?: { type?: string } };
  };
  try {
    agent = JSON.parse(resolved.agentJson) as typeof agent;
  } catch {
    throw new Error("Invalid archive: the agent definition is not valid JSON.");
  }
  // Accept compact OAS Flow documents only.
  if (agent.agentspec_version !== "26.1.0" || agent.component_type !== "Flow") {
    throw new Error(`Unsupported agent format (expected OAS v26.1.0 Flow).`);
  }

  // Repack into the flat stored-method shape importAgentTemplateCore
  // consumes (root agent.json + manifest/package/license sidecars) — the
  // server contract is unchanged; the acceptance widening is client-side.
  const canonical = buildCanonicalAgentZip(resolved);
  const sentTreeDigest = await computeCanonicalAgentZipDigest(resolved);

  return {
    name: agent.name ?? "Unnamed Agent",
    description: agent.description ?? null,
    sourceNl: agent.sourceNl ?? "",
    zipBase64: bytesToBase64(canonical),
    fileName: file.name,
    kind: pkg.kind,
    packageName: pkg.packageName,
    packageVersion: pkg.packageVersion,
    contentDigest: pkg.contentDigest,
    sentTreeDigest,
  };
}

type ImportAgentFormProps = {
  /** Scopes for the first-class access picker and PermissionsFormDraft. */
  availableScopes?: AvailableScopes;
};

export function ImportAgentForm({
  availableScopes,
  installScopeContext,
}: ImportAgentFormProps & { installScopeContext?: InstallScopeFieldContext }) {
  const router = useRouter();
  const [nameOverride, setNameOverride] = useState("");
  const [isPending, startTransition] = useTransition();

  // cinatra#3204 (criterion 11) — THE INSTALL SCOPE: who this extension is
  // installed FOR. Preselected to the server's own default, which is
  // `Workspace: All` wherever the server offered that row enabled.
  const [installScopeValue, setInstallScopeValue] = useState<string>(
    installScopeContext?.availability.state === "ready"
      ? installScopeContext.availability.defaultValue
      : "",
  );
  const installScopeSelection = installScopeContext
    ? resolveInstallScopeSelection(installScopeContext, installScopeValue)
    : null;

  // Upload-time permissions state: the ACCESS half only (the checkbox
  // multi-select scope picker). The advanced OWNERSHIP panel was removed
  // (cinatra#2643 review round), so coOwners stays empty here; ownership is
  // managed post-upload on the extension's own permissions surface. The
  // captured policy rides importAgentTemplate's `permissions` option on
  // every submit.
  const [permissionsDraft, setPermissionsDraft] = useState<PermissionsFormDraftValue>({
    policy: {
      runListVisibility: ["owner"],
      runDataVisibility: ["owner"],
      runExecuteVisibility: ["owner"],
      allowRunSharing: true,
    },
    coOwners: [],
  });

  // Scope selection → locksteps the three visibility fields through the
  // canonicalizing normalizer, mirroring PermissionsFormDraft's own
  // projection so both mounts of the picker agree on shape.
  const setAccessScopes = (next: string[]) => {
    const selection = normalizeVisibilitySelection(next as AgentAuthPolicyVisibility[]);
    setPermissionsDraft((prev) => ({
      ...prev,
      policy: {
        runListVisibility: selection,
        runDataVisibility: selection,
        runExecuteVisibility: selection,
        allowRunSharing: prev.policy.allowRunSharing,
      },
    }));
  };

  // License dialog state.
  // When the server action throws LicenseAcknowledgementRequiredError, open this dialog.
  const [licenseDialog, setLicenseDialog] = useState<{
    open: boolean;
    spdxId: string;
    pendingZipBase64: string;
  } | null>(null);

  // License reject error state.
  // When the server action throws LicenseDetectionRejectedError, show an inline Alert.
  const [licenseRejectError, setLicenseRejectError] = useState<string | null>(null);

  const dropzone = useDropzone<AgentPreview>({
    onDropFile: async (file) => {
      try {
        const preview = await parseZipFile(file);
        return { status: "success", result: preview };
      } catch (err) {
        return { status: "error", error: err instanceof Error ? err.message : "Failed to read file." };
      }
    },
    validation: {
      accept: { "application/zip": [".zip"] },
      maxFiles: 1,
    },
    shiftOnMaxFiles: true,
  });

  const fileStatus = dropzone.fileStatuses[0];
  const preview = fileStatus?.status === "success" ? fileStatus.result : null;
  const hasFile = dropzone.fileStatuses.length > 0;

  // Cancel: clear the selected file and the name override, returning the
  // form to the "Select an extension package" picker state.
  const handleCancel = () => {
    setNameOverride("");
    for (const file of dropzone.fileStatuses) {
      void dropzone.onRemoveFile(file.id);
    }
  };

  async function runImport(zipBase64: string, licenseAcknowledged = false) {
    setLicenseRejectError(null);
    try {
      // The scope picker is first-class now, so the captured policy always
      // rides the submit (its default is the owner-only floor — the same
      // effective access the permissions-less submit produced before).
      const permissions = {
        policy: permissionsDraft.policy,
        coOwnerUserIds: permissionsDraft.coOwners.map((c) => c.userId),
      };
      const result = await importAgentTemplate(zipBase64, nameOverride.trim() || undefined, {
        // cinatra#3204 (criteria 13-15): the chosen scope travels with the
        // submit. The SERVER re-resolves it, asserts the actor's authority at
        // that target, anchors the canonical row there and persists the
        // audience FAIL-CLOSED. Omitted when the screen offered no picker (no
        // active organization / no installable scope), which keeps the previous
        // behaviour for exactly the sessions that had no scope to choose.
        ...(installScopeContext && installScopeSelection?.committable
          ? { installScope: { pickerValue: installScopeValue } }
          : {}),
        // The digest of the bytes THIS REQUEST CARRIES. The server recomputes
        // it over the archive it received and refuses a mismatch, so what is
        // recorded on the canonical row describes what was actually installed.
        ...(preview?.sentTreeDigest ? { packageContentDigest: preview.sentTreeDigest } : {}),
        // The publish destination is not user-facing: an uploaded extension
        // always lands in the local registry by default (owner ruling on
        // cinatra#2644). "private" routes through resolvePublishDestination,
        // which resolves the instance's own destination — on a dev instance,
        // the local Verdaccio via the dev fallback.
        destination: "private",
        licenseAcknowledged,
        permissions,
        // The success landing is /configuration/extensions (owner ruling on
        // cinatra#2644) — suppress the server-side redirect and navigate
        // client-side after the warnings have been surfaced.
        redirect: false,
        // Owner ruling (PR #2658 review, revised): an admin upload goes LIVE —
        // the template is published and its compiled version bound atomically,
        // so the agent appears on /agents immediately in the scope chosen
        // above. No draft limbo, no approval step.
        publishAndBind: true,
      });
      // Surface non-fatal install-time permissions warnings.
      for (const warning of result.warnings) {
        toast.warning(warning, { duration: 8000 });
      }
      router.push("/configuration/extensions");
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : "Import failed.";

      // Copyleft tier — show LicenseWarningDialog for explicit acknowledgement.
      if (code === "LICENSE_ACKNOWLEDGEMENT_REQUIRED" || message.includes("Copyleft license")) {
        // Extract spdxId from the error message: "Copyleft license {spdxId} requires..."
        const spdxMatch = message.match(/Copyleft license ([^\s]+) requires/);
        const spdxId = spdxMatch?.[1] ?? "unknown";
        setLicenseDialog({ open: true, spdxId, pendingZipBase64: zipBase64 });
        return;
      }

      // Reject tier — inline destructive Alert with locked copy (UI-SPEC Surface 3).
      if (code === "LICENSE_DETECTION_REJECTED" || message.includes("License could not be determined")) {
        setLicenseRejectError(
          "License could not be determined. " +
          "The package's license is missing, ambiguous, or uses multiple conflicting identifiers. " +
          "Clarify the license upstream or use a different package.",
        );
        return;
      }

      // Other errors — re-throw for default error boundary handling.
      throw err;
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!preview) return;
    startTransition(async () => {
      await runImport(preview.zipBase64, false);
    });
  };

  const handleAcknowledge = () => {
    if (!licenseDialog) return;
    const zipBase64 = licenseDialog.pendingZipBase64;
    setLicenseDialog(null);
    startTransition(async () => {
      // Re-submit with licenseAcknowledged: true — server re-validates.
      await runImport(zipBase64, true);
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <Dropzone {...dropzone}>
        <div className="flex justify-end">
          <DropzoneMessage />
        </div>
        {/* The picker hides once a file is selected; Cancel (or removing the
            file) brings it back. After a successful upload the form navigates
            to /configuration/extensions, so a fresh mount shows it again. */}
        {!hasFile && (
          <DropZoneArea className="border-none bg-transparent p-0 shadow-none ring-0 focus-visible:ring-0">
            <DropzoneTrigger className="flex flex-col items-center gap-4 p-8 text-center text-sm w-full">
              <CloudUploadIcon className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium text-foreground">Select an extension package</p>
                <p className="text-xs text-muted-foreground mt-1">Click here or drag and drop</p>
              </div>
            </DropzoneTrigger>
          </DropZoneArea>
        )}

        <DropzoneFileList className="flex flex-col gap-3 mt-2">
          {dropzone.fileStatuses.map((file) => (
            <DropzoneFileListItem key={file.id} file={file} className="soft-panel flex flex-col gap-3 rounded-card p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <DropzoneRemoveFile
                    type="button"
                    aria-label="Remove file"
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </DropzoneRemoveFile>
                </div>
              </div>
              <InfiniteProgress status={file.status} />
              {file.status === "success" && file.result && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold text-foreground">{file.result.name}</p>
                  {file.result.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{file.result.description}</p>
                  )}
                  {file.result.sourceNl && (
                    <p className="text-xs text-muted-foreground line-clamp-2 border-l-2 border-line pl-3 mt-1">
                      {file.result.sourceNl}
                    </p>
                  )}
                </div>
              )}
              <DropzoneFileMessage className="text-xs text-destructive" />
            </DropzoneFileListItem>
          ))}
        </DropzoneFileList>
      </Dropzone>

      {preview && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="name-override" className="text-sm text-foreground">
            Name override <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="name-override"
            placeholder={preview.name}
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
          />
        </div>
      )}

      {/* cinatra#3204 (criterion 17) — TWO QUESTIONS, SEPARATELY LABELLED.
          The screen used to ask only the second one, under the heading
          "Access", which read as the first. They are different questions with
          different consequences, so each now says which one it is and neither
          borrows the other's wording. The decision recorded for #3204 is to
          keep both rather than fold one into the other: an install scope that
          silently set run visibility (or the reverse) would answer a question
          the operator was never asked. */}
      <Separator className="my-1" />
      {installScopeContext && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="upload-install-scope" className="text-sm font-semibold text-foreground">
            Install for
          </Label>
          <InstallScopePickerBody
            context={installScopeContext}
            value={installScopeValue}
            onValueChange={setInstallScopeValue}
            pickerId="upload-install-scope"
            subjectName={preview?.name ?? "this extension"}
            testId="upload-install-scope-picker"
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            Who this extension is installed for. This is the same choice a marketplace install
            offers, and it decides where the install is recorded and who can use it.
          </p>
        </div>
      )}

      {availableScopes && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-semibold text-foreground">Run visibility</Label>
          <AccessCombobox
            selectionMode="multiple"
            value={permissionsDraft.policy.runListVisibility}
            onChange={setAccessScopes}
            scopes={availableScopes}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            Who can list, read and execute this agent&apos;s runs once it is installed. Editable
            afterwards on the agent&apos;s own permissions page.
          </p>
        </div>
      )}

      {/* License reject inline error. */}
      {licenseRejectError && (
        <Alert variant="destructive">
          <AlertTitle>License could not be determined</AlertTitle>
          <AlertDescription>{licenseRejectError}</AlertDescription>
        </Alert>
      )}

      {/* cinatra#3204 — READ, then say what is possible. The three non-agent
          kinds are now READ by this screen (their kind, name and version are
          resolved, their payload checked and their tree digested), but the
          install road that finishes the job for them is not wired to this
          screen yet. Saying so plainly beats the previous behaviour, which
          refused the FILE by name and left the button dead with no explanation
          of what the file actually was. */}
      {preview && preview.kind !== "agent" && (
        <Alert variant="info">
          <AlertTitle>
            {preview.packageName ?? preview.fileName} is a {preview.kind} package
          </AlertTitle>
          <AlertDescription>
            This screen reads and checks {preview.kind} packages, but it cannot finish installing
            one yet — that road is being wired next. Install it from the marketplace in the
            meantime.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          className="flex-1"
          disabled={!preview || preview.kind !== "agent" || isPending}
        >
          {isPending ? "Uploading..." : "Upload (.zip)"}
        </Button>
        {hasFile && (
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
        )}
      </div>

      {/* Copyleft license acknowledgement dialog. */}
      {licenseDialog && (
        <LicenseWarningDialog
          open={licenseDialog.open}
          onOpenChange={(open) => {
            if (!open) setLicenseDialog(null);
          }}
          spdxId={licenseDialog.spdxId}
          onAcknowledge={handleAcknowledge}
          onCancel={() => setLicenseDialog(null)}
        />
      )}
    </form>
  );
}
