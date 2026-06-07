"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";
import { GMAIL_SENDER_FIELD_WHITELIST, normalizeGmailSenderFieldName } from "@cinatra-ai/agent-ui-protocol";

export const isGmailSenderField: FieldRendererCondition = (fieldName, schema, context) => {
  if (!context.connectedApps.includes("gmail")) return false;
  if (!context.gmailAliases || context.gmailAliases.length === 0) return false;

  const xRenderer = (schema as { ["x-renderer"]?: string })["x-renderer"];
  if (xRenderer === "@cinatra-ai/email-outreach-agent:gmail-sender" || xRenderer === "gmail-sender") return true;

  // Strict whitelist check — avoids misclassifying unrelated fields like
  // `fromAddress` in a shipping schema.
  const normalized = normalizeGmailSenderFieldName(fieldName);
  if (!GMAIL_SENDER_FIELD_WHITELIST.has(normalized)) return false;

  const type = (schema as { type?: string }).type;
  const format = (schema as { format?: string }).format;
  // Require string type and either no format or format=email.
  return type === "string" && (format === undefined || format === "email");
};

export function GmailSenderFieldRenderer({
  fieldName,
  value,
  onChange,
  disabled,
  required,
  error,
  label,
  description,
  context,
}: FieldRendererProps) {
  const aliases = context.gmailAliases ?? [];
  const stringValue = typeof value === "string" ? value : "";
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`field-${fieldName}`} className="text-foreground">
        {label}{required ? " *" : ""}
      </Label>
      <Select
        value={stringValue}
        onValueChange={(next) => onChange(next)}
        disabled={disabled}
      >
        <SelectTrigger id={`field-${fieldName}`} className="border-line">
          <SelectValue placeholder="Select a sender address" />
        </SelectTrigger>
        <SelectContent>
          {aliases.map((alias) => (
            <SelectItem key={alias.sendAsEmail} value={alias.sendAsEmail}>
              {alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
