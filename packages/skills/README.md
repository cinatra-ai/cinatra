# @cinatra-ai/skills

The skills catalog for the Cinatra platform. It is the single source of truth for creating, persisting, installing, resolving, and matching agent skills (`SKILL.md` files) against the unified `skills` catalog, and for surfacing them to the LLM orchestration layer as on-disk shell tools.

A skill is a Markdown methodology file with YAML frontmatter. This package owns skill storage (disk write plus DB catalog sync), GitHub-based skill-package install/uninstall, agent/skill matching, and the management UI screens.

## Public API

- `upsertSkill` — canonical create/update for a skill of any level (writes `SKILL.md`, records `sourcePath`, syncs the catalog).
- `readSkillFileContent` — read a skill's content from a validated `sourcePath`.
- `deletePersonalSkill` — remove a personal skill and its directory.
- `installSkillPackageFromGitHub` — install a skill package from an `owner/repo` reference.
- `listInstalledSkills`, `listInstalledSkillPackages`, `getInstalledSkillById` — read installed skills and packages.
- `parseFrontmatter` — parse `SKILL.md` YAML frontmatter.
- `compileAndRegisterAgentSkillsForRepo` — compile agent-owned `SKILL.md` files from `agents/<slug>/skills/`.
- `registerExtensionSkill`, `registerPackageAgentSkill` — register package-bundled skills into the catalog.
- `scanSkillExtensions`, `ensureInstalledSkillsRegistered`, `resolveSkillIdForCapability` — install/uninstall-aware extension skill resolution.
- `evaluateSkillMatchRules`, `buildAgentMatchContext` — rule-based agent/skill matching.
- `createDeterministicSkillsClient` (and `DeterministicSkillsClient`) — in-process client for resolving per-agent skills via the catalog.
- `manifest-identity` helpers — `resolveSkillOwnerPackageCandidates`, `isSkillManifestGoverned`, `computeSkillManifestParity`, and related types.

### Sub-entry points

- `@cinatra-ai/skills/extension-handler` — `createSkillExtensionHandler` adapter for the extension registry (server-only).
- `@cinatra-ai/skills/cli` — command-line entry.
- `@cinatra-ai/skills/llm-matching/constants` and `@cinatra-ai/skills/llm-matching/types` — LLM-matcher constants and types.

## Usage

```typescript
import { upsertSkill, readSkillFileContent } from "@cinatra-ai/skills";

const skill = await upsertSkill({
  type: "system",
  packageName: "agent-scrape",
  name: "Scrape: My Instance",
  content: skillMarkdown,
});

const content = await readSkillFileContent(skill.sourcePath);
```

## Docs

See https://docs.cinatra.ai
