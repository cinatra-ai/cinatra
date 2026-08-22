// PUT THE INSTANCE AND THE ACCOUNT BACK, AND PROVE IT (chat-hitl S9k, cinatra#2824).
//
// The setup project changes two different kinds of state so the dispatch can
// reach the recommendation checkpoint, and this teardown owns BOTH:
//
//   · INSTANCE CONFIGURATION — a provider presence placeholder when no key is
//     stored, the MCP public base URL, and one `agent_assigned_skills` row. Put
//     back by `fixtures.mts restore`, in a subprocess, because those writers are
//     `server-only`.
//   · THE ACCOUNT'S PRIVILEGES — the platform-admin role string and an `owner`
//     membership of the organization that owns the agent. Put back by
//     `account-state.ts`, here, over a plain `pg` client.
//
// This suite is meant to run on a developer's own dev instance and against an
// account named by an environment variable, so leaving any of those in place
// would leave that instance — or that person — quietly different afterwards.
//
// IT RUNS WHETHER THE FLOW PASSED OR FAILED. Playwright runs a project's
// `teardown` after that project and everything depending on it finishes, including
// after a failure — which is the only kind of restore worth having, because the
// run that most needs putting back is the one that died halfway through.
//
// THE ASSERTION IS THE POINT. Neither half merely calls the writers: each re-reads
// the state it changed, compares it to the snapshot taken BEFORE the first write,
// and prints its own verified marker only when they match. A mismatch names the
// field. This test asserts both verdicts, so a teardown that silently failed to
// restore reds the run instead of passing quietly.
//
// BOTH HALVES ARE ALWAYS ATTEMPTED. They are independent, so a failure in one must
// not skip the other: the account grants are the wider blast radius, so they go
// first, and every failure collected is reported together rather than the first one
// hiding the rest.
import { execFileSync } from "node:child_process";
import { test as teardown, expect } from "@playwright/test";

import { restoreAccountState } from "./account-state";

teardown("restore the instance configuration and the account grants", async ({ baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const failures: string[] = [];

  let accountOut = "";
  try {
    accountOut = await restoreAccountState();
    console.log(accountOut.trim());
  } catch (err) {
    failures.push(`the S9k teardown could not restore the account:\n${String(err)}`);
  }

  let fixtureOut = "";
  try {
    fixtureOut = execFileSync(
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
    console.log(fixtureOut.trim());
  } catch (err) {
    // The subprocess's own output carries the named mismatch; surface it rather
    // than the exit code alone.
    const e = err as { stdout?: string; stderr?: string };
    failures.push(
      `the S9k teardown could not restore the instance:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    );
  }

  if (failures.length > 0) throw new Error(failures.join("\n\n"));

  expect(
    accountOut,
    "the teardown read the restored account role and membership back and they matched the snapshot",
  ).toContain("account restore verified");
  expect(
    fixtureOut,
    "the teardown read the restored instance state back and it matched the snapshot",
  ).toContain("restore verified");
});
