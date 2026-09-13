// Hosted-runner build swap shape (cinatra#3316): the two hosted, build-carrying
// verify workflows must provision the SAME 16G swapfile under /mnt that the
// image build already provisions, not a 4G file on the root disk.
//
// Measured cause (pull request 3386s sampler, run 34558946726): during
// "Build app (production)" mem_available_mb sat between 122 and 400 for six
// minutes with mem_used_mb up to 15850 — the 4G root-disk swapfile is not
// enough headroom, and the runner is reclaimed mid-build ("The runner has
// received a shutdown signal"). The hosted runners /mnt temp volume has the
// room the root disk lacks.
//
// Read from the real workflow files. Scoped to EXACTLY these two workflows:
// build-image.yml carries same-named steps with a deliberately different,
// disk-aware shape, and e2e-app-suites.yml is out of this changes scope.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
);

const WORKFLOWS = ["dashboard-live-verify.yml", "design-visual-verify.yml"];

const STEP_NAME = "Add CI build swap";

/** Every step whose name starts with STEP_NAME, as raw YAML text. */
function swapSteps(workflowText) {
  const lines = workflowText.split("\n");
  const stepStart = /^ {6}- name: (.+)$/;
  const steps = [];
  let current = null;
  for (const line of lines) {
    const m = stepStart.exec(line);
    if (m) {
      if (current) steps.push(current);
      current = m[1].startsWith(STEP_NAME) ? { name: m[1], body: [line] } : null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) steps.push(current);
  return steps.map((s) => ({ name: s.name, text: s.body.join("\n") }));
}

describe("hosted build swap: 16G under /mnt in both hosted verify workflows", () => {
  for (const file of WORKFLOWS) {
    describe(file, () => {
      const text = fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", file),
        "utf8",
      );
      const steps = swapSteps(text);

      it("has exactly one CI build swap step", () => {
        expect(steps.map((s) => s.name)).toEqual([
          "Add CI build swap (default-runner only)",
        ]);
      });

      it("allocates a 16G swapfile under /mnt, never on the root disk", () => {
        for (const step of steps) {
          expect(step.text).toMatch(/SWAPFILE=\/mnt\/[A-Za-z0-9._-]+/);
          expect(step.text).toContain("fallocate -l 16G");
          expect(step.text).not.toContain("/swapfile-ci-build");
          expect(step.text).not.toContain("fallocate -l 4G");
        }
      });

      it("keeps the fallocate-then-dd fallback, sized to the same 16G", () => {
        for (const step of steps) {
          expect(step.text).toMatch(
            /sudo rm -f "\$SWAPFILE"; sudo dd if=\/dev\/zero of="\$SWAPFILE" bs=1M count=16384/,
          );
          expect(step.text).not.toContain("count=4096");
        }
      });

      it("keeps the chmod/mkswap/swapon chain and the swapon/free report", () => {
        for (const step of steps) {
          expect(step.text).toContain("sudo chmod 600 \"\$SWAPFILE\"");
          expect(step.text).toContain("sudo mkswap \"\$SWAPFILE\"");
          expect(step.text).toContain("sudo swapon \"\$SWAPFILE\"");
          expect(step.text).toContain("swapon --show || true; free -h || true");
        }
      });

      it("keeps the default-runner-only guard and the never-fail warning road", () => {
        for (const step of steps) {
          expect(step.text).toContain("runner.environment == \x27github-hosted\x27");
          expect(step.text).toContain("set -uxo pipefail");
          expect(step.text).toMatch(
            /echo "::warning::CI build swap setup failed/,
          );
        }
      });
    });
  }

  it("both workflows carry byte-identical swap run blocks", () => {
    const blocks = WORKFLOWS.map((file) => {
      const text = fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", file),
        "utf8",
      );
      const step = swapSteps(text)[0];
      return step.text.slice(step.text.indexOf("        run: |"));
    });
    expect(blocks[0]).toEqual(blocks[1]);
  });
});
