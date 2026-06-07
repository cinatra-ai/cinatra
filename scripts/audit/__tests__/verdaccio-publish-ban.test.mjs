import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  scanWorkflowText,
  scanWorkflows,
} from "../verdaccio-publish-ban.mjs";

// ---------------------------------------------------------------------------
// scanWorkflowText — the per-file content-aware analyzer. These are the
// load-bearing cases: an EXECUTED publish trips the gate; an ECHOED/printed
// publish instruction does not.
// ---------------------------------------------------------------------------

describe("scanWorkflowText — executed publish is BANNED", () => {
  it("flags `npm publish --registry <verdaccio>` in a run block", () => {
    const wf = [
      "jobs:",
      "  proof:",
      "    steps:",
      "      - name: canary publish",
      "        run: |",
      "          set -euo pipefail",
      '          npm publish --tag proof --registry "$VERDACCIO_REGISTRY_URL" --no-git-checks',
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].content).toContain("npm publish");
    expect(offenders[0].registryHint).toBe(true);
  });

  it("flags a bare `npm publish` with no --registry flag", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          npm publish",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(false);
  });

  it("flags an inline `run: npm publish ...`", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      '      - run: npm publish --registry https://registry.cinatra.ai',
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("flags `pnpm publish` (pnpm variant)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          pnpm publish bundle.tgz --no-git-checks",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].content).toContain("pnpm publish");
  });

  it("flags `yarn publish` (yarn variant)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          yarn publish --new-version 1.0.0",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].content).toContain("yarn publish");
  });

  it("flags `corepack pnpm publish` (runner-shim prefix)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          corepack pnpm publish --registry $VERDACCIO_REGISTRY_URL",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("flags a publish chained after a separator (`foo && npm publish`)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          cd dist && npm publish --no-git-checks",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
  });

  it("flags a leading env-assignment before the command", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          NODE_ENV=production npm publish",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
  });
});

describe("scanWorkflowText — printed / described publish is ALLOWED", () => {
  it("does NOT flag an echoed publish instruction", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - name: Echo maintainer steps",
      "        run: |",
      "          echo \"Maintainer next steps:\"",
      "          echo \"  pnpm publish bundle.tgz --registry <verdaccio-url> --no-git-checks\"",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });

  it("does NOT flag a printf'd publish instruction", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          printf 'run: npm publish --registry %s\\n' \"$URL\"",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });

  it("does NOT flag a `#` comment mentioning npm publish", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          # the maintainer later runs npm publish on the artifact",
      "          echo done",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });

  it("does NOT flag a heredoc body line that only prints the words", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          cat <<EOF",
      "          To release: pnpm publish bundle.tgz --registry <url>",
      "          EOF",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });

  it("does NOT flag a --registry value that merely contains 'publish'", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: |",
      "          npm install --registry https://npm.publish.example/",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });
});

