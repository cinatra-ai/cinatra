# @cinatra-ai/skills

## Persisting skills: always use `upsertSkill`

`upsertSkill` is the single canonical function for creating and updating skills of any type. It handles path composition, disk write, `sourcePath` recording, and DB catalog sync internally. Callers never construct file paths.

```typescript
import { upsertSkill } from "@cinatra-ai/skills";

const skill = await upsertSkill({
  type: "system",           // see type table below
  packageName: "agent-scrape",
  name: "Scrape: My Instance",
  content: skillMarkdown,
});
// skill.id — use this as skillId in runResolvedSkillAwareDeterministicLlmTask
// skill.sourcePath — absolute path to the written SKILL.md
```

### Type → disk path convention

All paths are relative to the configured skills data root (e.g. `data/skills/cinatra-ai-dev-skills-store`).

| `type` | Disk path | Use case |
|---|---|---|
| `"personal"` | `~personal/<userId>/<skillSlug>/SKILL.md` | Per-user, per-agent skills generated from saved guidance |
| `"system"` | `<packageSlug>/skills/<skillSlug>/SKILL.md` | Skills created and managed by an agent package at runtime |
| `"team"` | `~team/<packageSlug>/<skillSlug>/SKILL.md` | User-created custom skills (from the Skills UI) |
| `"organization"` | `~organization/<packageSlug>/<skillSlug>/SKILL.md` | Organization-wide skills |
| `"agent"` | `~agent/<slugified-npm-name>/<skillSlug>/SKILL.md` | Agent-owned SKILL.md compiled from `agents/<slug>/skills/` via `agent_source_compile` |

The `~` prefix namespaces user-managed and platform-managed directories away from package-owned ones.

### Which type to use

- **Agent packages** generating instance-specific skills at runtime → `"system"`, `packageName` = the package name (e.g. `"agent-scrape"`, `"agent-research"`, `"agent-enrichment"`).
- **Campaign/outreach custom skills** → `"personal"` (via `upsertCustomSkill` wrapper or directly).
- **User creating a skill from the Skills UI** → `"team"` (via `createSkillFromTemplate` wrapper or directly).
- **Agent-owned SKILL.md files** (from `agents/<slug>/skills/`) → `"agent"`, `packageName` = the npm scoped name from `agents/<slug>/package.json#name`, `agentId` = same npm name. Written by `agent_source_compile` — never call `upsertSkill` with `type:"agent"` manually.

### `type:"agent"` skillSlug derivation

When `type` is `"agent"`, `upsertSkill` uses `skillId.split(":").pop()` to derive `skillSlug` instead of stripping the `packageId` prefix. This is necessary because the skill ID uses the `custom:<dir-slug>:<skill-slug>` namespace while `packageName` is the scoped npm name — the prefix lengths don't match. Do not pass a `skillId` where the last `:` segment is not the intended slug.

### Deprecated functions

| Function | Replacement |
|---|---|
| `createSkillFromTemplate` | `upsertSkill({ type: "team", ... })` |
| `upsertCustomSkill` | `upsertSkill({ type: "personal", ... })` |
| `upsertPersonalSkill` | `upsertCustomSkill` (deprecated alias) |

Both wrappers remain for backward compatibility but new code should call `upsertSkill` directly.

## Why `sourcePath` matters

When a skill record has `sourcePath` set, the LLM orchestration layer (`buildSkillTools`) automatically adds a `type: "shell"` tool to the API request with the skill's local directory path. This tells the LLM provider where the SKILL.md file lives on disk, enabling it to read the skill content via shell commands without the LLM needing to voluntarily call `read_skill`.

Skills persisted via `upsertSkill` always have `sourcePath` set. DB-only skills without `sourcePath` are migrated lazily in two places:
- **`skills.installed.get` MCP handler** — transparent migration on first access; all callers benefit automatically.
- **`resolveInstanceSkillId`** in agent packages — fallback for agent-specific skill resolution.

