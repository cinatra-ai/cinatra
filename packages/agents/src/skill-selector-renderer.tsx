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
import { fetchInstalledSkillsForAgent, fetchSkillsBySlug } from "./skill-actions";
import { SKILL_SELECTOR_RENDERER_ID } from "./agent-builder-ids";

// ---------------------------------------------------------------------------
// Condition — matches any field with x-renderer: "skill-selector"
// (the bare "skill-selector" alias is the host-neutral legacy spelling kept
// for in-flight runs; the namespaced id comes from the id table.)
// ---------------------------------------------------------------------------

export const isSkillSelectorField: FieldRendererCondition = (_fieldName, schema) =>
  ([SKILL_SELECTOR_RENDERER_ID, "skill-selector"] as string[]).includes((schema as Record<string, unknown>)["x-renderer"] as string ?? "");

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type SkillItem = { id: string; name: string; description: string; packageName?: string };

export function SkillSelectorRenderer({
  fieldName,
  schema,
  value,
  onChange,
  disabled,
  required,
}: FieldRendererProps) {
  const label = (schema as Record<string, unknown>).title as string | undefined ?? "Skill";
  const s = schema as Record<string, unknown>;
  const skillSlug = s["x-skill-slug"] as string | undefined;
  const skillPackageSlug = s["x-skill-package-slug"] as string | undefined;
  const agentId = s["x-skill-agent-id"] as string | undefined;

  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let fetch: Promise<SkillItem[]>;
    if (skillSlug) {
      // Step-specific system skill — look up by slug + optional packageSlug
      fetch = fetchSkillsBySlug(skillSlug, skillPackageSlug);
    } else if (agentId) {
      // Agent-level generation skills — look up by agent assignment
      fetch = fetchInstalledSkillsForAgent(agentId);
    } else {
      setLoaded(true);
      return;
    }
    fetch
      .then((items) => {
        setSkills(items);
        // Auto-select if exactly one skill available
        if (items.length === 1) {
          onChange(items[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return null;
  if (skills.length === 0) return null;

  const isAutoSelected = skills.length === 1;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldName} className="text-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {isAutoSelected ? (
        <>
          <Select
            value={typeof value === "string" ? value : skills[0].id}
            disabled
          >
            <SelectTrigger id={fieldName} className="border-line">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={skills[0].id}>
                {skills[0].packageName ? (
                  <span>
                    <span className="text-muted-foreground">{skills[0].packageName} — </span>
                    {skills[0].name}
                  </span>
                ) : skills[0].name}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            One skill is available and will be applied automatically.
          </p>
        </>
      ) : (
        <Select
          value={typeof value === "string" ? value : ""}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger id={fieldName} className="border-line">
            <SelectValue placeholder="Select a skill…" />
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
      )}
    </div>
  );
}
