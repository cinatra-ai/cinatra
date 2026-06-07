import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function commitSkillChange(_message: string): Promise<void> {
  // data/skills/ is gitignored in the monorepo — no local git commit is needed.
  // Push directly to the connected GitHub skills repo (fire-and-forget).
  // Dynamic import avoids a circular dependency (github.ts → skills-store.ts → git-commit.ts).
  import("../github").then(({ pushSkillStoreToGitHub }) => {
    pushSkillStoreToGitHub().catch(() => {});
  }).catch(() => {});
}
