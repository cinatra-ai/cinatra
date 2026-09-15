"use client";

// ---------------------------------------------------------------------------
// The Upload Extension screen's GITHUB tab (cinatra#3204 leg 3).
//
// It used to be a skill-only road. It is now the repository road for ANY of the
// four live kinds, and three things about it are deliberately different:
//
//   THE PRECONDITION IS STATED, NOT LEAKED (criterion 9). The two failure states
//   are genuinely different — no owning connector at all, versus an installed
//   connector with no usable connection — and each is named, with a link to
//   where it is actually fixed. Submit is disabled in both. The operator never
//   meets a raw capability refusal.
//
//   THE REF IS PINNED ONCE (criterion 7). Looking a repository up resolves the
//   submitted ref to ONE immutable commit sha, and that sha is DISPLAYED. The
//   install re-reads at exactly that commit and refuses if the bytes moved, so a
//   branch that advances between preview and install cannot swap the contents.
//
//   THE VISIBILITY CLAIM IS GONE (criterion 10). This road reaches whatever the
//   configured connection can reach; it never promised public-only, and it no
//   longer says so.
//
// The scope question is the SAME panel the File tab and the store use. The old
// collapsed "configure access & ownership" editor is gone — one question, asked
// once (criterion 17).
// ---------------------------------------------------------------------------

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LinkIcon, Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "@/lib/cinatra-toast";
import type { ExtensionScopedInstallAction } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";

import {
  installSuppliedRepositoryAction,
  previewSuppliedRepositoryAction,
  readGitHubUploadPreconditionAction,
  type GitHubUploadPrecondition,
  type SuppliedPackagePreview,
} from "./supplied-install-actions";
import {
  UploadConsentBlock,
  UploadInstallScopePanel,
  consentPayload,
  type UploadConsentPromptValue,
  type UploadInstallScopeContext,
} from "./upload-install-scope-panel";

const KIND_LABEL: Record<string, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
};

export type ImportPackageFromGitHubFormProps = {
  installScope: UploadInstallScopeContext;
  /** Resolved on the server for the first paint; re-read on mount so a
   *  connector installed in another tab is picked up without a reload. */
  precondition: GitHubUploadPrecondition;
};

export function ImportPackageFromGitHubForm({
  installScope,
  precondition: initialPrecondition,
}: ImportPackageFromGitHubFormProps) {
  const router = useRouter();
  // The kind's own listing, recorded by a completed install (see the note
  // on `installAction` below).
  const [installedDestination, setInstalledDestination] = useState<string | null>(null);
  useEffect(() => {
    if (!installedDestination) return;
    router.push(installedDestination);
  }, [installedDestination, router]);
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<SuppliedPackagePreview | null>(null);
  const [precondition, setPrecondition] =
    useState<GitHubUploadPrecondition>(initialPrecondition);
  const [isLooking, startLookup] = useTransition();
  // The upload-consent confirmation rides on the preview (the server builds it
  // from the same builder the File tab's own lookup uses). Always starts
  // UNTICKED, and is cleared with every new lookup.
  const [consentChecked, setConsentChecked] = useState(false);
  const consentPrompt: UploadConsentPromptValue | null =
    (preview?.consentPrompt as UploadConsentPromptValue | undefined) ?? null;

  useEffect(() => {
    let live = true;
    void readGitHubUploadPreconditionAction().then((next) => {
      if (live) setPrecondition(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const ready = precondition.state === "ready";

  const handleLookup = (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPreview(null);
    setConsentChecked(false);
    startLookup(async () => {
      const result = await previewSuppliedRepositoryAction({
        repoUrl,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setPreview(result.preview);
    });
  };

  const handleCancel = () => {
    setPreview(null);
  };

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
    if (!preview || !preview.resolvedSha) return;
    const consent = consentPayload(consentPrompt, consentChecked);
    const result = await installSuppliedRepositoryAction({
      repoUrl,
      ref: preview.ref ?? "",
      pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
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
      {!ready && (
        <Alert variant="destructive" data-testid="github-upload-precondition">
          <AlertTitle>
            {precondition.state === "no-connector"
              ? "The GitHub connector is not available"
              : "There is no usable GitHub connection"}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{"message" in precondition ? precondition.message : ""}</span>
            {"fixHref" in precondition && (
              <Button asChild size="sm" variant="outline">
                <Link href={precondition.fixHref}>{precondition.fixLabel}</Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleLookup} className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="github-repo-url">Repository URL</FieldLabel>
            <div className="flex items-center gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  id="github-repo-url"
                  type="url"
                  placeholder="https://github.com/owner/repo"
                  value={repoUrl}
                  onChange={(event) => {
                    setRepoUrl(event.target.value);
                    setPreview(null);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!ready || isLooking}
                />
                <InputGroupAddon>
                  <LinkIcon aria-hidden="true" />
                </InputGroupAddon>
              </InputGroup>
              <Button
                type="submit"
                data-testid="github-upload-submit"
                disabled={!ready || !repoUrl.trim() || isLooking}
              >
                {isLooking ? (
                  <>
                    <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
                    Looking up…
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </div>
            <FieldDescription>
              A github.com repository holding an agent, skill, connector or artifact package.
              The package declares its own kind; this instance reads it from the repository.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="github-ref">
              Branch, tag or commit <span className="text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input
              id="github-ref"
              placeholder="the repository's default branch"
              value={ref}
              onChange={(event) => {
                setRef(event.target.value);
                setPreview(null);
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={!ready || isLooking}
            />
            <FieldDescription>
              Whatever you name is resolved once to a single commit, shown below, and installed at
              exactly that commit.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>

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
              <p className="font-mono text-[11px] text-muted-foreground" data-testid="upload-pinned-sha">
                {preview.repo} pinned at {preview.resolvedSha}
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
    </div>
  );
}
