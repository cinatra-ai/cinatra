"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createTeamAction } from "./actions";

type OrganizationOption = {
  id: string;
  name: string;
};

type NewTeamFormProps = {
  organizations: OrganizationOption[];
  initialError?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  "missing-fields": "Enter a team name and choose an organization.",
};

export function NewTeamForm({ organizations, initialError }: NewTeamFormProps) {
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");

  return (
    <form action={createTeamAction} className="soft-panel max-w-2xl p-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="team-name">Team name</FieldLabel>
          <Input id="team-name" name="name" placeholder="Growth" required />
          <FieldDescription>
            Pick a short name for the capability or governance space.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="organizationId">Organization</FieldLabel>
          <input type="hidden" id="organizationId" name="organizationId" value={organizationId} />
          <Select value={organizationId} onValueChange={setOrganizationId} required>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select an organization" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {organizations.map((organization) => (
                  <SelectItem key={organization.id} value={organization.id}>
                    {organization.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {initialError ? (
          <FieldError>{ERROR_MESSAGES[initialError] ?? "Could not create the team."}</FieldError>
        ) : null}

        <div className="flex justify-end gap-3">
          <Button type="submit">Create team</Button>
        </div>
      </FieldGroup>
    </form>
  );
}
