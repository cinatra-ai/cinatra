// PUT THE INSTANCE BACK, AND PROVE IT (chat-hitl S9k, cinatra#2824).
//
// The setup project changes instance CONFIGURATION so the dispatch can reach the
// recommendation checkpoint: a provider presence placeholder when no key is
// stored, the MCP public base URL, and one `agent_assigned_skills` row. This suite
// is meant to run on a developer's own dev instance, so leaving any of those in
// place would leave that instance quietly different from the one they set up.
//
// IT RUNS WHETHER THE FLOW PASSED OR FAILED. Playwright runs a project's
// `teardown` after that project and everything depending on it finishes, including
// after a failure — which is the only kind of restore worth having, because the
// run that most needs putting back is the one that died halfway through.
//
// THE ASSERTION IS THE POINT. `fixtures.mts restore` does not merely call the
// writers: it re-reads the connection row and the MCP origin afterwards, compares
// them to the snapshot `apply` took BEFORE its first write, and prints
// "restore verified" only when they match. A mismatch exits non-zero and names the
// field. This test asserts that verdict, so a teardown that silently failed to
// restore reds the run instead of passing quietly.
import { execFileSync } from "node:child_process";
import { test as teardown, expect } from "@playwright/test";

teardown("restore the instance configuration the setup changed", async ({ baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  let out: string;
  try {
    out = execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--env-file-if-exists=.env.local",
        "--import",
        "tsx",
        "tests/e2e/chat-hitl-held-turn/fixtures.mts",
        "restore",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CINATRA_HELD_TURN_BASE_URL: origin },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    // The subprocess's own output carries the named mismatch; surface it rather
    // than the exit code alone.
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(
      `the S9k teardown could not restore the instance:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    );
  }
  console.log(out.trim());
  expect(out, "the teardown read the restored state back and it matched the snapshot").toContain(
    "restore verified",
  );
});
