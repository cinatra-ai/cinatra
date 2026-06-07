"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/cinatra-toast";
import { GitBranchIcon, TagIcon, ScaleIcon, LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchGitHubSkillRepoMetadata,
  installGitHubSkillExtension,
  type FetchGitHubSkillRepoMetadataResult,
} from "@cinatra-ai/skills/actions";
// Candidate search goes through the generic action with resourceId=null
// (upload mode). Admin-only gate is enforced inside.
import { searchExtensionCoOwnerCandidates } from "@cinatra-ai/extensions/permissions-actions";
import {
  PermissionsFormDraft,
  type PermissionsFormDraftValue,
} from "@/components/permissions-form-draft";
import type { AvailableScopes } from "@/components/access-combobox-hierarchical";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

// "Latest code from the default branch" is represented as an empty ref so it
// doesn't collide with any real tag name.
const LATEST_CODE_VALUE = "__latest_code__";

type RepoMetadata = Extract<FetchGitHubSkillRepoMetadataResult, { ok: true }>["metadata"];

// Default policy applied when the operator doesn't open the advanced
// "Configure access & ownership" panel. Mirrors the skill-package detail
// page's fallback.
const DEFAULT_DRAFT_POLICY: AgentAuthPolicy = {
  runListVisibility: "owner",
  runDataVisibility: "owner",
  runExecuteVisibility: "owner",
  allowRunSharing: true,
};

export type ImportSkillFromGitHubFormProps = {
  /** Server-resolved scope tree for the access-combobox; required when the
   *  PermissionsFormDraft is mounted. */
  availableScopes: AvailableScopes;
};

