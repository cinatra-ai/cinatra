/**
 * The local skill shell confines a read to the MOUNTED SKILL it matched.
 *
 * The resolver used to build its target path by string concatenation —
 * `real + targetPath.slice(virtual.length)` — with no normalization and no
 * traversal check, leaning entirely on the downstream containment in the
 * skills package. That downstream barrier bounds a path to the shared skill
 * ROOTS, so `/skills/alpha/../beta/SKILL.md` stays inside the roots and one
 * mounted skill could read a SIBLING skill's files.
 *
 * The barrier belongs at the builder too: reject a `..` segment in the
 * model-supplied path, normalize what remains, and confine the built path to
 * the matched skill's own directory. The downstream check stays as defence in
 * depth.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readSkillFileContent = vi.fn(async (filePath: string) => `CONTENT OF ${filePath}`);

vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: (filePath: string) => readSkillFileContent(filePath),
}));

const ALPHA_DIR = "/srv/skill-store/alpha/aaaa";
const BETA_DIR = "/srv/skill-store/beta/bbbb";

const mountedSkills = [
  {
    id: "skill-alpha",
    name: "Alpha",
    slug: "alpha",
    description: "alpha skill",
    directoryPath: ALPHA_DIR,
  },
  {
    id: "skill-beta",
    name: "Beta",
    slug: "beta",
    description: "beta skill",
    directoryPath: BETA_DIR,
  },
];

async function runCommand(command: string) {
  const { createLocalSkillShellTool } = await import("./skills");
  const tool = createLocalSkillShellTool({ mountedSkills: mountedSkills as never });
  const results = await tool.execute!({ commands: [command] } as never);
  return results[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("local skill shell — path confinement at the builder", () => {
  it("refuses a path that traverses out of the skill roots entirely", async () => {
    const result = await runCommand("cat /skills/alpha/../../etc/passwd");

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(readSkillFileContent).not.toHaveBeenCalled();
  });

  it("refuses a path that traverses into a SIBLING mounted skill", async () => {
    const result = await runCommand("cat /skills/alpha/../beta/SKILL.md");

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(readSkillFileContent).not.toHaveBeenCalled();
  });

  it("refuses a traversal hidden behind a cd prefix", async () => {
    const result = await runCommand('cd "/skills/alpha" && cat /skills/alpha/../beta/SKILL.md');

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(readSkillFileContent).not.toHaveBeenCalled();
  });

  it("refuses a RELATIVE path that traverses out of the skill directory", async () => {
    const result = await runCommand("cat ../beta/SKILL.md");

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(readSkillFileContent).not.toHaveBeenCalled();
  });

  it("still reads a file inside the matched skill through its virtual path", async () => {
    const result = await runCommand("cat /skills/alpha/SKILL.md");

    expect(result.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(readSkillFileContent).toHaveBeenCalledWith(`${ALPHA_DIR}/SKILL.md`);
    expect(result.stdout).toContain("CONTENT OF");
  });

  it("still reads a nested file inside the matched skill", async () => {
    const result = await runCommand("cat /skills/beta/references/guide.md");

    expect(result.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(readSkillFileContent).toHaveBeenCalledWith(`${BETA_DIR}/references/guide.md`);
  });

  it("still reads a relative path inside the first mounted skill", async () => {
    const result = await runCommand("cat SKILL.md");

    expect(result.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(readSkillFileContent).toHaveBeenCalledWith(`${ALPHA_DIR}/SKILL.md`);
  });
});

/**
 * Convergence additions.
 *
 * 1. LEXICAL confinement is not enough: a symlink INSIDE the matched skill
 *    whose target is a sibling skill passes every `..`-free prefix check, and
 *    the downstream root guard admits it too because both skills live under
 *    the same shared roots. These cases use REAL directories on disk so the
 *    canonical (realpath) layer is actually exercised.
 * 2. The legacy real-directoryPath branch had no success coverage at all.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runCommandWith(command: string, skills: unknown[]) {
  const { createLocalSkillShellTool } = await import("./skills");
  const tool = createLocalSkillShellTool({ mountedSkills: skills as never });
  const results = await tool.execute!({ commands: [command] } as never);
  return results[0]!;
}

describe("local skill shell — canonical confinement on real directories", () => {
  const store = realpathSync(mkdtempSync(join(tmpdir(), "skill-confinement-")));
  const realAlpha = join(store, "alpha");
  const realBeta = join(store, "beta");
  mkdirSync(realAlpha, { recursive: true });
  mkdirSync(realBeta, { recursive: true });
  writeFileSync(join(realAlpha, "SKILL.md"), "alpha skill");
  writeFileSync(join(realBeta, "SECRET.md"), "beta secret");
  // A symlinked DIRECTORY inside alpha that points at the sibling skill, and a
  // symlinked FILE inside alpha that points at a sibling file.
  symlinkSync(realBeta, join(realAlpha, "sneaky"));
  symlinkSync(join(realBeta, "SECRET.md"), join(realAlpha, "leak.md"));

  const realSkills = [
    { id: "s-alpha", name: "Alpha", slug: "alpha", description: "a", directoryPath: realAlpha },
    { id: "s-beta", name: "Beta", slug: "beta", description: "b", directoryPath: realBeta },
  ];

  it("refuses a read through a symlinked ANCESTOR pointing at a sibling skill", async () => {
    const result = await runCommandWith(`cat ${realAlpha}/sneaky/SECRET.md`, realSkills);

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(readSkillFileContent).not.toHaveBeenCalled();
  });

  it("refuses a read through a symlinked FILE pointing at a sibling skill", async () => {
    const result = await runCommandWith(`cat ${realAlpha}/leak.md`, realSkills);

    expect(result.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(readSkillFileContent).not.toHaveBeenCalled();
  });

  it("still reads a real file inside the matched skill through its real directory path", async () => {
    const result = await runCommandWith(`cat ${realAlpha}/SKILL.md`, realSkills);

    expect(result.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(readSkillFileContent).toHaveBeenCalledWith(join(realAlpha, "SKILL.md"));
  });
});
