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
import { SNAPSHOT_SKIPPED_VERDICT } from "./state-rules";

/**
 * A teardown reports ONE of two things, and never nothing.
 *
 *   verified — it restored what it changed and read the result back.
 *   skipped  — there was no snapshot of ITS OWN to restore from, so it changed
 *              nothing. A run refused by the account claim lands here, and lands
 *              here WITHOUT having touched the state of the run that holds the
 *              claim: the snapshot is stamped with a run token and a teardown
 *              consumes only its own (`state-rules.ts`).
 *
 * The distinction is the whole point. `verified` used to be printed for both, so
 * the refused run tore the live run's account down and the live run's own teardown
 * then vouched for a restore that had already been consumed out from under it.
 */
function expectVerdict(output: string, half: string, marker: string): void {
  const verified = output.includes(`${marker}verified`);
  const skipped = output.includes(`${marker}${SNAPSHOT_SKIPPED_VERDICT}`);
  // EXACTLY ONE. "At least one" would accept an output carrying both, which is a
  // teardown that took two paths and cannot mean either of them.
  expect(
    verified !== skipped,
    verified
      ? `the ${half} teardown printed BOTH a verified verdict and a "${SNAPSHOT_SKIPPED_VERDICT}" ` +
        "verdict, so neither can be read as its outcome"
      : `the ${half} teardown printed neither a verified verdict nor an explicit ` +
        `"${SNAPSHOT_SKIPPED_VERDICT}" — it may have changed state it cannot vouch for`,
  ).toBe(true);
  if (skipped) {
    console.log(`[S9k teardown] ${half}: ${SNAPSHOT_SKIPPED_VERDICT} — nothing was changed`);
  }
}

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

  expectVerdict(accountOut, "account", "account restore ");
  expectVerdict(fixtureOut, "instance", "restore ");
});
