"use client";

import { Button } from "@/components/ui/button";

type RecompileFormProps = {
  recompileAction: (formData: FormData) => Promise<void>;
};

export function RecompileForm({
  recompileAction,
}: RecompileFormProps) {
  return (
    <form action={recompileAction} className="flex items-center gap-2">
      <Button type="submit" variant="outline">Recompile</Button>
    </form>
  );
}
