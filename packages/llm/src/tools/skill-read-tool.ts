/**
 * The restricted, NAMED skill-read function tool contract (exec-plane S2,
 * cinatra#1707 — singular-native-shell rule).
 *
 * When a request carries skills but NO execution authorization (or the model
 * rejects OpenAI's native shell), skill delivery is emitted as this named
 * function tool — NEVER a privileged shell surface. It is restricted by
 * construction: dispatch routes to the skill shell tool's read-only executor
 * (cat/head/tail over catalog-resolved skill snapshots), never to the
 * execution plane.
 *
 * Kept as a tiny dependency-free leaf (mirroring `openai-model-capabilities`)
 * so the adapter, the orchestration barrel, and app-side surfaces share ONE
 * name without dragging provider SDK imports — and so test mocks of the
 * provider modules never have to stub it.
 *
 * NOTE the name is deliberately NOT `read_skill` — that legacy function tool
 * was retired to close the catalog-bypass surface and is banned by
 * `scripts/audit/read-skill-function-tool-banned.mjs`. This tool differs
 * structurally: it has no catalog lookup of its own; it can only read what the
 * delivery layer already mounted.
 */

/** The contractual tool name for restricted skill-file reads. */
export const SKILL_FILE_READ_TOOL_NAME = "skill_file_read" as const;

/** JSON schema for the restricted skill-read function tool. */
export const SKILL_FILE_READ_PARAMETERS = {
  type: "object" as const,
  properties: {
    command: {
      type: "string",
      description:
        "A read-only command: cat, head, or tail on a /skills/<slug>/... file " +
        "(e.g. `cat /skills/my-skill/SKILL.md`).",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

/**
 * Model-facing description, listing the mounted skills' SKILL.md paths so the
 * model reads them lazily (ids + descriptions only; content never inlined).
 */
export function skillFileReadDescription(
  skills: Array<{ path: string; description: string }>,
): string {
  const listing =
    skills.length > 0
      ? " Available skills: " +
        skills.map((s) => `'${s.path}/SKILL.md' — ${s.description}`).join("; ") +
        "."
      : "";
  return (
    "Read a skill file (read-only; cat, head, or tail on files under " +
    "/skills/<slug>). Read a skill's SKILL.md lazily when the skill applies " +
    "to the task." +
    listing
  );
}