export function ImportSkillFromGitHubForm({ availableScopes }: ImportSkillFromGitHubFormProps) {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [metadata, setMetadata] = useState<RepoMetadata | null>(null);
  const [releaseChoice, setReleaseChoice] = useState<string>(LATEST_CODE_VALUE);
  const [error, setError] = useState<string | null>(null);
  const [isFetching, startFetch] = useTransition();
  const [isInstalling, startInstall] = useTransition();

  // Controlled draft for upload-time access/ownership capture. Collapsed by
  // default ("Configure access & ownership (advanced)") so the happy-path
  // remains 2-click. When the operator opens the panel, the draft state is
  // threaded into installGitHubSkillExtension's `permissions` arg and applied
  // server-side after the package row exists.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [permissionsDraft, setPermissionsDraft] = useState<PermissionsFormDraftValue>({
    policy: DEFAULT_DRAFT_POLICY,
    coOwners: [],
  });

  const handleLookup = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMetadata(null);
    startFetch(async () => {
      const result = await fetchGitHubSkillRepoMetadata(repoUrl);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMetadata(result.metadata);
      // Preselect the latest non-prerelease release when one exists; else stay
      // on "Latest code". The releases array preserves the listReleases order
      // (newest first), so the first non-prerelease is the latest stable.
      const latestStable = result.metadata.releases.find((release) => !release.prerelease);
      setReleaseChoice(latestStable ? latestStable.tagName : LATEST_CODE_VALUE);
    });
  };

  const handleInstall = (event: React.FormEvent) => {
    event.preventDefault();
    if (!metadata) return;
    setError(null);
    startInstall(async () => {
      const ref = releaseChoice === LATEST_CODE_VALUE ? undefined : releaseChoice;
      // Only send policy when the operator actually opened the advanced
      // panel; otherwise the server falls through to its default
      // (NULL → admin-only edit, install actor as primary owner).
      const permissions = advancedOpen
        ? {
            policy: permissionsDraft.policy,
            coOwnerUserIds: permissionsDraft.coOwners.map((c) => c.userId),
          }
        : undefined;
      const result = await installGitHubSkillExtension({ repoUrl, ref, permissions });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Toast immediately so the user gets feedback before the route transition.
      toast.success(
        `Installed ${metadata?.fullName ?? "skill package"}${
          result.ref ? ` (${result.ref})` : ""
        }`,
      );
      // The install action collects non-fatal warnings from the post-create
      // permissions step (e.g. one co-owner id no longer exists) so the
      // package row is on disk but some configuration didn't stick. Surface
      // each warning as a toast so the operator knows to re-configure at the
      // detail page.
      for (const warning of result.warnings) {
        toast.warning(warning, { duration: 8000 });
      }
      // The unified /skills list surfaces every installed skill row (backed by
      // cinatra.skill_packages), which is where this install lands. The
      // agent-only /configuration/extensions catalog does not surface skill rows.
      router.push("/skills");
    });
  };

  return (
    <form onSubmit={metadata ? handleInstall : handleLookup} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="github-repo-url">GitHub repository URL</FieldLabel>
          <div className="flex items-center gap-2">
            <InputGroup className="flex-1">
              <InputGroupInput
                id="github-repo-url"
                type="url"
                placeholder="https://github.com/owner/repo"
                value={repoUrl}
                onChange={(event) => {
                  setRepoUrl(event.target.value);
                  if (metadata) {
                    // Clearing the preview when the URL changes prevents
                    // installing one repo with another repo's release tag.
                    // Suppressed while an install is in flight so editing
                    // the URL mid-install can't make the dialog vanish.
                    if (isInstalling) return;
                    setMetadata(null);
                    setReleaseChoice(LATEST_CODE_VALUE);
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                disabled={isFetching || isInstalling}
                readOnly={isInstalling}
              />
              <InputGroupAddon>
                <LinkIcon aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
            {!metadata && (
              <Button type="submit" disabled={!repoUrl.trim() || isFetching}>
                {isFetching ? (
                  <>
                    <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
                    Looking up…
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            )}
          </div>
          <FieldDescription>
            Public github.com repositories only. Paste the full URL (e.g. <code className="text-foreground">https://github.com/owner/repo</code>).
          </FieldDescription>
        </Field>
      </FieldGroup>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not install skill package</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {metadata && (
        <div className="flex flex-col gap-4 rounded-card border border-line bg-surface-strong p-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-foreground">{metadata.fullName}</p>
              {metadata.licenseSpdxId && (
                <Badge variant="outline" className="gap-1 text-xs">
                  <ScaleIcon className="h-3 w-3" aria-hidden="true" />
                  {metadata.licenseSpdxId}
                </Badge>
              )}
            </div>
            {metadata.description && (
              <p className="text-xs text-muted-foreground">{metadata.description}</p>
            )}
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranchIcon className="h-3 w-3" aria-hidden="true" />
              Default branch: <span className="text-foreground">{metadata.defaultBranch}</span>
            </p>
          </div>

          <Field>
            <FieldLabel htmlFor="github-release-select">Version to install</FieldLabel>
            <Select
              value={releaseChoice}
              onValueChange={setReleaseChoice}
              disabled={metadata.releases.length === 0 || isInstalling}
            >
              <SelectTrigger id="github-release-select" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LATEST_CODE_VALUE}>
                  Latest code from <span className="font-medium">{metadata.defaultBranch}</span>
                </SelectItem>
                {metadata.releases.map((release) => (
                  <SelectItem key={release.tagName} value={release.tagName}>
                    <span className="inline-flex items-center gap-2">
                      <TagIcon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      <span className="font-medium">{release.tagName}</span>
                      {release.name && release.name !== release.tagName && (
                        <span className="text-xs text-muted-foreground">— {release.name}</span>
                      )}
                      {release.prerelease && (
                        <Badge variant="outline" className="text-[10px] uppercase">pre-release</Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {metadata.releases.length === 0 && (
              <FieldDescription>
                This repository has no GitHub Releases. The latest code from the default branch will be installed.
              </FieldDescription>
            )}
          </Field>

          {/* Optional access & ownership capture. Collapsed by default. When
              opened, the values are threaded through installGitHubSkillExtension
              and applied atomically after the package row exists. */}
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setAdvancedOpen((prev) => !prev)}
              disabled={isInstalling}
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
                    "skill_package",
                    null,
                    q,
                    page,
                  );
                  if (!result.ok) return { ok: false, error: result.error };
                  return { ok: true, results: result.results, hasMore: result.hasMore };
                }}
                disabled={isInstalling}
              />
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Clones into <code className="text-foreground">data/skills/</code> and registers the package locally.
            </p>
            <Button type="submit" disabled={isInstalling}>
              {isInstalling ? (
                <>
                  <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
                  Installing…
                </>
              ) : (
                "Install skill package"
              )}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
