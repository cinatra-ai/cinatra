"use client";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createOrganizationAction } from "./actions";

type NewOrganizationFormProps = {
  initialError?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  "missing-name": "Enter an organization name.",
  "slug-unavailable":
    "A unique URL slug could not be derived from that name. Try a different name.",
};

export function NewOrganizationForm({ initialError }: NewOrganizationFormProps) {
  return (
    <form
      action={createOrganizationAction}
      className="soft-panel rounded-panel max-w-2xl p-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
          <Input id="organization-name" name="name" placeholder="Acme" required />
          <FieldDescription>
            The organization&apos;s URL slug is derived from the name. The new
            organization becomes your active organization.
          </FieldDescription>
        </Field>

        {initialError ? (
          <FieldError>
            {ERROR_MESSAGES[initialError] ?? "Could not create the organization."}
          </FieldError>
        ) : null}

        <div className="flex justify-end gap-3">
          <Button type="submit">Create organization</Button>
        </div>
      </FieldGroup>
    </form>
  );
}
