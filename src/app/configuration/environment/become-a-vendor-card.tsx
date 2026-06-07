// SPDX-License-Identifier: LicenseRef-Cinatra-Proprietary
"use client";

import { useState } from "react";

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
 * The card body is a short copy block describing scope; click "Apply for
 * vendor status" to open the application Dialog. The form posts the C3 server
 * action `applyVendorApplicationAction`.
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

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Become a vendor</CardTitle>
        <CardDescription className="max-w-2xl leading-6">
          Publish your own extensions to the Cinatra Marketplace. Your vendor
          scope will be{" "}
          <code className="font-mono text-xs">{scope}</code> — the namespace
          you set during instance setup.
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
          <input type="hidden" name="terms_version" value={termsVersion} />
          <input type="hidden" name="terms_digest" value={termsDigest} />
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
                  <a
                    href={termsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 hover:text-primary"
                  >
                    Cinatra Marketplace Vendor Terms ({termsVersion})
                  </a>
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
