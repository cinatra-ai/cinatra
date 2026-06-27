"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { setAuditRetentionAction, setRegistrationClosedAction, setSingleOrgModeAction } from "./actions";

type Props = {
  initialSingleOrg: boolean;
  initialRegistrationClosed: boolean;
  initialRetentionDays: number;
};

/**
 * admin knobs for single-org mode, self-registration, and
 * audit-log retention. Independent shadcn Cards; each submits
 * to its server action.
 */
export function AccessControlForm({
  initialSingleOrg,
  initialRegistrationClosed,
  initialRetentionDays,
}: Props) {
  const [singleOrg, setSingleOrg] = useState(initialSingleOrg);
  // UI uses the inverse phrasing "Allow new sign-ups" (D9): allowSignUps = !closed.
  const [registrationClosed, setRegistrationClosed] = useState(initialRegistrationClosed);
  const [retentionDays, setRetentionDays] = useState(String(initialRetentionDays));
  const [pendingOrg, startOrg] = useTransition();
  const [pendingRegistration, startRegistration] = useTransition();
  const [pendingRetention, startRetention] = useTransition();

  function saveSingleOrg(next: boolean) {
    setSingleOrg(next);
    startOrg(async () => {
      try {
        const fd = new FormData();
        fd.set("singleOrg", next ? "true" : "false");
        await setSingleOrgModeAction(fd);
        toast.success(next ? "Single-organization mode enabled." : "Single-organization mode disabled.");
      } catch {
        setSingleOrg(!next);
        toast.error("Could not update single-organization mode.");
      }
    });
  }

  // The switch is labeled "Allow new sign-ups"; checked = registration OPEN.
  // Persisted flag is the inverse (closedRegistration), so closed = !allow.
  function saveAllowSignUps(allow: boolean) {
    const nextClosed = !allow;
    setRegistrationClosed(nextClosed);
    startRegistration(async () => {
      try {
        const fd = new FormData();
        fd.set("registrationClosed", nextClosed ? "true" : "false");
        await setRegistrationClosedAction(fd);
        toast.success(allow ? "New sign-ups allowed." : "New sign-ups closed.");
      } catch {
        setRegistrationClosed(!nextClosed);
        toast.error("Could not update self-registration.");
      }
    });
  }

  function saveRetention() {
    startRetention(async () => {
      try {
        const fd = new FormData();
        fd.set("retentionDays", retentionDays);
        await setAuditRetentionAction(fd);
        toast.success("Audit-log retention updated.");
      } catch {
        toast.error("Retention must be at least 7 days.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Single-organization mode</CardTitle>
          <CardDescription>
            Hide the Organizations area and block organization creation for everyone. Existing
            organizations are untouched — this changes navigation and create paths only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="single-org-switch">Enable single-organization mode</FieldLabel>
            <Switch
              id="single-org-switch"
              checked={singleOrg}
              disabled={pendingOrg}
              onCheckedChange={saveSingleOrg}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Self-registration</CardTitle>
          <CardDescription>
            When off, no one can self-register. Existing users sign in normally; an admin can still
            create accounts. This blocks both email/password sign-up and social (Google) first-login.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="allow-signups-switch">Allow new sign-ups</FieldLabel>
            <Switch
              id="allow-signups-switch"
              checked={!registrationClosed}
              disabled={pendingRegistration}
              onCheckedChange={saveAllowSignUps}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Audit-log retention</CardTitle>
          <CardDescription>
            Authorization audit events are retained for this many days (default 365 = 12 months).
            Events older than the window are removed by the scheduled retention job. Minimum 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="retention-days">Retention window (days)</FieldLabel>
              <Input
                id="retention-days"
                type="number"
                min={7}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                className="max-w-40"
              />
              <FieldDescription>Advanced retention (legal hold, per-type policies) is out of scope.</FieldDescription>
            </Field>
            <Button type="button" onClick={saveRetention} disabled={pendingRetention} className="self-start">
              Save retention
            </Button>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}
