"use client";

import { useEffect, useMemo, useTransition, useState } from "react";
import { createPortal } from "react-dom";
import { PromptField } from "@cinatra-ai/sdk-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
type GeneratedRecipient = {
  startupId: string;
  startupName: string;
  website: string;
  contactName?: string;
  contactEmail?: string;
  contactTitle?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  githubUrl?: string;
  facebookUrl?: string;
};

type SocialProfileLink = {
  key: string;
  href: string;
  label: string;
  icon: React.ReactNode;
};

function isSocialProfileLink(profile: SocialProfileLink | null): profile is SocialProfileLink {
  return profile !== null;
}

function SocialProfileLinks({ recipient }: { recipient: GeneratedRecipient }) {
  const rawProfiles: Array<SocialProfileLink | null> = [
    recipient.linkedinUrl
      ? {
          key: "linkedin",
          href: recipient.linkedinUrl,
          label: "LinkedIn",
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M6.7 8.3A1.35 1.35 0 1 0 6.7 5.6a1.35 1.35 0 0 0 0 2.7ZM5.6 9.9h2.2v8.5H5.6zM10 9.9h2.1v1.2h.1c.4-.8 1.4-1.5 2.9-1.5 2.4 0 3.4 1.5 3.4 4v4.8h-2.2v-4.3c0-1.3-.3-2.4-1.8-2.4s-2.2 1.1-2.2 2.4v4.3H10Z" />
            </svg>
          ),
        }
      : null,
    recipient.twitterUrl
      ? {
          key: "twitter",
          href: recipient.twitterUrl,
          label: "X",
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M18.9 2H22l-6.77 7.74L23 22h-6.1l-4.78-7.42L5.63 22H2.5l7.24-8.28L2 2h6.25l4.32 6.8L18.9 2Zm-1.07 18h1.69L7.33 3.9H5.52Z" />
            </svg>
          ),
        }
      : null,
    recipient.githubUrl
      ? {
          key: "github",
          href: recipient.githubUrl,
          label: "GitHub",
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-1.9c-3.08.67-3.73-1.3-3.73-1.3-.5-1.28-1.23-1.62-1.23-1.62-1-.68.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.99 1.68 2.58 1.2 3.21.92.1-.71.39-1.2.7-1.47-2.46-.28-5.05-1.23-5.05-5.46 0-1.2.43-2.17 1.13-2.93-.12-.28-.49-1.42.1-2.95 0 0 .92-.3 3.02 1.12a10.5 10.5 0 0 1 5.5 0c2.1-1.42 3.01-1.12 3.01-1.12.6 1.53.23 2.67.12 2.95.7.76 1.12 1.73 1.12 2.93 0 4.24-2.59 5.17-5.06 5.45.4.35.75 1.02.75 2.07v3.07c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" />
            </svg>
          ),
        }
      : null,
    recipient.facebookUrl
      ? {
          key: "facebook",
          href: recipient.facebookUrl,
          label: "Facebook",
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M13.5 21v-7h2.4l.36-2.8H13.5V9.4c0-.8.23-1.35 1.37-1.35H16.4V5.54c-.27-.04-1.18-.12-2.23-.12-2.2 0-3.7 1.34-3.7 3.8v2H8v2.8h2.47v7Z" />
            </svg>
          ),
        }
      : null,
  ];
  const profiles: SocialProfileLink[] = rawProfiles.filter(isSocialProfileLink);

  if (profiles.length === 0) {
    return <span className="text-muted-foreground">None</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {profiles.map((profile) => (
        <a
          key={profile.key}
          href={profile.href}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${profile.label} profile for ${recipient.contactName ?? recipient.startupName}`}
          title={profile.label}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-strong text-muted-foreground transition hover:border-primary hover:bg-primary hover:text-primary-foreground"
        >
          {profile.icon}
        </a>
      ))}
    </div>
  );
}

function normalizeWebsiteHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function CampaignRecipientSelectionForm({
  action,
  removeRecipientsAction,
  campaignId,
  redirectTo,
  initialRecipientSelectionPrompt,
  generatedRecipients,
  readOnly = false,
  onStop,
}: {
  action: (formData: FormData) => void | Promise<void>;
  removeRecipientsAction: (formData: FormData) => void | Promise<void>;
  campaignId: string;
  redirectTo: string;
  initialRecipientSelectionPrompt: string;
  generatedRecipients: GeneratedRecipient[];
  readOnly?: boolean;
  onStop?: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [selectedStartupIds, setSelectedStartupIds] = useState<string[]>([]);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setPortalTarget(document.querySelector("main"));
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  function handlePromptSubmit(promptValue: string) {
    if (readOnly) return;
    startTransition(() => {
      const formData = new FormData();
      formData.set("campaignId", campaignId);
      formData.set("redirectTo", redirectTo);
      formData.set("recipientSelectionPrompt", promptValue);
      void action(formData);
    });
  }
  const [searchValue, setSearchValue] = useState("");
  const normalizedSearchValue = searchValue.trim().toLowerCase();
  const availableStartupIds = useMemo(() => new Set(generatedRecipients.map((recipient) => recipient.startupId)), [generatedRecipients]);
  const normalizedSelectedStartupIds = useMemo(
    () => selectedStartupIds.filter((startupId) => availableStartupIds.has(startupId)),
    [availableStartupIds, selectedStartupIds],
  );
  const visibleRecipients = useMemo(
    () =>
      generatedRecipients.filter((recipient) => {
        if (!normalizedSearchValue) {
          return true;
        }

        return [
          recipient.startupName,
          recipient.website,
          recipient.contactName,
          recipient.contactTitle,
          recipient.contactEmail,
        ]
          .map((value) => String(value ?? "").toLowerCase())
          .some((value) => value.includes(normalizedSearchValue));
      }),
    [generatedRecipients, normalizedSearchValue],
  );
  const selectedStartupIdSet = useMemo(() => new Set(normalizedSelectedStartupIds), [normalizedSelectedStartupIds]);
  const allSelected = visibleRecipients.length > 0 && visibleRecipients.every((recipient) => selectedStartupIdSet.has(recipient.startupId));
  const hasSelections = normalizedSelectedStartupIds.length > 0;

  function toggleStartup(startupId: string, checked: boolean) {
    setSelectedStartupIds((current) =>
      checked ? (current.includes(startupId) ? current : [...current, startupId]) : current.filter((value) => value !== startupId),
    );
  }

  function toggleAll(checked: boolean) {
    setSelectedStartupIds((current) => {
      if (!checked) {
        const visibleIds = new Set(visibleRecipients.map((recipient) => recipient.startupId));
        return current.filter((startupId) => !visibleIds.has(startupId));
      }

      return Array.from(new Set([...current, ...visibleRecipients.map((recipient) => recipient.startupId)]));
    });
  }

  return (
    <>
      <Card className="border-line bg-surface backdrop-blur-none p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Recipients</h2>
            <p className="mt-1 text-sm font-medium text-muted-foreground">
              Total recipients: {generatedRecipients.length}
            </p>
          </div>
          {generatedRecipients.length > 0 && !readOnly ? (
            <form action={removeRecipientsAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="campaignId" value={campaignId} />
              <input type="hidden" name="redirectTo" value={redirectTo} />
              {normalizedSelectedStartupIds.map((startupId) => (
                <input key={startupId} type="hidden" name="startupIds" value={startupId} />
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() => toggleAll(!allSelected)}
                className="inline-flex items-center justify-center rounded-xl border border-line bg-surface-strong px-3 py-2 text-sm font-medium text-foreground transition hover:border-primary hover:text-foreground"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={!hasSelections}
                className="inline-flex items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive transition hover:border-destructive/40 hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete selected
              </Button>
            </form>
          ) : null}
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The generated recipient list is based on the selected audience, the recipient-selection skill, and your prompt.
        </p>
        <Label className="mt-4 grid gap-2 text-sm font-medium text-foreground">
          <span>Search recipients</span>
          <Input
            type="search"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder="Search by account, website, recipient, title, or email"
            className="w-full rounded-control border border-line bg-surface-strong px-4 py-3"
          />
        </Label>
        {generatedRecipients.length === 0 ? (
          <p className="mt-5 rounded-control border border-dashed border-line bg-surface-strong/60 px-4 py-3 text-sm text-muted-foreground">
            No recipients have been generated yet.
          </p>
        ) : visibleRecipients.length === 0 ? (
          <p className="mt-5 rounded-control border border-dashed border-line bg-surface-strong/60 px-4 py-3 text-sm text-muted-foreground">
            No recipients match your search.
          </p>
        ) : (
          <div className="mt-5">
            <PaginatedTable className="min-w-full text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4 py-3 font-medium">
                    <span className="sr-only">Select</span>
                  </TableHead>
                  <TableHead className="px-4 py-3 font-medium">Account</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Website</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Recipient</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Title</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Email</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Profiles</TableHead>
                  <TableHead className="px-4 py-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-line">
                {visibleRecipients.map((recipient) => (
                  <TableRow key={`${recipient.startupId}:${recipient.contactEmail ?? recipient.contactName ?? "account"}`}>
                    <TableCell className="px-4 py-3 text-muted-foreground">
                      <Checkbox
                        checked={selectedStartupIdSet.has(recipient.startupId)}
                        onCheckedChange={(checked) => toggleStartup(recipient.startupId, checked === true)}
                        disabled={readOnly}
                        aria-label={`Select ${recipient.startupName}`}
                        className="h-4 w-4 rounded border-line text-foreground"
                      />
                    </TableCell>
                    <TableCell className="px-4 py-3 font-medium text-foreground">{recipient.startupName}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">
                      {recipient.website ? (
                        <a
                          href={normalizeWebsiteHref(recipient.website)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-line underline-offset-4 transition hover:text-foreground hover:decoration-foreground"
                        >
                          {recipient.website}
                        </a>
                      ) : (
                        "Unknown"
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">{recipient.contactName ?? "No named contact selected"}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">{recipient.contactTitle ?? "Unknown"}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">{recipient.contactEmail ?? "Unknown"}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">
                      <SocialProfileLinks recipient={recipient} />
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right">
                      {readOnly ? null : (
                        <form action={removeRecipientsAction} className="inline-flex">
                          <input type="hidden" name="campaignId" value={campaignId} />
                          <input type="hidden" name="redirectTo" value={redirectTo} />
                          <input type="hidden" name="startupIds" value={recipient.startupId} />
                          <Button
                            type="submit"
                            aria-label={`Delete ${recipient.startupName} from recipients`}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-destructive transition hover:border-destructive/40 hover:bg-destructive/20"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="h-4 w-4">
                              <path d="M5 7h14" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                              <path d="M8 7l1-2h6l1 2" />
                              <path d="M7 7l1 12h8l1-12" />
                            </svg>
                          </Button>
                        </form>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </PaginatedTable>
          </div>
        )}
      </Card>

      {portalTarget ? createPortal(
        <div className="sticky bottom-0 z-30 px-5 pb-4 pt-10" style={{ background: "linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--background) 85%, transparent) 30%, var(--background) 55%)" }}>
          <div className="mx-auto max-w-3xl">
            <PromptField
              placeholder="Add any guidance that should influence how recipients are selected."
              rows={1}
              storageKey={`cinatra_recipient_selection_prompt_${campaignId}`}
              defaultValue={initialRecipientSelectionPrompt}
              onSubmit={handlePromptSubmit}
              submitAriaLabel="Apply recipient selection prompt"
              onStop={onStop}
              stopAriaLabel="Stop recipient generation"
              pending={isPending}
              disabled={readOnly}
              fieldClassName="border-line shadow-lg"
            />
          </div>
        </div>,
        portalTarget,
      ) : null}
    </>
  );
}
