"use client";

// ---------------------------------------------------------------------------
// The Upload Extension screen's FILE tab (cinatra#3204 leg 3).
//
// WHAT CHANGED, and why each half of it is here:
//
//   ANY KIND. The archive is read by `resolveSuppliedArchive` — leg 1's
//   kind-aware, hardened reader — instead of the agent-only resolver. All four
//   live kinds are accepted; an archive declaring no kind, an unknown kind or
//   the retired `workflow` kind is refused BY NAME, and the refusal reaches the
//   operator through the app's toast surface with nothing written anywhere.
//
//   THE SCOPE. Once a package has been read, the store's OWN install panel is
//   mounted (`ExtensionInstallScopePanel` through `UploadInstallScopePanel`) —
//   the same picker, the same `Workspace: All` preselection, the same Cancel /
//   Install now row. The old checkbox multi-select of the agent RUN-VISIBILITY
//   policy is gone: it asked a different question in the same place, and one
//   screen asking "who can access this" twice with two meanings is the thing
//   criterion 17 exists to stop.
//
//   THE SERVER DECIDES. What the browser reads here is a PREVIEW. The bytes are
//   sent as they are; the server re-reads them, re-resolves the kind, runs that
//   kind's own validator, and refuses a digest that does not match what was
//   previewed. Nothing the browser claims is trusted.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileIcon, Trash2Icon, CloudUploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dropzone,
  DropZoneArea,
  DropzoneFileList,
  DropzoneFileListItem,
  DropzoneMessage,
  DropzoneRemoveFile,
  DropzoneTrigger,
  InfiniteProgress,
  useDropzone,
} from "@/components/ui/dropzone";
import { toast } from "@/lib/cinatra-toast";
import type { ExtensionScopedInstallAction } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";

import {
  installSuppliedArchiveAction,
  readSuppliedUploadConsentPromptAction,
} from "./supplied-install-actions";
import {
  UploadConsentBlock,
  UploadInstallScopePanel,
  consentPayload,
  type UploadConsentPromptValue,
  type UploadInstallScopeContext,
} from "./upload-install-scope-panel";
import { readZipEntries, resolveSuppliedArchive, bytesToBase64 } from "./upload-archive";

type SuppliedPreview = {
  kind: string;
  packageName: string;
  version: string;
  contentDigest: string;
  fileName: string;
  zipBase64: string;
};

const KIND_LABEL: Record<string, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
};

/**
 * Read the archive in the browser so the operator sees WHAT they supplied before
 * they choose a scope. Every refusal here is the shared reader's own wording —
 * the same sentences the server produces, because it is the same function.
 */
async function readSuppliedArchiveFile(file: File): Promise<SuppliedPreview> {
  const buf = await file.arrayBuffer();
  const entries = await readZipEntries(buf);
  const resolved = await resolveSuppliedArchive(entries);
  return {
    kind: resolved.kind,
    packageName: resolved.packageName,
    version: resolved.version,
    contentDigest: resolved.contentDigest,
    fileName: file.name,
    zipBase64: bytesToBase64(new Uint8Array(buf)),
  };
}

export type ImportAgentFormProps = {
  /** Server-computed install-panel context — the store's own picker rows. */
  installScope: UploadInstallScopeContext;
};

