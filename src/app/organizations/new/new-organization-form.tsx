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
import { organizationCreateErrorMessage } from "./error-messages";

type NewOrganizationFormProps = {
  initialError?: string;
};

export function NewOrganizationForm({ initialError }: NewOrganizationFormProps) {
  const errorMessage = organizationCreateErrorMessage(initialError);

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

        {errorMessage ? <FieldError>{errorMessage}</FieldError> : null}

        <div className="flex justify-end gap-3">
          <Button type="submit">Create organization</Button>
        </div>
      </FieldGroup>
    </form>
  );
}
