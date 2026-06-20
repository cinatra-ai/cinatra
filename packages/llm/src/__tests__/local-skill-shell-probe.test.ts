/**
 * Regression for cinatra#361 — chat agent-authoring leaked raw shell tool
 * output into the chat reply.
 *
 * Root cause: the local skill shell tool (`createLocalSkillShellTool`) supports
 * only `cat`/`head`/`tail`. The model probes the mounted skills with `find` /
 * `ls` (e.g. `find /skills/chat-agent-authoring`), gets a stderr/exit-1 result,
 * and then ECHOES that raw `{stdout,stderr,exit_code}` output verbatim into its
 * user-visible message. The fix makes the unsupported-command error
 * self-correcting and non-alarming — naming the exact supported verb + path
 * shape — so the model retries with `cat /skills/<slug>/SKILL.md` and any
 * echoed text reads as guidance, not a failure.
 *
 * These tests pin the executor contract directly through the tool's `execute`:
 *  - `find` / `ls` / `grep` probes return exit 1 with the self-correcting
 *    guidance (and NEVER throw / crash the turn).
 *  - the guidance names `cat /skills/<slug>/SKILL.md` and forbids find/ls/grep.
 *  - `cat /skills/<slug>/SKILL.md` still resolves to the mounted skill body.
 */
import { describe, it, expect, vi } from "vitest";

const { readSkillFileContentMock } = vi.hoisted(() => ({
  readSkillFileContentMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: (p: string) => readSkillFileContentMock(p),
}));

// The local shell tool never touches the provider surface, but the module
// imports it at load time — provide an inert stub so the import resolves.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(() => {
    throw new Error("not needed for the local shell tool");
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

import { createLocalSkillShellTool } from "../tools/skills";

const MOUNTED = [
  {
    id: "@cinatra-ai/chat:chat-agent-authoring",
    name: "chat-agent-authoring",
    slug: "chat-agent-authoring",
    description: "Author a new agent",
    sourcePath: "/real/extensions/assistant-skills/skills/chat-agent-authoring/SKILL.md",
    directoryPath: "/real/extensions/assistant-skills/skills/chat-agent-authoring",
  },
];

function shell() {
  return createLocalSkillShellTool({ mountedSkills: MOUNTED });
}

describe("local skill shell — probe handling (cinatra#361)", () => {
  it("returns self-correcting guidance for a `find /skills/<slug>` probe (no throw, exit 1)", async () => {
    const tool = shell();
    const [out] = await tool.execute({
      commands: ["find /skills/chat-agent-authoring"],
    });

    expect(out.stdout).toBe("");
    expect(out.outcome).toEqual({ type: "exit", exitCode: 1 });
    // Actionable: names the supported verb + canonical path shape.
    expect(out.stderr).toContain("cat /skills/<slug>/SKILL.md");
    expect(out.stderr.toLowerCase()).toContain("cat");
    // Explicitly steers away from the verbs that caused the failed probe.
    expect(out.stderr).toMatch(/do not use find/i);
  });

  it("returns the same guidance for an `ls /skills/<slug>` probe", async () => {
    const tool = shell();
    const [out] = await tool.execute({
      commands: ["ls /skills/chat-agent-authoring"],
    });
    expect(out.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(out.stderr).toContain("cat /skills/<slug>/SKILL.md");
  });

  it("the guidance does NOT read as an alarming raw failure — no `No such file or directory`", async () => {
    const tool = shell();
    const [out] = await tool.execute({
      commands: ["find /skills/chat-extension-authoring-core"],
    });
    // The pre-fix model echoed `find: '...': No such file or directory` arrays.
    // Our executor never emits that shape; it emits guidance.
    expect(out.stderr).not.toMatch(/No such file or directory/i);
  });

  it("still reads a mounted skill via `cat /skills/<slug>/SKILL.md`", async () => {
    readSkillFileContentMock.mockResolvedValueOnce("# chat-agent-authoring body");
    const tool = shell();
    const [out] = await tool.execute({
      commands: ["cat /skills/chat-agent-authoring/SKILL.md"],
    });

    expect(out.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(out.stdout).toContain("chat-agent-authoring body");
    expect(out.stderr).toBe("");
    // Resolved against the real on-disk dir, never exposing it to the caller.
    expect(readSkillFileContentMock).toHaveBeenCalledWith(
      "/real/extensions/assistant-skills/skills/chat-agent-authoring/SKILL.md",
    );
  });
});
