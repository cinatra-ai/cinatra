"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FieldRendererCondition, FieldRendererProps } from "./field-renderer-registry";
import {
  fetchPersonalSkillsForAgent,
  fetchInstalledSkillsForAgent,
} from "./skill-actions";

// ---------------------------------------------------------------------------
// Condition — matches any field with x-renderer: "personal-skill"
// ---------------------------------------------------------------------------

export const isPersonalSkillField: FieldRendererCondition = (_fieldName, schema) =>
  (["@cinatra-ai/agent-builder:personal-skill","personal-skill"] as string[]).includes((schema as Record<string, unknown>)["x-renderer"] as string ?? "");

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const AGENT_ID = "campaign-email-outreach";

type SkillItem = { id: string; name: string; description: string; packageName?: string };

export function PersonalSkillRenderer({
  fieldName,
  schema,
  value,
  onChange,
  disabled,
  required,
}: FieldRendererProps) {
  const label = (schema as Record<string, unknown>).title as string | undefined ?? "Writing style";

  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchPersonalSkillsForAgent(AGENT_ID),
      fetchInstalledSkillsForAgent(AGENT_ID),
    ]).then(([personal, installed]) => {
      // Personal skills take priority; installed skills fill the rest.
      const seen = new Set<string>();
      const combined: SkillItem[] = [];
      for (const s of [...personal, ...installed]) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          combined.push(s);
        }
      }
      setSkills(combined);
    }).catch(() => {}).finally(() => setLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return null;
  if (skills.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldName} className="text-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      <p className="text-xs text-muted-foreground">
        Choose the writing style to use when generating emails.
      </p>
      <Select
        value={typeof value === "string" ? value : ""}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger id={fieldName} className="border-line">
          <SelectValue placeholder="Select a writing style…" />
        </SelectTrigger>
        <SelectContent>
          {skills.map((skill) => (
            <SelectItem key={skill.id} value={skill.id}>
              {skill.packageName ? (
                <span>
                  <span className="text-muted-foreground">{skill.packageName} — </span>
                  {skill.name}
                </span>
              ) : skill.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
