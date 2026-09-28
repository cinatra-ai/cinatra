/**
 * THE SKILLS CATALOG ROWS (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentence this file serves, verbatim:
 *
 *   "Rendering reuses the landed list components (`LibraryMode`; the skills
 *    catalog rows)."
 *
 * The catalog rows were already written — inline in `SkillsPage`'s cards view.
 * A per-scope Skills tab must render THOSE rows, not a second list that merely
 * resembles them, so this file is the cut that makes them reusable: the JSX is
 * MOVED here unchanged and `/skills` now mounts it from here. That is why the
 * global page's behavioural fixtures can prove it unchanged — there is one
 * implementation, in one place, with two callers.
 *
 * The per-row AUTHORIZATION was lifted out for the same reason, into its
 * sibling ./skills-list-gate: it is the reason these rows are safe to render at
 * all, and a second surface listing them must run the identical gate rather
 * than its own approximation of it. It sits apart from this file so that a
 * renderer of the rows need not load the registry, the store and the policy
 * engine that gate depends on — which is also what lets these rows be driven
 * by a fixture at all.
 */
import Link from "next/link";
import { Kicker } from "@cinatra-ai/sdk-ui/section-header";

import { Card } from "@/components/ui/card";
import { ScopeBadge } from "@/components/scope-badge";
import type { SkillManifest } from "./skills-registry";
import type { SkillLevel } from "./skills-store";

// SkillLevel → ScopeLevel mapping for ScopeBadge rendering.
// SkillLevel has 8 values; ScopeLevel has 5 (user|team|organization|workspace|project).
// - team/organization/workspace/project → identity
// - personal/agent → user (individual ownership)
// - third-party/system → user (no canonical ownership; render as default)
export function mapSkillLevelToScopeLevel(level: SkillLevel): "user" | "team" | "organization" | "workspace" | "project" {
  switch (level) {
    case "team":
    case "organization":
    case "workspace":
    case "project":
      return level;
    case "personal":
    case "agent":
    case "system":
    default:
      return "user";
  }
}

/**
 * The catalog's card rows, exactly as `/skills` has always drawn them.
 *
 * Every href stays absolute to `/skills/...`: a skill's detail page is the ONE
 * page that skill has, and a scope tab listing it links a reader to that page
 * rather than minting a second address for the same row.
 */
export function SkillsCatalogRows({ skills }: { skills: readonly SkillManifest[] }) {
  return (
    <section className="grid gap-4">
      {skills.map((skill) => (
        <Card key={skill.id} className="border-line bg-surface backdrop-blur-none p-6">
          <Kicker size="sm" tracking="wide">Skill</Kicker>
          <h2 className="mt-2 text-xl font-semibold">
            <Link href={`/skills/${encodeURIComponent(skill.id)}`} className="underline-offset-4 hover:underline">
              {skill.name}
            </Link>
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{skill.description}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {skill.level ? (
              <ScopeBadge level={mapSkillLevelToScopeLevel(skill.level)}>{skill.level}</ScopeBadge>
            ) : null}
            <span className="rounded-full border border-line px-3 py-1 text-xs text-muted-foreground">
              Extension:{" "}
              <Link href={`/skills?q=${encodeURIComponent(skill.packageName)}`} className="font-medium underline-offset-4 hover:underline">
                {skill.packageName}
              </Link>
            </span>
            <span className="rounded-full border border-line px-3 py-1 text-xs text-muted-foreground">Skill id: {skill.slug}</span>
            <span className="rounded-full border border-line px-3 py-1 text-xs text-muted-foreground">
              Used in: {skill.usedBy.length > 0 ? skill.usedBy.join(", ") : "Not currently used"}
            </span>
          </div>
        </Card>
      ))}
    </section>
  );
}
