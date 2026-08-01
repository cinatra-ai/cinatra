/**
 * Lane-local `@cinatra-ai/skills` barrel stub for the cinatra#1705 AC1/AC2/AC3
 * walk.
 *
 * WHY IT EXISTS. The repo's ROOT vitest config already replaces the bare
 * `@cinatra-ai/skills` barrel with `tests/__stubs__/cinatra-skills.ts`, because
 * the real barrel pulls `@cinatra-ai/llm` back in and runs an MCP-instructions
 * reader at module init — it is not loadable in a vitest module graph at all.
 * This lane inherits that stub, and the shared stub does not export
 * `readSkillFileContent`. That single omission is what
 * `resolveStagedSkillFiles()` (packages/llm/src/tools/skills.ts:563) calls to
 * read a staged skill's files off host disk, so under the shared stub AC3's
 * staging step fails with `staging_failed: readSkillFileContent is not a
 * function` — a HARNESS artifact, not a product defect. (Recorded as such in
 * WALK.md; the real barrel is exercised by the app, and the containment control
 * itself is separately covered by the L5 batteries.)
 *
 * WHAT IT CHANGES. Exactly one symbol. Everything else is re-exported from the
 * shared stub unchanged, and every other layer of the AC3 arms — the delivery
 * builder, the staged-file walker, the injection site, the adapter's wire
 * translation, the broker, the worker and the audit sink — is the shipped code.
 *
 * The stand-in keeps the real function's fail-closed shape: it refuses
 * traversal segments and refuses any path outside the repo's `data/skills`
 * root (`getSkillsDataRootPath()`, one of the three roots the real
 * `allowedSkillRoots()` admits) before reading. The lane's probe skill lives
 * inside that root precisely so the same containment verdict applies.
 */
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";

export * from "../../../tests/__stubs__/cinatra-skills";

/** The legacy/canonical on-disk skills root — `<repo>/data/skills`. */
function skillsDataRoot(): string {
  return path.resolve(process.cwd(), "data", "skills");
}

export async function readSkillFileContent(filePath: string): Promise<string> {
  if (filePath.split(/[/\\]/).some((part) => part === ".." || part === ".")) {
    throw new Error("Skill file path contains a traversal segment.");
  }
  const resolved = path.resolve(filePath);
  const root = skillsDataRoot();
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Skill file path is outside the allowed skill roots.");
  }
  return fsPromises.readFile(resolved, "utf8");
}
