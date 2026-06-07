"use client";

import { useState, useTransition } from "react";
import { FileIcon, Trash2Icon, CloudUploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import {
  PublishDestinationPicker,
  type PublishDestination,
} from "@cinatra-ai/extensions/components/publish-destination-picker";
import { LicenseWarningDialog } from "@cinatra-ai/extensions/components/license-warning-dialog";

// Same draft panel that the GitHub install form uses, mounted
// on the ZIP upload tab so admins can capture upload-time policy +
// co-owners for the new agent_template before it's registered.
import {
  PermissionsFormDraft,
  type PermissionsFormDraftValue,
} from "@/components/permissions-form-draft";
import { searchExtensionCoOwnerCandidates } from "@cinatra-ai/extensions/permissions-actions";
import type { AvailableScopes } from "@/components/access-combobox-hierarchical";
import { toast } from "@/lib/cinatra-toast";

// Minimal client-side ZIP reader
function readZipFilesClient(buf: ArrayBuffer): Map<string, string> {
  const view = new DataView(buf);
  const result = new Map<string, string>();
  const len = buf.byteLength;

  let eocdOffset = -1;
  for (let i = len - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return result;

  const numEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const td = new TextDecoder("utf-8");
  let pos = centralDirOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const filenameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const filename = td.decode(new Uint8Array(buf, pos + 46, filenameLen));

    const lfhFilenameLen = view.getUint16(localHeaderOffset + 26, true);
    const lfhExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
    result.set(filename, td.decode(new Uint8Array(buf, dataOffset, compressedSize)));

    pos += 46 + filenameLen + extraLen + commentLen;
  }
  return result;
}

type AgentPreview = {
  name: string;
  description: string | null;
  status: string;
  sourceNl: string;
  zipBase64: string;
  fileName: string;
};

async function parseZipFile(file: File): Promise<AgentPreview> {
  const buf = await file.arrayBuffer();
  const files = readZipFilesClient(buf);
  const agentRaw = files.get("agent.json");
  if (!agentRaw) throw new Error("Invalid archive: agent.json not found.");

  const manifestRaw = files.get("manifest.json");
  if (manifestRaw) {
    const m = JSON.parse(manifestRaw) as { version?: number };
    if (m.version !== 1) throw new Error(`Unsupported manifest version: ${m.version}`);
  }

  const agent = JSON.parse(agentRaw) as {
    component_type?: string;
    agentspec_version?: string;
    name?: string;
    description?: string | null;
    status?: string;
    sourceNl?: string;
    metadata?: { cinatra?: { type?: string } };
  };
  // Accept compact OAS Flow documents only.
  if (agent.agentspec_version !== "26.1.0" || agent.component_type !== "Flow") {
    throw new Error(`Unsupported agent format (expected OAS v26.1.0 Flow).`);
  }

  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

  return {
    name: agent.name ?? "Unnamed Agent",
    description: agent.description ?? null,
    status: agent.status ?? "draft",
    sourceNl: agent.sourceNl ?? "",
    zipBase64: btoa(binary),
    fileName: file.name,
  };
}

type ImportAgentFormProps = {
  /** Passed from parent RSC which reads loadDeploymentRegistryConfig() server-side. */
  privateDestinationConfigured?: boolean;
  /** Scopes for the access picker inside PermissionsFormDraft. */
  availableScopes?: AvailableScopes;
};

export function ImportAgentForm({
  privateDestinationConfigured = false,
  availableScopes,
}: ImportAgentFormProps) {
  const [nameOverride, setNameOverride] = useState("");
  const [isPending, startTransition] = useTransition();
  // Default to "private" when private destination is configured.
  const [destination, setDestination] = useState<PublishDestination>(
    privateDestinationConfigured ? "private" : "public",
  );

  // Upload-time PermissionsFormDraft state. The advanced panel
  // is hidden behind a disclosure so the default flow (admin-only) stays
  // one-click. When the user opens it, the captured policy + co-owner ids
  // are threaded into importAgentTemplate's `permissions` option.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [permissionsDraft, setPermissionsDraft] = useState<PermissionsFormDraftValue>({
    policy: {
      runListVisibility: "owner",
      runDataVisibility: "owner",
      runExecuteVisibility: "owner",
      allowRunSharing: true,
    },
    coOwners: [],
  });

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

  async function runImport(zipBase64: string, licenseAcknowledged = false) {
    setLicenseRejectError(null);
    try {
      const permissions = advancedOpen
        ? {
            policy: permissionsDraft.policy,
            coOwnerUserIds: permissionsDraft.coOwners.map((c) => c.userId),
          }
        : undefined;
      const result = await importAgentTemplate(zipBase64, nameOverride.trim() || undefined, {
        destination,
        licenseAcknowledged,
        permissions,
      });
      // Surface non-fatal install-time permissions warnings.
      for (const warning of result.warnings) {
        toast.warning(warning, { duration: 8000 });
      }
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
        <DropZoneArea className="border-none bg-transparent p-0 shadow-none ring-0 focus-visible:ring-0">
          <DropzoneTrigger className="flex flex-col items-center gap-4 p-8 text-center text-sm w-full">
            <CloudUploadIcon className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">Select an extension package</p>
              <p className="text-xs text-muted-foreground mt-1">Click here or drag and drop</p>
            </div>
          </DropzoneTrigger>
        </DropZoneArea>

        <DropzoneFileList className="flex flex-col gap-3 mt-2">
          {dropzone.fileStatuses.map((file) => (
            <DropzoneFileListItem key={file.id} file={file} className="soft-panel flex flex-col gap-3 rounded-card p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {file.status === "success" && file.result && (
                    <Badge variant="outline" className="text-xs">{file.result.status}</Badge>
                  )}
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

      {/* Publish destination picker, last step before submit. */}
      <Separator className="my-1" />
      <PublishDestinationPicker
        value={destination}
        onValueChange={setDestination}
        privateDestinationConfigured={privateDestinationConfigured}
        idPrefix="import-form"
      />

      {/* Advanced access & ownership controls. Hidden by default
          (admin-only is the safe ZIP-upload behaviour); when opened, captures
          policy + co-owner picks that importAgentTemplate seeds into the
          polymorphic permission tables for the new agent_template. */}
      {availableScopes && (
        <div className="flex flex-col gap-3">
          <Separator className="my-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            disabled={isPending}
          >
            {advancedOpen
              ? "Hide access & ownership"
              : "Configure access & ownership (advanced)"}
          </Button>
          {advancedOpen && (
            <PermissionsFormDraft
              value={permissionsDraft}
              onChange={setPermissionsDraft}
              availableScopes={availableScopes}
              searchCandidates={async (q, page) => {
                const result = await searchExtensionCoOwnerCandidates(
                  "agent_template",
                  null,
                  q,
                  page,
                );
                if (!result.ok) return { ok: false, error: result.error };
                return { ok: true, results: result.results, hasMore: result.hasMore };
              }}
              disabled={isPending}
            />
          )}
        </div>
      )}

      {/* License reject inline error. */}
      {licenseRejectError && (
        <Alert variant="destructive">
          <AlertTitle>License could not be determined</AlertTitle>
          <AlertDescription>{licenseRejectError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={!preview || isPending}>
        {isPending ? "Uploading..." : "Upload (.zip)"}
      </Button>

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
