"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useNamespaceValidation } from "@/app/setup/name/instance-namespace-input";

export function InstanceSaveButton() {
  const { isValid } = useNamespaceValidation();
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={!isValid || pending}>
      Save
      {pending ? <Spinner /> : null}
    </Button>
  );
}
