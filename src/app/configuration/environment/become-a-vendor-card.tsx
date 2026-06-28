"use client";

import { useState } from "react";

import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import type { InstanceIdentity } from "@/lib/instance-identity-store";
import { applyVendorApplicationAction } from "./vendor-application-actions";

/**
 * "Become a vendor" card on the registries tab of
 * `/configuration/environment?tab=registries`.
 *
 * Renders only when the calling instance is consumer-attached but has not yet
 * been approved as a vendor (cm-side `vendorState ∈ {none, rejected}`) — the
 * visibility guard lives in the parent component (`RegistriesTabContent`),
 * not here, so the card never has to defend against being rendered out of
 * context.
 *
 * The card body is a short copy block describing the vendor scope: what it is
 * (the namespace published packages live under), that it only matters when
 * publishing to the Marketplace, and where to rename it — linking to the
 * Instance tab while the namespace is still editable, or noting it is locked
 * once the instance has published under it (`firstPublishedAt` set). Click
 * "Apply for vendor status" to open the application Dialog, whose form posts
 * the server action `applyVendorApplicationAction`.
 */
export function BecomeAVendorCard({
  identity,
  termsVersion,
  termsDigest,
  termsUrl,
  priorRejectionReason,
}: {
  identity: InstanceIdentity;
  termsVersion: string;
  termsDigest: string;
  termsUrl: string;
  priorRejectionReason?: string | null;
}) {
  const isRejected = identity.vendorState === "rejected";
  const scope = `@${identity.instanceNamespace}`;
  // The namespace can only be renamed before the instance first publishes
  // under it — same `firstPublishedAt` freeze gate the Instance tab uses
  // (see InstanceTabContent in ./page.tsx). Tailor the copy so an editable
  // scope links to the rename flow and a frozen one explains why it's locked.
  const isFrozen = identity.firstPublishedAt !== null;

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Become a vendor</CardTitle>
        <CardDescription className="max-w-2xl leading-6">
          Publish your own extensions to the Cinatra Marketplace under your
          vendor scope — the namespace your published packages live under. This
          instance&apos;s scope is{" "}
          <code className="font-mono text-xs">{scope}</code>
          {isFrozen ? (
            <>
              , now locked because this instance has already published under
              it. It only matters when you publish to the Marketplace.
            </>
          ) : (
            <>
              . It may have been auto-generated during setup; you can rename it
              on the{" "}
              <Link
                href="/configuration/environment?tab=instance"
                className="underline underline-offset-4 hover:text-primary"
              >
                Instance tab
              </Link>{" "}
              until you first publish under it. It only matters when you publish
              to the Marketplace.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isRejected && priorRejectionReason ? (
          <Alert variant="default">
            <AlertTitle>Previous application rejected</AlertTitle>
            <AlertDescription className="break-words">
              {priorRejectionReason}
            </AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm leading-6 text-muted-foreground">
          Free vendors are auto-approved inline. Commercial-tier applications
          stay pending until a marketplace moderator reviews them.
        </p>
      </CardContent>
      <CardFooter>
        <ApplyDialog
          scope={scope}
          displayName={identity.instanceDisplayName}
          termsVersion={termsVersion}
          termsDigest={termsDigest}
          termsUrl={termsUrl}
        />
      </CardFooter>
    </Card>
  );
}

function ApplyDialog({
  scope,
  displayName,
  termsVersion,
  termsDigest,
  termsUrl,
}: {
  scope: string;
  displayName: string;
  termsVersion: string;
  termsDigest: string;
  termsUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<"free" | "commercial">("free");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [name, setName] = useState(displayName);

  const isValid =
    termsAccepted &&
    name.trim().length > 0 &&
    name.trim().length <= 190;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTier("free");
          setTermsAccepted(false);
          setName(displayName);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">Apply for vendor status</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply for vendor status</DialogTitle>
          <DialogDescription>
            Submit an application to publish extensions under{" "}
            <span className="font-mono">{scope}</span>. Free tier auto-approves
            inline; commercial tier stays pending until a moderator reviews it.
          </DialogDescription>
        </DialogHeader>
        <form action={applyVendorApplicationAction}>
          <Input type="hidden" name="terms_version" value={termsVersion} />
          <Input type="hidden" name="terms_digest" value={termsDigest} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="vendor-display-name">
                Vendor display name
              </FieldLabel>
              <Input
                id="vendor-display-name"
                name="display_name"
                required
                minLength={1}
                maxLength={190}
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. ACME Group"
              />
              <FieldDescription>
                Shown wherever your vendor profile is referenced on the
                marketplace.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Tier</FieldLabel>
              <RadioGroup
                name="tier"
                value={tier}
                onValueChange={(value) =>
                  setTier(value === "commercial" ? "commercial" : "free")
                }
              >
                <Field orientation="horizontal">
                  <RadioGroupItem value="free" id="tier-free" />
                  <FieldLabel htmlFor="tier-free">
                    Free — auto-approved
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="commercial" id="tier-commercial" />
                  <FieldLabel htmlFor="tier-commercial">
                    Commercial — moderator review
                  </FieldLabel>
                </Field>
              </RadioGroup>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="terms-accepted"
                name="termsAccepted"
                checked={termsAccepted}
                onCheckedChange={(value) =>
                  setTermsAccepted(value === true)
                }
                required
              />
              <FieldLabel htmlFor="terms-accepted">
                I accept the{" "}
                {termsUrl ? (
                  <Link
                    href={termsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 hover:text-primary"
                  >
                    Cinatra Marketplace Vendor Terms ({termsVersion})
                  </Link>
                ) : (
                  <span>
                    Cinatra Marketplace Vendor Terms ({termsVersion})
                  </span>
                )}
                .
              </FieldLabel>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!isValid}>
              Submit application
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