export function ImportAgentForm({ installScope }: ImportAgentFormProps) {
  const router = useRouter();
  // The kind's own listing, recorded by a completed install (see the note
  // on `installAction` below).
  const [installedDestination, setInstalledDestination] = useState<string | null>(null);
  useEffect(() => {
    if (!installedDestination) return;
    router.push(installedDestination);
  }, [installedDestination, router]);
  const [preview, setPreview] = useState<SuppliedPreview | null>(null);
  // The upload-consent confirmation (cinatra#2092), asked for a SKILL package
  // only, fetched once the kind is known and re-fetched for every new package.
  // Always starts UNTICKED: consent is an explicit act.
  const [consentPrompt, setConsentPrompt] = useState<UploadConsentPromptValue | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    let live = true;
    setConsentChecked(false);
    setConsentPrompt(null);
    if (!preview) return;
    void readSuppliedUploadConsentPromptAction({
      kind: preview.kind,
      packageName: preview.packageName,
      provenanceType: "local",
    }).then((prompt) => {
      if (live) setConsentPrompt(prompt);
    });
    return () => {
      live = false;
    };
  }, [preview]);

  const dropzone = useDropzone<SuppliedPreview>({
    onDropFile: async (file) => {
      try {
        const read = await readSuppliedArchiveFile(file);
        setPreview(read);
        return { status: "success", result: read };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "That file could not be read as an extension package.";
        setPreview(null);
        // Design spec Extensions §I.1: errors are a toast, never inline.
        toast.error(message);
        return { status: "error", error: message };
      }
    },
    validation: {
      accept: { "application/zip": [".zip"] },
      maxFiles: 1,
    },
    shiftOnMaxFiles: true,
  });

  const hasFile = dropzone.fileStatuses.length > 0;

  /** Cancel: clear the selection and return to the "choose a package" state. */
  const handleCancel = () => {
    setPreview(null);
    for (const file of dropzone.fileStatuses) {
      void dropzone.onRemoveFile(file.id);
    }
  };

  /**
   * The panel calls this with the chosen target; the supplied package rides the
   * closure. Success navigates to where the kind can actually be SEEN; a refusal
   * is toasted in the server's own words and the panel keeps its selection.
   */
  // WHERE A COMPLETED INSTALL TAKES THE OPERATOR, and why it is recorded in
  // state rather than pushed from inside the action.
  //
  // The store's install panel invokes this action from a React form action
  // (`<form action={handleSubmit}>`), so the whole call runs inside the
  // transition that owns the panel's pending state. A router navigation issued
  // from inside that transition never happens: the transition commits the
  // panel's own re-render and the pending navigation is dropped with it —
  // measured on the running app, where the install returned `ok:true` with
  // `/agents` and the page was still on the upload screen three seconds later.
  // `redirect()` from inside the action is dropped for the same reason.
  //
  // So the action RECORDS the destination and the effect at the top of this
  // component performs the navigation once the transition has committed —
  // outside it, where the router acts.
  const installAction: ExtensionScopedInstallAction = async ({ accessTarget }) => {
    if (!preview) return;
    const consent = consentPayload(consentPrompt, consentChecked);
    const result = await installSuppliedArchiveAction({
      zipBase64: preview.zipBase64,
      expectedContentDigest: preview.contentDigest,
      accessTarget,
      ...(consent ? { anthropicUploadConsent: consent } : {}),
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    for (const warning of result.warnings ?? []) toast.warning(warning);
    toast.success(
      `Installed ${result.packageName} ${result.version} — ${result.observable.label.toLowerCase()}`,
    );
    setInstalledDestination(result.observable.href);
  };

  return (
    <div className="flex flex-col gap-6">
      <Dropzone {...dropzone}>
        <div className="flex justify-end">
          <DropzoneMessage />
        </div>
        {!hasFile && (
          <DropZoneArea className="border-none bg-transparent p-0 shadow-none ring-0 focus-visible:ring-0">
            <DropzoneTrigger className="flex flex-col items-center gap-4 p-8 text-center text-sm w-full">
              <CloudUploadIcon className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium text-foreground">Select an extension package</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Click here or drag and drop — an agent, skill, connector or artifact package
                </p>
              </div>
            </DropzoneTrigger>
          </DropZoneArea>
        )}

        <DropzoneFileList className="flex flex-col gap-3 mt-2">
          {dropzone.fileStatuses.map((file) => (
            <DropzoneFileListItem
              key={file.id}
              file={file}
              className="soft-panel flex flex-col gap-3 rounded-card p-4"
            >
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
              {/* NO inline message here, by the design spec's own rule
                  (Extensions §I.1: "Errors are a toast, never inline"). The
                  drop handler has already sent the refusal to the toast
                  surface; a card that repeats it draws the same sentence twice
                  and puts one of the two copies exactly where the drawing says
                  an error never goes. The card carries the file and its
                  progress — what it IS, not why it failed. */}
            </DropzoneFileListItem>
          ))}
        </DropzoneFileList>
      </Dropzone>

      {preview && (
        <UploadInstallScopePanel
          scope={installScope}
          installAction={installAction}
          packageName={preview.packageName}
          packageVersion={preview.version}
          displayName={preview.packageName}
          onCancel={handleCancel}
          header={
            <div className="flex flex-col gap-1" data-testid="upload-resolved-package">
              <div className="flex items-center gap-2">
                <Badge variant="outline" data-testid="upload-resolved-kind">
                  {KIND_LABEL[preview.kind] ?? preview.kind}
                </Badge>
                <p className="truncate text-sm font-semibold text-foreground">
                  {preview.packageName}
                </p>
                <span className="text-xs text-muted-foreground">{preview.version}</span>
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                content digest {preview.contentDigest.slice(0, 12)}…
              </p>
              <UploadConsentBlock
                prompt={consentPrompt}
                checked={consentChecked}
                onCheckedChange={setConsentChecked}
              />
            </div>
          }
        />
      )}

      {!preview && hasFile && (
        <p className="text-xs text-muted-foreground">
          Choose a package this instance can install to continue.
        </p>
      )}
    </div>
  );
}
