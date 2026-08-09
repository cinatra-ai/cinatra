"use client";

// THE STEP'S KEY FIELD, CONTROLLED (cinatra#2502 item E).
//
// React resets a form's UNCONTROLLED fields once its action completes. Under
// the retired two-button layout that cost the operator a rejected key, which is
// one they had to replace anyway. Folding save + consent + commit into a single
// Continue makes every refusal a round trip through this form — including
// "you did not tick the consent box", where the key they typed is perfectly
// good and clearing it is pure loss. Holding the value in component state keeps
// it across the reset.
//
// The value stays in the browser: it is React state on the client, submitted
// with the form and nothing else. It is never echoed back by the server (the
// typed result carries a SANITIZED message and never the credential), never
// logged, and never placed in a URL.

import { useState } from "react";

import { Input } from "@/components/ui/input";

export function SetupProviderKeyInput({
  id,
  placeholder,
  testId,
}: {
  id: string;
  placeholder: string;
  testId?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <Input
      id={id}
      name="apiKey"
      type="password"
      autoComplete="off"
      data-testid={testId}
      placeholder={placeholder}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