If `sourcePath` is recorded but the file has been deleted, `skills.installed.get` returns `{ error: "Skill file missing at …" }` — consistent with the error-return convention used by all other handlers in that file.

### Slug derivation gotcha

`upsertSkill` derives `skillSlug` from `skillId` by stripping the computed `packageId` prefix (`custom:<packageSlug>:`). If the stored `skillId` uses a different namespace (e.g. `@cinatra-ai/agent-builder:…` instead of `custom:agent-builder:…`), the prefix length mismatch produces a wrong slug and a garbled disk path. The function guards against this by falling back to stripping any `@scope/name:` prefix when the skillId doesn't start with the expected `packageId:` prefix. If you observe a skill directory with an unexpected `r:` or similar prefix, re-upsert the skill via `skills_installed_upsert` MCP tool after restarting the server — the fixed derivation will write to the correct path and update `sourcePath` in the catalog.

> Note: the `@cinatra-ai/agent-builder:` prefix shown above is the **legacy renderer-ID format** intentionally preserved because changing it would require a DB migration of `agent_templates.payload`. The literal string lives on in stored skill records — leave it untouched in code and docs that document the on-disk / DB shape.

## Reading skill file content

```typescript
import { readSkillFileContent } from "@cinatra-ai/skills";

const content = await readSkillFileContent(skill.sourcePath);
```

The path is validated to be within the configured skills data directory before reading.

## Deleting skills

`deletePersonalSkill` uses `sourcePath` from the catalog record to locate and remove the skill directory. For skills without `sourcePath` (legacy records), it falls back to the old `personal/<userId>/<slug>` path convention.

## `createOrUpdateCustomSkillForAgent` — agentId format

`createOrUpdateCustomSkillForAgent` accepts `agentId` in either of two formats:

- **Full scoped npm name** — e.g. `"@cinatra-ai/email-outreach-agent"` (the value stored in `agentRunHitlPrompts.agentId` and used by `readNonExcludedAgentIdsForRun`)
- **Slug only** — e.g. `"email-outreach"` (the SKILL.md frontmatter `identifier` value)

The catalog lookup (in `personal-skills.ts`) performs a two-pass find: it first tries an exact match against `entry.id`, then falls back to matching the npm suffix (the part after `/`). This means you do **not** need to slugify the package name before passing it to the function — either format resolves correctly. The same two-pass fallback is used by `getAssignedSkillIdsForAgent`.

## Skill matcher — canonical agent reader

The matcher's "agents" axis is the UNION of:

1. **DB-installed agent templates** — `cinatra.agent_templates` rows with `packageName IS NOT NULL` and `status IN ('active', 'published')`. User-installed agents (extensions, agent-builder publishes).
2. **Provider-declared agents on disk** — agents under `<installDir>/cinatra/<slug>/cinatra/agent.json` (4-rung resolver mirrors `handleAgentBuilderGitList`). These ship with the platform and are surfaced today via `agent_source_list` but never enter `agent_templates`.

Use `readAgentsForSkillMatching({ throwOnError? })` from `@/lib/agents-store` for any read on the matcher path (UI tabs, `matchAgentsToSkills`, `getAssignedSkillIdsForAgent`, MCP `skills_match_batch_run_now` / `skills_match_evaluate_pair`, manual add/remove server actions, personal-skill flows). It internally calls both `readInstalledAgentTemplates()` and `readProviderDeclaredAgents()` and dedupes by packageId — DB row wins on collision (richer metadata).

`readAgentsCatalog()` (the legacy `readdirSync(packages/*)` scan) is reserved for non-matcher callers that genuinely need the workspace BUILD package list — do not introduce new matcher-adjacent call sites pointing at it.