describe("scanWorkflowText — no publish at all", () => {
  it("returns no offenders for a build/test workflow", () => {
    const wf = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: pnpm install --frozen-lockfile",
      "      - run: |",
      "          pnpm build",
      "          pnpm exec vitest run",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });

  it("returns no offenders for a pnpm pack (not publish) step", () => {
    const wf = [
      "jobs:",
      "  pack:",
      "    steps:",
      "      - run: |",
      "          corepack pnpm pack",
      "          shasum -a 256 bundle.tgz",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression suite — bypass holes. Each EXECUTED form below must FAIL the gate;
// each printed/described form must PASS. A run-block helper keeps the YAML
// scaffolding terse.
// ---------------------------------------------------------------------------

/** Wrap shell command lines in a `run: |` literal block scalar. */
const runBlock = (...cmds) =>
  [
    "jobs:",
    "  j:",
    "    steps:",
    "      - run: |",
    ...cmds.map((c) => "          " + c),
  ].join("\n");

describe("scanWorkflowText — flag-value + command shapes", () => {
  const bannedSingleLine = {
    "npm --prefix dist publish": "npm --prefix dist publish",
    "npm -C dist publish": "npm -C dist publish",
    "pnpm --filter ./ext publish": "pnpm --filter ./ext publish",
    "pnpm --filter foo publish": "pnpm --filter foo publish",
    "corepack pnpm --filter foo publish": "corepack pnpm --filter foo publish",
    "yarn --cwd dist publish": "yarn --cwd dist publish",
    "yarn npm publish (yarn berry)": "yarn npm publish",
    "npm -w pkg publish": "npm -w pkg publish",
    "pnpm --workspace foo publish": "pnpm --workspace foo publish",
    "npm exec -- npm publish": "npm exec -- npm publish",
    "pnpm exec npm publish": "pnpm exec npm publish",
    "npm exec --call 'npm publish'": "npm exec --call 'npm publish'",
    'bash -c "npm publish ..."': 'bash -c "npm publish --no-git-checks"',
    "sh -c 'pnpm publish'": "sh -c 'pnpm publish'",
  };

  for (const [label, cmd] of Object.entries(bannedSingleLine)) {
    it(`flags \`${label}\``, () => {
      const offenders = scanWorkflowText(runBlock(cmd));
      expect(offenders).toHaveLength(1);
    });
  }

  it("flags `curl -X PUT https://registry.cinatra.ai/...` (raw PUT publish)", () => {
    const offenders = scanWorkflowText(
      runBlock("curl -X PUT https://registry.cinatra.ai/foo -d @bundle.tgz"),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("flags `curl --upload-file x https://registry.cinatra.ai/...`", () => {
    const offenders = scanWorkflowText(
      runBlock("curl --upload-file bundle.tgz https://registry.cinatra.ai/foo"),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("flags `curl -T bundle.tgz <verdaccio url>` (upload short flag)", () => {
    const offenders = scanWorkflowText(
      runBlock("curl -T bundle.tgz https://verdaccio.internal/foo/"),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("propagates the registry hint through a `bash -c` wrapper body", () => {
    const offenders = scanWorkflowText(
      runBlock('bash -c "npm publish --registry https://registry.cinatra.ai"'),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });
});

describe("scanWorkflowText — YAML run-step forms", () => {
  it('flags a double-quoted inline `run: "npm publish ..."`', () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      '      - run: "npm publish --tag proof"',
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
  });

  it("flags a single-quoted inline `run: 'npm publish ...'`", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: 'npm publish'",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
  });

  it("flags a block scalar with a leading comment then the command", () => {
    const offenders = scanWorkflowText(
      runBlock("# release the vendored bundle", "npm publish --no-git-checks"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("flags a folded scalar `>` where `npm` and `publish` are on separate lines", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: >",
      "          npm",
      "          publish --no-git-checks",
    ].join("\n");
    const offenders = scanWorkflowText(wf);
    expect(offenders).toHaveLength(1);
  });

  it("flags a shell line-continuation `npm \\` newline `publish`", () => {
    const offenders = scanWorkflowText(
      runBlock("npm \\", "publish --no-git-checks"),
    );
    expect(offenders).toHaveLength(1);
  });
});

describe("scanWorkflowText — shell-interpreter heredoc bodies", () => {
  it("flags `bash <<'EOF'` body containing npm publish", () => {
    const offenders = scanWorkflowText(
      runBlock("bash <<'EOF'", "npm publish", "EOF"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("flags `sh <<EOF` body containing pnpm publish", () => {
    const offenders = scanWorkflowText(
      runBlock("sh <<EOF", "pnpm publish dist", "EOF"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("flags `bash <<-EOF` (dash-indented) body containing npm publish", () => {
    const offenders = scanWorkflowText(
      runBlock("bash <<-EOF", "npm publish", "EOF"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("does NOT flag a `cat <<EOF` DATA heredoc with a publish line", () => {
    const offenders = scanWorkflowText(
      runBlock("cat <<EOF", "To release: pnpm publish bundle.tgz", "EOF"),
    );
    expect(offenders).toHaveLength(0);
  });

  it("does NOT flag a `tee f <<EOF` DATA heredoc with a publish line", () => {
    const offenders = scanWorkflowText(
      runBlock("tee notes.txt <<EOF", "npm publish foo", "EOF"),
    );
    expect(offenders).toHaveLength(0);
  });
});

describe("scanWorkflowText — must-PASS descriptions (no false positives)", () => {
  it("does NOT flag a `bash -c \"echo npm publish\"` (printed inside -c)", () => {
    const offenders = scanWorkflowText(
      runBlock('bash -c "echo npm publish"'),
    );
    expect(offenders).toHaveLength(0);
  });

  it("does NOT flag a --registry value that merely contains 'publish'", () => {
    const offenders = scanWorkflowText(
      runBlock("pnpm install --registry https://npm.publish.example/"),
    );
    expect(offenders).toHaveLength(0);
  });

  it("does NOT flag the real release-prep echoed publish instruction", () => {
    const offenders = scanWorkflowText(
      runBlock(
        'echo "Maintainer next steps:"',
        'echo "  pnpm publish bundle.tgz --registry <verdaccio-url> --no-git-checks"',
      ),
    );
    expect(offenders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Second regression suite — additional REAL bypasses (+1 false positive) past
// the first hardening. Each EXECUTED form must FAIL; each printed/described
// form must PASS.
// ---------------------------------------------------------------------------

describe("scanWorkflowText — block-scalar header with trailing comment", () => {
  const blockHeader = (header, ...body) =>
    [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: " + header,
      ...body.map((c) => "          " + c),
    ].join("\n");

  it("scans the body of `run: | # comment` (literal + trailing comment)", () => {
    const offenders = scanWorkflowText(
      blockHeader("| # release the vendored bundle", "npm publish"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("scans the body of `run: > # comment` (folded + trailing comment)", () => {
    const offenders = scanWorkflowText(
      blockHeader("> # release notes", "npm", "publish --no-git-checks"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("scans the body of `run: |- # comment` (chomp + trailing comment)", () => {
    const offenders = scanWorkflowText(
      blockHeader("|- # strip", "npm publish"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("scans the body of `run: |2- # comment` (indent+chomp + comment)", () => {
    const offenders = scanWorkflowText(
      blockHeader("|2-  # notes", "npm publish"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("scans the body of `run: >- # comment` (folded chomp + comment)", () => {
    const offenders = scanWorkflowText(
      blockHeader(">- # x", "npm", "publish"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("still scans a plain `run: |` body (no regression)", () => {
    const offenders = scanWorkflowText(blockHeader("|", "npm publish"));
    expect(offenders).toHaveLength(1);
  });
});

describe("scanWorkflowText — runner/shell wrappers WITH options", () => {
  const bannedWithOptions = {
    "env NODE_ENV=production npm publish":
      "env NODE_ENV=production npm publish",
    "env -i npm publish": "env -i npm publish",
    "env -C /tmp npm publish (value flag)": "env -C /tmp npm publish",
    "npx --yes npm publish": "npx --yes npm publish",
    "npx -y npm publish": "npx -y npm publish",
    "sudo -E npm publish": "sudo -E npm publish",
    "sudo -u x npm publish (value flag)": "sudo -u x npm publish",
    "sudo -EH npm publish (combined bool)": "sudo -EH npm publish",
    "time -p npm publish (value-less -p)": "time -p npm publish",
    "nice -n 10 npm publish (value flag)": "nice -n 10 npm publish",
  };
  for (const [label, cmd] of Object.entries(bannedWithOptions)) {
    it(`flags \`${label}\``, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(1);
    });
  }

  const bannedShellC = {
    'bash -lc "npm publish"': 'bash -lc "npm publish"',
    "bash -lic 'pnpm publish'": "bash -lic 'pnpm publish'",
    'sh -ec "npm publish"': 'sh -ec "npm publish"',
    'sh -xc "npm publish"': 'sh -xc "npm publish"',
    "zsh -ic 'pnpm publish'": "zsh -ic 'pnpm publish'",
    "bash -lc 'cd dist && npm publish'": "bash -lc 'cd dist && npm publish'",
  };
  for (const [label, cmd] of Object.entries(bannedShellC)) {
    it(`unwraps + flags combined short-flag \`${label}\``, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(1);
    });
  }

  it("does NOT flag `bash -lc \"echo npm publish\"` (printed inside)", () => {
    expect(
      scanWorkflowText(runBlock('bash -lc "echo npm publish"')),
    ).toHaveLength(0);
  });

  it("does NOT flag `time -p pnpm build` (value-less -p, no publish)", () => {
    expect(scanWorkflowText(runBlock("time -p pnpm build"))).toHaveLength(0);
  });
});

describe("scanWorkflowText — pnpm workspace-root boolean flags", () => {
  const banned = {
    "pnpm -w publish": "pnpm -w publish",
    "pnpm --workspace-root publish": "pnpm --workspace-root publish",
    "corepack pnpm --workspace-root publish":
      "corepack pnpm --workspace-root publish",
    "corepack pnpm -w publish": "corepack pnpm -w publish",
    "pnpm -r publish (recursive boolean)": "pnpm -r publish",
    "pnpm --recursive publish": "pnpm --recursive publish",
  };
  for (const [label, cmd] of Object.entries(banned)) {
    it(`flags \`${label}\``, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(1);
    });
  }

  it("still flags npm value-taking `-w pkg publish` (no regression)", () => {
    expect(scanWorkflowText(runBlock("npm -w pkg publish"))).toHaveLength(1);
  });
});

describe("scanWorkflowText — command-substitution executes publish", () => {
  const banned = {
    'echo "$(npm publish)"': 'echo "$(npm publish)"',
    "echo `npm publish` (backtick)": "echo `npm publish`",
    'printf "%s\\n" "$(pnpm publish dist)"':
      'printf "%s\\n" "$(pnpm publish dist)"',
    "OUT=$(npm publish)": "OUT=$(npm publish)",
    "RESULT=`npm publish` (backtick)": "RESULT=`npm publish`",
    "nested $( $(npm publish) )": 'echo "$(echo $(npm publish))"',
    'X=$(cd dist && npm publish)': "X=$(cd dist && npm publish)",
    'printf "%s" "`npm publish`"': 'printf "%s" "`npm publish`"',
  };
  for (const [label, cmd] of Object.entries(banned)) {
    it(`flags \`${label}\``, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(1);
    });
  }

  it("flags a publish substitution inside a shell heredoc body", () => {
    expect(
      scanWorkflowText(runBlock("bash <<'EOF'", 'echo "$(npm publish)"', "EOF")),
    ).toHaveLength(1);
  });

  it("does NOT recurse into a SINGLE-quoted (literal) substitution", () => {
    expect(
      scanWorkflowText(runBlock("echo 'this is $(npm publish) literal'")),
    ).toHaveLength(0);
  });

  it("does NOT flag a DATA heredoc whose text looks like a substitution", () => {
    expect(
      scanWorkflowText(runBlock("cat <<EOF", "To release: $(npm publish)", "EOF")),
    ).toHaveLength(0);
  });
});

describe("scanWorkflowText — inline-comment curl false positive", () => {
  it("does NOT flag a GET ping with a PUT example in an inline comment", () => {
    const offenders = scanWorkflowText(
      runBlock(
        "curl https://registry.cinatra.ai/-/ping # curl -X PUT https://registry.cinatra.ai/pkg",
      ),
    );
    expect(offenders).toHaveLength(0);
  });

  it("still flags a real PUT even with a trailing inline comment", () => {
    const offenders = scanWorkflowText(
      runBlock(
        "curl -X PUT https://registry.cinatra.ai/p -T bundle.tgz # publish it",
      ),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("does NOT treat a `#` URL fragment as a comment", () => {
    expect(
      scanWorkflowText(runBlock("curl https://registry.cinatra.ai/x#frag")),
    ).toHaveLength(0);
  });

  it("does NOT strip a `#` inside a quoted string", () => {
    // The `#release` is quoted → not a comment; line is still a pure echo.
    expect(
      scanWorkflowText(runBlock('echo "see #release for npm publish"')),
    ).toHaveLength(0);
  });
});

describe("scanWorkflowText — self-found evasions (adversarial)", () => {
  it("flags a backslash-escaped command name `\\npm publish`", () => {
    expect(scanWorkflowText(runBlock("\\npm publish"))).toHaveLength(1);
  });

  it("flags quote-split command names `np''m publish` / `np\"\"m publish`", () => {
    expect(scanWorkflowText(runBlock("np''m publish"))).toHaveLength(1);
    expect(scanWorkflowText(runBlock('np""m publish'))).toHaveLength(1);
  });

  it("flags a quoted command name `'npm' publish`", () => {
    expect(scanWorkflowText(runBlock("'npm' publish"))).toHaveLength(1);
  });

  it("does NOT flag a git commit message that contains 'npm publish'", () => {
    expect(
      scanWorkflowText(runBlock('git commit -m "add npm publish docs"')),
    ).toHaveLength(0);
  });

  // DOCUMENTED LIMITATIONS — statically undecidable; these are accepted gaps
  // covered by the server-side marketplace proxy + broker, not this tripwire.
  it("does NOT catch var-indirection of the command name (documented gap)", () => {
    expect(scanWorkflowText(runBlock("${PM} publish"))).toHaveLength(0);
    expect(scanWorkflowText(runBlock("$PM publish"))).toHaveLength(0);
  });

  it("does NOT catch eval/base64-decoded publish (documented gap)", () => {
    expect(scanWorkflowText(runBlock('eval "npm publish"'))).toHaveLength(0);
    expect(
      scanWorkflowText(runBlock("echo bnBtIHB1Ymxpc2g= | base64 -d | sh")),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Third regression suite — the conservative redesign covering the
// grammar-wrapper evasion space. The detector now decomposes each run body into
// CANDIDATE SIMPLE COMMANDS and biases to FLAG, so EVERY shell-grammar wrapper
// around a `<manager> publish` trips the gate, the run-key extraction is
// broadened, and the `npm run publish-*` script-run vs `npm publish` subcommand
// distinction is honored.
// ---------------------------------------------------------------------------

describe("scanWorkflowText — broadened run-key extraction", () => {
  it("flags `run : npm publish` (spaces around the colon)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run : npm publish",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it('flags `"run": npm publish` (double-quoted key)', () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      '      - "run": npm publish',
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it("flags `'run': npm publish` (single-quoted key)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - 'run': npm publish",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it("flags `run:` then an indented plain multi-line scalar `npm publish`", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run:",
      "          npm publish",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it("flags a plain multi-line scalar with the command name split across lines", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run:",
      "          npm",
      "          publish --no-git-checks",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it("flags `run: &cmd npm publish` (YAML anchor before the value)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: &cmd npm publish",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it("flags `run: !!str | <body>` (YAML tag before a block scalar)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: !!str |",
      "          npm publish",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });

  it("flags `run: !!str npm publish` (inline tag before the value)", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: !!str npm publish",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(1);
  });
});

describe("scanWorkflowText — pnpm subcommand aliases + path/ext head", () => {
  const banned = {
    "pnpm recursive publish": "pnpm recursive publish",
    "pnpm multi publish": "pnpm multi publish",
    "pnpm m publish": "pnpm m publish",
    "/usr/bin/npm publish (absolute path head)": "/usr/bin/npm publish",
    "./node_modules/.bin/pnpm publish (relative path head)":
      "./node_modules/.bin/pnpm publish",
    "npm.cmd publish (windows .cmd shim)": "npm.cmd publish",
    "npm.exe publish (windows .exe shim)": "npm.exe publish",
    "bun publish (bun manager)": "bun publish",
  };
  for (const [label, cmd] of Object.entries(banned)) {
    it(`flags \`${label}\``, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(1);
    });
  }
});

describe("scanWorkflowText — curl joined upload flags", () => {
  it("flags `curl --upload-file=bundle.tgz <cinatra registry>` (joined)", () => {
    const offenders = scanWorkflowText(
      runBlock("curl --upload-file=bundle.tgz https://registry.cinatra.ai/pkg"),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });

  it("flags `curl -Tbundle.tgz <cinatra registry>` (joined -T)", () => {
    const offenders = scanWorkflowText(
      runBlock("curl -Tbundle.tgz https://registry.cinatra.ai/pkg"),
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0].registryHint).toBe(true);
  });
});

describe("scanWorkflowText — shell-grammar wrappers decompose", () => {
  const banned = {
    "(npm publish) (subshell)": "(npm publish)",
    "{ npm publish; } (group)": "{ npm publish; }",
    "if true; then npm publish; fi (if-compound)":
      "if true; then npm publish; fi",
    "while false; do npm publish; done (while-loop)":
      "while false; do npm publish; done",
    "for x in 1; do npm publish; done (for-loop)":
      "for x in 1; do npm publish; done",
    "! npm publish (pipeline negation)": "! npm publish",
    "env -S 'npm publish' (env split-string)": "env -S 'npm publish'",
    "env --split-string='npm publish' (joined split-string)":
      "env --split-string='npm publish'",
  };
  for (const [label, cmd] of Object.entries(banned)) {
    it(`flags \`${label}\``, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(1);
    });
  }

  it("flags a multi-line if/then/fi block in a run scalar", () => {
    const offenders = scanWorkflowText(
      runBlock("if [ -f dist ]; then", "  npm publish", "fi"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("flags a multi-line for/do/done block in a run scalar", () => {
    const offenders = scanWorkflowText(
      runBlock("for d in a b; do", "  (cd $d && npm publish)", "done"),
    );
    expect(offenders).toHaveLength(1);
  });
});

describe("scanWorkflowText — `npm run publish-*` is NOT the subcommand", () => {
  const mustPass = {
    "npm run publish-docs": "npm run publish-docs",
    "npm run publish": "npm run publish",
    "npm run-script publish": "npm run-script publish",
    "pnpm run publish": "pnpm run publish",
    "yarn run publish": "yarn run publish",
    "npm run publish --if-present": "npm run publish --if-present",
  };
  for (const [label, cmd] of Object.entries(mustPass)) {
    it(`does NOT flag \`${label}\` (a run SCRIPT, not publish)`, () => {
      expect(scanWorkflowText(runBlock(cmd))).toHaveLength(0);
    });
  }

  it("still flags a real `npm publish` next to a `run` script (no over-skip)", () => {
    expect(
      scanWorkflowText(runBlock("npm run build && npm publish")),
    ).toHaveLength(1);
  });
});

// Each grammar-wrapper form ALSO proven end-to-end through a real temp `.yml`
// fixture driven by scanWorkflows (not just the in-memory scanWorkflowText).
describe("scanWorkflows — grammar-wrapper forms via temp .yml fixtures", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verdaccio-r3-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeRun = (name, runValueLines) =>
    writeFileSync(
      join(dir, name),
      [
        "jobs:",
        "  j:",
        "    steps:",
        ...runValueLines,
      ].join("\n"),
    );

  const bannedFixtures = {
    "spaced colon": ["      - run : npm publish"],
    "quoted key": ['      - "run": npm publish'],
    "plain multi-line scalar": ["      - run:", "          npm publish"],
    "anchor": ["      - run: &c npm publish"],
    "tag block": ["      - run: !!str |", "          npm publish"],
    "pnpm recursive alias": ["      - run: pnpm recursive publish"],
    "absolute path head": ["      - run: /usr/bin/npm publish"],
    "windows .cmd shim": ["      - run: npm.cmd publish"],
    "subshell wrapper": ["      - run: (npm publish)"],
    "brace group": ["      - run: |", "          { npm publish; }"],
    "if-compound": ["      - run: if true; then npm publish; fi"],
    "while-loop": ["      - run: while false; do npm publish; done"],
    "for-loop": ["      - run: for x in 1; do npm publish; done"],
    "pipeline negation": ["      - run: '! npm publish'"],
    "env split-string": ["      - run: env -S 'npm publish'"],
    "curl joined upload": [
      "      - run: curl --upload-file=b.tgz https://registry.cinatra.ai/p",
    ],
  };

  for (const [label, runLines] of Object.entries(bannedFixtures)) {
    it(`FAILS on a real .yml with ${label}`, () => {
      writeRun("r3.yml", runLines);
      const result = scanWorkflows(dir);
      expect(result.ok).toBe(false);
      expect(result.offenders.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("PASSES on a real .yml whose run uses `npm run publish-docs`", () => {
    writeRun("scriptrun.yml", ["      - run: npm run publish-docs"]);
    const result = scanWorkflows(dir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scanWorkflows — the directory-level driver over a temp workflows dir.
// ---------------------------------------------------------------------------

describe("scanWorkflows — directory scan", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verdaccio-ban-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, content) => writeFileSync(join(dir, name), content);

  it("FAILS when a workflow executes npm publish to verdaccio", () => {
    write(
      "canary.yml",
      [
        "jobs:",
        "  proof:",
        "    steps:",
        "      - run: |",
        '          npm publish --tag proof --registry "$VERDACCIO_REGISTRY_URL"',
      ].join("\n"),
    );
    const result = scanWorkflows(dir);
    expect(result.ok).toBe(false);
    expect(result.offenders).toHaveLength(1);
    expect(result.offenders[0].file).toBe("canary.yml");
    expect(result.offenders[0].registryHint).toBe(true);
  });

  it("PASSES when a workflow only echoes a publish instruction", () => {
    write(
      "release-prep.yml",
      [
        "jobs:",
        "  pack:",
        "    steps:",
        "      - run: |",
        "          corepack pnpm pack",
        "          echo \"  pnpm publish bundle.tgz --registry <verdaccio-url> --no-git-checks\"",
      ].join("\n"),
    );
    const result = scanWorkflows(dir);
    expect(result.ok).toBe(true);
    expect(result.offenders).toHaveLength(0);
  });

  it("PASSES when no workflow publishes at all", () => {
    write(
      "build.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: pnpm build",
      ].join("\n"),
    );
    const result = scanWorkflows(dir);
    expect(result.ok).toBe(true);
  });

  it("FAILS on pnpm and yarn publish variants too", () => {
    write(
      "pnpm-pub.yml",
      ["jobs:", "  j:", "    steps:", "      - run: pnpm publish dist"].join("\n"),
    );
    write(
      "yarn-pub.yml",
      ["jobs:", "  j:", "    steps:", "      - run: yarn publish"].join("\n"),
    );
    const result = scanWorkflows(dir);
    expect(result.ok).toBe(false);
    const files = result.offenders.map((o) => o.file).sort();
    expect(files).toStrictEqual(["pnpm-pub.yml", "yarn-pub.yml"]);
  });

  it("scans .yaml extension as well as .yml", () => {
    write(
      "legacy.yaml",
      ["jobs:", "  j:", "    steps:", "      - run: npm publish"].join("\n"),
    );
    const result = scanWorkflows(dir);
    expect(result.ok).toBe(false);
    expect(result.offenders[0].file).toBe("legacy.yaml");
  });
});

// ---------------------------------------------------------------------------
// scanWorkflows — local composite actions (.github/actions/** /action.yml).
// A workflow `uses: ./.github/actions/publish` whose action.yml runs a
// publish must be caught even though the workflow itself is clean.
// ---------------------------------------------------------------------------

describe("scanWorkflows — local composite actions", () => {
  let wfDir;
  let actDir;

  beforeEach(() => {
    wfDir = mkdtempSync(join(tmpdir(), "verdaccio-wf-"));
    actDir = mkdtempSync(join(tmpdir(), "verdaccio-act-"));
  });

  afterEach(() => {
    rmSync(wfDir, { recursive: true, force: true });
    rmSync(actDir, { recursive: true, force: true });
  });

  it("FAILS when a composite action.yml executes a publish", () => {
    writeFileSync(
      join(wfDir, "ci.yml"),
      [
        "jobs:",
        "  j:",
        "    steps:",
        "      - uses: ./.github/actions/publish",
      ].join("\n"),
    );
    const pubDir = join(actDir, "publish");
    mkdirSync(pubDir, { recursive: true });
    writeFileSync(
      join(pubDir, "action.yml"),
      [
        "runs:",
        "  using: composite",
        "  steps:",
        "    - shell: bash",
        "      run: |",
        "        npm --prefix dist publish --registry https://registry.cinatra.ai",
      ].join("\n"),
    );
    const result = scanWorkflows(wfDir, actDir);
    expect(result.ok).toBe(false);
    expect(result.offenders).toHaveLength(1);
    expect(result.offenders[0].file).toBe("action.yml");
    expect(result.offenders[0].registryHint).toBe(true);
  });

  it("PASSES when the composite action only packs (no publish)", () => {
    const packDir = join(actDir, "pack");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, "action.yaml"),
      [
        "runs:",
        "  using: composite",
        "  steps:",
        "    - shell: bash",
        "      run: corepack pnpm pack",
      ].join("\n"),
    );
    const result = scanWorkflows(wfDir, actDir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live repo guard — the real .github/workflows must execute no registry
// publish.
// ---------------------------------------------------------------------------

describe("scanWorkflowText — npx -c / --call + pnpm -F", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "npx -c 'npm publish'",
    "npx --call 'npm publish'",
    "sudo npx -c 'npm publish'",
    "env FOO=bar npx --call 'npm publish'",
    "pnpm -F @cinatra/foo publish",
    "pnpm -F ./extensions/foo publish",
    "corepack pnpm -F @cinatra/foo publish",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "npx -c 'npm run build'",
    "pnpm -F @cinatra/foo run build",
    "npm run publish-docs",
    "echo 'npx -c npm publish'",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — global value-flag before publish", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "npm --loglevel verbose publish --registry https://registry.cinatra.ai",
    "npm --cache .npm-cache publish --registry https://registry.cinatra.ai",
    "pnpm --loglevel debug publish --registry https://registry.cinatra.ai",
    "npm --loglevel verbose --cache .x publish",
  ])("BANS %s (misparsed flag value must not hide publish)", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "npm install publish",
    "npm --loglevel verbose install publish",
    "npm config set somekey publish",
    "npm view publish",
    "npm install --save-dev typescript",
  ])("ALLOWS %s (publish is an argument of a real subcommand)", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — global value-flag whose value collides with a subcommand", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "npm --loglevel info publish --registry https://registry.cinatra.ai",
    "pnpm --loglevel info publish",
    "npm --cache cache publish",
    "npm --loglevel silly publish",
  ])("BANS %s (flag value is not a subcommand)", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "npm info pkg publish",
    "npm --loglevel info install foo",
    "pnpm --loglevel debug install",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — npm publish command abbreviations", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "npm pub --registry https://registry.cinatra.ai",
    "npm pu --registry https://registry.cinatra.ai",
    "npm publis",
    "bash -lc 'npm pub --registry https://registry.cinatra.ai'",
    "yarn npm pub",
    "npm --loglevel info pub",
  ])("BANS abbreviation %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "npm run pub",
    "npm pack",
    "npm prune",
    "npm publish-docs-helper-thing",
  ])("ALLOWS %s (not the publish subcommand)", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — YAML anchors / aliases", () => {
  it("flags a `run: *alias` whose &anchor is an inline npm publish", () => {
    const wf = [
      "env:",
      "  PUBLISH_CMD: &publish_cmd npm publish --registry https://registry.cinatra.ai",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: *publish_cmd",
    ].join("\n");
    expect(scanWorkflowText(wf).length).toBeGreaterThan(0);
  });

  it("flags a `run: *alias` whose &anchor is a block-scalar publish", () => {
    const wf = [
      "x: &blk |",
      "  npm publish",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: *blk",
    ].join("\n");
    expect(scanWorkflowText(wf).length).toBeGreaterThan(0);
  });

  it("flags a `run: *alias` even WITH a trailing YAML comment", () => {
    const wf = [
      "env:",
      "  PUBLISH_CMD: &publish_cmd npm publish --registry https://registry.cinatra.ai",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: *publish_cmd # publish via anchored command",
    ].join("\n");
    expect(scanWorkflowText(wf).length).toBeGreaterThan(0);
  });

  it("does NOT flag a `run: *alias` to a benign anchored command", () => {
    const wf = [
      "env:",
      "  CMD: &c npm ci",
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: *c",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });

  it("does NOT mistake a shell `&` / `&&` for a YAML anchor", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: sleep 1 &background_task && echo done",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });
});

describe("scanWorkflowText — npm exec/x --call joined + alias", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "npm exec --call='npm publish --registry https://registry.cinatra.ai'",
    "npm x --call='npm publish --registry https://registry.cinatra.ai'",
    "npm x --call 'npm publish --registry https://registry.cinatra.ai'",
    "npm exec --call 'npm publish'",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "npm exec --call='echo hi'",
    "npm x --call='npm run build'",
    "npm exec eslint .",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — corepack version descriptors + exec flag values", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "corepack pnpm@11.1.2 publish --registry https://registry.cinatra.ai",
    "corepack pnpm@latest publish",
    "corepack yarn@4 npm publish",
    "npm exec --package foo -- npm publish",
    "npm exec -p foo -- npm publish",
    "npm x --package foo -- npm publish",
    'npm exec --package foo -c "npm publish"',
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "corepack pnpm@11.1.2 install",
    "npm exec --package foo -- eslint .",
    "npm exec -p typescript -- tsc",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — quoted inline run + trailing comment", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    '"npm publish --registry https://registry.cinatra.ai" # publish extension',
    "'npm publish' # publish extension",
    '"npm publish"',
    "'npm publish'",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    '"npm ci" # install',
    '"echo npm publish" # just prints',
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — shell -c after a value-taking option", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "bash -o pipefail -c 'npm publish --registry https://registry.cinatra.ai'",
    "bash -euo pipefail -c 'npm publish'",
    "bash --noprofile --norc -e -o pipefail -c 'npm publish'",
    "zsh -o pipefail -c 'npm publish'",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "bash -o pipefail -c 'npm ci'",
    "bash -euo pipefail -c 'echo npm publish'",
    "bash script.sh",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — Windows / PowerShell command-string wrappers", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    'pwsh -Command "npm publish --registry https://registry.cinatra.ai"',
    'powershell -NoProfile -Command "pnpm publish"',
    "cmd /c npm publish --registry https://registry.cinatra.ai",
    'cmd.exe /S /C "npm publish"',
    'pwsh -c "npm publish"',
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    'pwsh -Command "npm ci"',
    "cmd /c echo npm publish",
    'powershell -NoProfile -Command "Write-Host hello"',
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — cmd /c glued body", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    'cmd /c"npm publish"',
    'cmd.exe /S /C"npm publish"',
    "cmd /Cnpm publish",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    'cmd /c"npm ci"',
    'cmd /c"echo npm publish"',
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — shell condition position + path forms", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "if npm publish; then echo ok; fi",
    "while ! npm publish; do sleep 5; done",
    "until npm publish; do sleep 5; done",
    "./node_modules/.bin/npm publish",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "if npm ci; then echo ok; fi",
    "if true; then echo npm publish; fi",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — `run:` with a trailing comment then an indented body", () => {
  it("flags a `run: # comment` followed by an indented publish body", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: # publish extension",
      "          npm publish --registry https://registry.cinatra.ai",
    ].join("\n");
    expect(scanWorkflowText(wf).length).toBeGreaterThan(0);
  });

  it("does NOT flag a `run: # comment` followed by a benign body", () => {
    const wf = [
      "jobs:",
      "  j:",
      "    steps:",
      "      - run: # just a comment",
      "          npm ci",
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });
});

describe("scanWorkflowText — flow-style step maps", () => {
  it.each([
    "steps:\n  - { name: Publish, run: npm publish --registry https://registry.cinatra.ai }",
    "steps:\n  - { run: npm publish }",
    'steps:\n  - {name: Publish, run: "npm publish"}',
  ])("BANS flow-style %#", (wf) => {
    expect(scanWorkflowText(wf).length).toBeGreaterThan(0);
  });

  it.each([
    "steps:\n  - { name: Build, run: npm ci }",
    "steps:\n  - { name: x, run: echo hi }",
  ])("ALLOWS flow-style %#", (wf) => {
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });
});

describe("scanWorkflowText — exec after manager global flags", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    "pnpm --filter ./extensions/foo exec npm publish --registry https://registry.cinatra.ai",
    "corepack pnpm --filter ./extensions/foo exec npm publish",
    "npm --prefix dist exec -- npm publish",
    "npm --workspace @cinatra/foo exec npm publish",
    "yarn --cwd dist exec npm publish",
    "pnpm -F foo exec npm publish",
  ])("BANS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    "pnpm --filter ./extensions/foo exec eslint .",
    "npm --prefix dist exec -- tsc",
  ])("ALLOWS %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });
});

describe("scanWorkflowText — quoted escapes + flow comma + env -S glued", () => {
  const inlineRun = (cmd) =>
    ["jobs:", "  j:", "    steps:", `      - run: ${cmd}`].join("\n");

  it.each([
    '"npm publish && echo \\"done\\""',
    '"cd dist && npm publish && echo \\"done\\""',
    '"npm publish --tag \\"latest\\""',
    "'npm publish && echo ''done'''",
    "env -S'npm publish'",
    "env -S 'npm publish'",
  ])("BANS inline %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd)).length).toBeGreaterThan(0);
  });

  it.each([
    '"npm ci && echo \\"done\\""',
    '"echo npm publish"',
    "env -S'npm ci'",
  ])("ALLOWS inline %s", (cmd) => {
    expect(scanWorkflowText(inlineRun(cmd))).toHaveLength(0);
  });

  it("flags a flow-style run value with a comma inside quotes", () => {
    const wf = [
      "steps:",
      '  - { name: Publish, run: "npm publish && echo, done" }',
    ].join("\n");
    expect(scanWorkflowText(wf).length).toBeGreaterThan(0);
  });

  it("does NOT flag a benign flow-style run value with a comma inside quotes", () => {
    const wf = [
      "steps:",
      '  - { name: Build, run: "npm ci, please" }',
    ].join("\n");
    expect(scanWorkflowText(wf)).toHaveLength(0);
  });
});

describe("scanWorkflows — live repository", () => {
  it("the repo's own workflows execute no registry publish", () => {
    const result = scanWorkflows();
    if (!result.ok) {
      const detail = result.offenders
        .map((o) => `${o.file}:${o.line} ${o.content}`)
        .join("\n");
      throw new Error(`unexpected publish-executing workflow(s):\n${detail}`);
    }
    expect(result.ok).toBe(true);
  });
});