The matcher write path passes `throwOnError: true` so transient upstream read failures halt the job rather than silently clobbering the legacy `agent_skill_matches` projection with empty data. `throwOnError` threads through every read in the union: `readInstalledAgentTemplates`, root readdir, per-agent JSON parse, and existing-but-malformed sibling `package.json` (ENOENT on the sibling is silently skipped — legitimate "no fallback" case). Default (`throwOnError: false`) is fine for read-only UI / inline-eval / personal-skill form callers.

### Matches projection rules

- The Matches tab projection is for cross-agent skills only. Bundled `level=agent` skills owned by an agent are part of the agent itself and are NEVER projected as "matches".
- The "Add a skill" dropdown for any agent must `.filter((skill) => skill.level !== "agent")` BEFORE the assigned-elsewhere filter. Agents are self-contained; bundled skills are not assignable across agents.
- Runtime injection of self-owned `level=agent` skills in `getAssignedSkillIdsForAgent()` is intentionally unchanged — execution-time skill resolution still resolves an agent's own bundled skills from the catalog. Only the user-facing Matches projection is affected.

## Scope Model widening

The `SkillLevel` union in `src/skills-store.ts` includes `"workspace"` and `"project"`:

```typescript
export type SkillLevel =
  | "personal"
  | "team"
  | "organization"
  | "workspace"     // platform-instance scope
  | "project"       // bounded execution context scope
  | "third-party"
  | "system"
  | "agent";
```

The widening is **behavior-preserving** — existing switch statements with `default` branches absorb the values cleanly. No skills currently exist at the workspace or project levels; the values are present so the canonical four-level + project scope vocabulary is consistent across the UI.

### UI consumption

- `src/plugin-pages.tsx` filter pill row exposes Workspace and Project tabs
- Skill cards on `/skills` render their level via `<ScopeBadge>` from `src/components/scope-badge.tsx` (the canonical component — do not re-apply ownership-level palette classes inline)
- Two small mapping helpers (`mapSkillLevelToScopeLevel`, `mapPackageLevelToScopeLevel`) translate the 8-value `SkillLevel` to the 5-value `ScopeLevel` for badge rendering. The legacy `system`, `third-party`, `agent`, and `personal` values map to `user` on the badge — the visual encoding shows ownership scope, not the legacy "kind" distinction.

### When adding a new SkillLevel value

1. Add the literal to the `SkillLevel` union in `skills-store.ts`
2. Add a corresponding entry to `levelFilterOptions` in `plugin-pages.tsx`
3. Update the two mapping helpers if the new value should render as one of the 5 ScopeBadge variants (otherwise it falls through to `user`)
4. Run `pnpm typecheck` from the repo root and `cd packages/skills && pnpm exec vitest run src/plugin-pages.test.tsx`

## Extension Registry — Skill Package Handler

`createSkillExtensionHandler()` connects `@cinatra-ai/skills` to the extension registry. It is the adapter between the generic `ExtensionTypeHandler` interface (from `@cinatra-ai/extensions`) and the skills-specific install/uninstall flows.

```typescript
import { createSkillExtensionHandler } from "@cinatra-ai/skills/extension-handler";

// already wired in src/lib/extensions.ts — do not duplicate
extensionRegistry.register(createSkillExtensionHandler());
```

### What it does

| Method | Calls |
|--------|-------|
| `install(ref, actor)` | `installSkillPackageFromGitHub(ref.packageName)` → `matchAgentsToSkills()` |
| `update(ref, actor)` | Same as install (upsert semantics — no separate path needed) |
| `uninstall(ref, actor)` | `uninstallSkillPackage("github:<packageName>")` → filter `agent_skill_matches` blob to remove entries prefixed `"github:<packageName>:"` → save filtered blob |

`validate()` is intentionally absent — deferred.

### PackageRef format

`ref.packageName` is always `"owner/repo"`. The `github:owner/repo` packageId used by `uninstallSkillPackage` is derived internally by the handler — callers pass the raw `PackageRef` from the registry.

### server-only boundary

`packages/skills/src/extension-handler.ts` starts with `import "server-only"`. It must never be imported from a client component or a shared (non-server) module.
