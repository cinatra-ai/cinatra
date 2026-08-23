// THE WORLD THE RUNTIME NEEDS, AND NOTHING THE FLOW IS ABOUT (chat-hitl S9k,
// cinatra#2824).
//
// A fresh instance has no provider connection, no MCP public URL and no assigned
// skills. None of those is the thing under proof, and none of them is a hold: the
// hold, the card, Confirm and Skip are created by the runtime while the browser
// drives it. What this script does is put the instance in the state a real one is
// already in, so the dispatch can reach the recommendation checkpoint at all.
//
// EVERY WRITE GOES THROUGH A SHIPPED WRITER. Not one row is INSERTed by hand.
// That matters more here than in an ordinary fixture: the OpenAI row's key is
// SEALED at rest (`@/lib/connector-config-secret-fields`), so a hand-written row
// would either carry a plaintext key the reader rejects or a sealing this file
// would have to re-implement — and a fixture that re-implements production
// encryption is a second implementation that can drift into passing for the wrong
// reason. `agent_assigned_skills` is written through `insertAssignedSkill`, which
// owns the advisory lock, the cap and the position ordering.
//
// AND EVERY WRITE IS SNAPSHOTTED AND PUT BACK. This suite is meant to run on a
// developer's own dev instance, so a fixture that replaced the configured model,
// the body-logging preference or the MCP origin and walked away would leave that
// instance quietly different from the one the developer set up. So `apply` reads
// the CURRENT state first, records exactly what it is about to change, and
// `restore` puts each one back and then RE-READS to prove it. The Playwright
// `restore` teardown project runs `restore` after the suite, passing or failing.
//
// AND IT NEVER REMOVES OR CLEARS WHAT IT DID NOT WRITE. The restore does not
// replay a snapshot and does not act on "the snapshot said there was no row": it
// compares the LIVE state against what this fixture itself wrote and reverts only
// that. The placeholder key's sealed bytes are read back at write time, so the
// restore can tell its own placeholder from a REAL key stored during the run, and
// the row this fixture created from one a developer edited afterwards. A key that
// is not the placeholder is never cleared; a row that is not exactly the one this
// fixture created is never deleted; an MCP origin changed during the run is left
// where it is. See `state-rules.ts` for the rules, which are unit-covered.
//
// PUT BACK EXACTLY WHAT WAS CHANGED, AND CLAIM EXACTLY THAT. The promise is
// "everything I changed, I put back" — NOT "nothing on this instance moved while
// the suite ran". Both halves of the restore are held to the narrower sentence:
// the writes carry every concurrent change forward instead of replaying a whole
// snapshotted row over it, and the read-back compares only the fields the snapshot
// recorded this fixture as having written. The wider sentence would erase a
// developer's concurrent edit under a passing "restore verified", and would red on
// a `lastValidatedAt` stamp that has nothing to do with this suite.
//
// THE ACCOUNT'S PRIVILEGES ARE THE OTHER HALF, and they live next door in
// `account-state.ts` — the platform-admin role string and the `owner` membership
// `auth.setup.ts` grants, snapshotted and restored under the same contract.
//
// THE STORED KEY IS NEVER TOUCHED AND NEVER READ. If the instance already holds an
// OpenAI key, this file writes NOTHING to the connection row: presence is already
// satisfied, and overwriting a sealed key with a placeholder is a change no
// teardown could undo (the original plaintext is not recoverable from a snapshot
// that refuses to hold it, and a snapshot that DID hold it would put credential
// material on disk). The snapshot therefore carries the row's NON-SECRET fields
// only, read through `readRawOpenAIConnectionRow`, which never decrypts.
//
// WHY IT IS A SUBPROCESS rather than part of the Playwright setup project: these
// writers are `server-only`, so they resolve only under `--conditions=react-server`.
// The setup project shells out to this file, which is the same shape the S9b
// evidence round used (`evidence/2786-s9b-chat-thread-held/drivers/00-fixtures.mts`).
//
// NO REAL CREDENTIAL IS READ, USED OR STORED. The OpenAI row is a PRESENCE
// placeholder: generation is served by `CINATRA_TEST_LLM_PROVIDER=scripted`, and
// the placeholder exists only because the assistant runtime falls into
// `conversationOnly` without a bound provider adapter — and a conversation-only
// turn NULLS the explicit-dispatch package, so the hard pre-router never fires and
// no run is created at all.
//
// Usage (from the repo root, with .env.local pointing at the lane stack):
//   node --conditions=react-server --env-file-if-exists=.env.local --import tsx \
//     tests/e2e/chat-hitl-held-turn/fixtures.mts [apply|restore]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  writeOpenAIConnection,
  type OpenAIConnection,
} from "../../../src/lib/openai-connection-store";
import {
  deleteMetadataValueInternal,
  readRawOpenAIConnectionRow,
  writeSealedOpenAIConnectionRow,
} from "../../../src/lib/database-metadata";
import {
  OPENAI_CONNECTION_METADATA_KEY,
  type StoredOpenAIConnectionRow,
} from "../../../src/lib/connector-config-secret-fields";
import type { OpenAIServiceTier } from "../../../src/lib/types";
import {
  getMcpPublicBaseUrl,
  setMcpPublicBaseUrl,
  type McpPublicBaseUrlSource,
} from "../../../packages/mcp-server/src/llm-credentials";
import {
  MCP_PUBLIC_BASE_URL_METADATA_KEY,
  buildMcpPublicBaseUrlRow,
} from "../../../packages/mcp-server/src/mcp-public-base-url-shape.mjs";
import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "../../../src/lib/database";
import {
  deleteAssignedSkill,
  insertAssignedSkill,
  readAssignedSkillsForAgentPackage,
} from "../../../src/lib/agent-assigned-skills-store";
import {
  HELD_TURN_AGENT_PACKAGE,
  HELD_TURN_SKILL_ID,
  HELD_TURN_FIXTURE_ACTOR,
} from "./constants";
import {
  SNAPSHOT_SKIPPED_VERDICT,
  connectionRevertPlan,
  currentRunToken,
  mcpRevertPlan,
  mintRunToken,
  sealedSecretFingerprint,
  snapshotClaim,
} from "./state-rules";

const MODE = process.argv[2] ?? "apply";
if (MODE !== "apply" && MODE !== "restore") {
  throw new Error(`fixtures: unknown mode "${MODE}" (expected "apply" or "restore")`);
}

/**
 * The snapshot lives beside the storage state, under the suite's own `.auth/`,
 * which `.gitignore` covers wholesale. It holds NO secret: the OpenAI row's
 * non-secret fields, the MCP origin, and three booleans saying which of them this
 * fixture actually changed.
 */
const SNAPSHOT_PATH = fileURLToPath(new URL("./.auth/instance-state.snapshot.json", import.meta.url));

/** The non-secret fields of the stored row, exactly as stored (never normalized). */
type NonSecretRow = Omit<StoredOpenAIConnectionRow, "apiKey">;

interface InstanceSnapshot {
  /**
   * WHICH RUN WROTE THIS FILE — see `state-rules.ts`. A teardown consumes only a
   * snapshot carrying its own token, so a run refused by the account claim cannot
   * restore from, or delete, the snapshot of the run that holds it.
   */
  runToken: string | null;
  /** The row's non-secret fields, or `null` when the row did not exist at all. */
  openAIConnection: NonSecretRow | null;
  /** Whether a key was already stored — the reason the row is left alone. */
  openAIKeyWasStored: boolean;
  /** Whether `apply` wrote the connection row (so `restore` must put it back). */
  openAIConnectionWritten: boolean;
  /**
   * WHAT THIS FIXTURE ACTUALLY LEFT BEHIND, read back immediately AFTER its own
   * write, so the restore compares the live row against the fixture's own bytes
   * rather than against a snapshot of somebody else's earlier state.
   *
   * `openAIKeyFingerprint` is a pair of FNV-1a passes over the SEALED blob exactly
   * as stored — a non-cryptographic change detector, NOT a CRYPTOGRAPHIC digest,
   * and nothing in this suite computes a sha256. `sealedSecretFingerprint`
   * (`state-rules.ts`) carries the full reasoning.
   *
   * Nothing is decrypted to compute it, and the only value ever ASSIGNED to this
   * field is the fingerprint of this file's own published placeholder: it is set
   * in exactly one place (`:315`), inside the branch that just wrote that
   * placeholder, while the `before.keyStored` arm an operator key takes writes
   * nothing at all (`:301-302`). So it carries no credential material, and it is
   * the one thing that can tell "my placeholder is still there" from "a real key
   * was stored during the run".
   */
  openAIKeyFingerprint: string | null;
  openAIConnectionAfterWrite: NonSecretRow | null;
  mcpPublicBaseUrl: string | null;
  mcpPublicBaseUrlSource: McpPublicBaseUrlSource;
  mcpWritten: boolean;
  /** The origin pair read back immediately AFTER this fixture wrote it. */
  mcpAfterWrite: { publicBaseUrl: string | null; publicBaseUrlSource: McpPublicBaseUrlSource } | null;
  /**
   * Whether the assignment row was ALREADY there before this fixture ran — read
   * before the insert, not derived from it. Recording the insert's own outcome
   * afterwards would leave a window: a crash between the insert and the second
   * snapshot write would leave a row behind that the teardown believes it never
   * created.
   */
  assignedSkillExistedBefore: boolean;
  /**
   * HOW FAR THE INSERT GOT — the other half of the ownership question, recorded as
   * an explicit state rather than inferred from a missing field.
   *
   * The pre-read above is taken outside the insert's advisory lock, so a concurrent
   * writer can create the row in between; removing a row somebody else made is the
   * mirror of leaving behind one this fixture made. Each state answers "may this
   * teardown delete the row?" on its own:
   *
   *   not_attempted    — the insert was never reached. Any row present now is
   *                      somebody else's. Never delete.
   *   pending          — written immediately BEFORE the call, so it is the state a
   *                      crash inside the insert leaves. The row may exist because
   *                      of this fixture, so delete it.
   *   assigned         — this fixture created the row. Delete.
   *   already_assigned — it was already there when the insert took the lock.
   *                      Never delete.
   *   cap_exceeded     — nothing was inserted. Never delete.
   */
  assignedSkillInsert:
    | "not_attempted"
    | "pending"
    | "assigned"
    | "already_assigned"
    | "cap_exceeded";
}

/**
 * The connector-config id behind the MCP settings row, derived from the shipped
 * metadata-key constant rather than spelled again here.
 */
const MCP_CONNECTOR_ID = MCP_PUBLIC_BASE_URL_METADATA_KEY.replace(/^connector_config:/, "");

/**
 * The row as this file is allowed to see it: the non-secret fields, whether a key
 * is stored, and a FINGERPRINT of the sealed key.
 *
 * RAW, never unsealed: this file has no business decrypting the operator's key,
 * and the snapshot has no business holding it. The fingerprint hashes the sealed
 * blob verbatim, so it identifies the stored value without carrying it.
 */
function readNonSecretConnection(): {
  fields: NonSecretRow | null;
  keyStored: boolean;
  keyFingerprint: string | null;
} {
  const raw = readRawOpenAIConnectionRow();
  if (!raw) return { fields: null, keyStored: false, keyFingerprint: null };
  const { apiKey, ...nonSecret } = raw;
  const keyStored =
    typeof apiKey === "string" ? apiKey.length > 0 : apiKey !== undefined && apiKey !== null;
  return { fields: nonSecret, keyStored, keyFingerprint: sealedSecretFingerprint(apiKey) };
}

/**
 * The stored row's non-secret fields, as the CONFIG type the shipped writer takes.
 *
 * ONE narrowing, and it is named rather than blanket-cast: the stored row widens
 * `serviceTier` to `string`, the writer wants its own union, and the value in the
 * row came out of that writer in the first place. Every other field is already the
 * same type on both sides — so a signature change on `writeOpenAIConnection` still
 * fails this file to compile, which is the entire reason the row is not
 * hand-written.
 */
function asConnection(row: NonSecretRow | null): OpenAIConnection {
  if (!row) return {};
  const { serviceTier, ...rest } = row;
  return {
    ...rest,
    ...(serviceTier === undefined ? {} : { serviceTier: serviceTier as OpenAIServiceTier }),
  };
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------

if (MODE === "apply") {
  const BASE = process.env.CINATRA_HELD_TURN_BASE_URL || process.env.BETTER_AUTH_URL || "";
  if (!BASE) throw new Error("fixtures: CINATRA_HELD_TURN_BASE_URL / BETTER_AUTH_URL is required");

  // (0) READ FIRST, WRITE SECOND. The snapshot is persisted BEFORE the first
  //     mutation, so a crash halfway through `apply` still leaves the teardown
  //     something to put back.
  const before = readNonSecretConnection();
  const beforeMcp = getMcpPublicBaseUrl();
  const mcpWritten = beforeMcp.publicBaseUrl !== BASE;
  const assignedBefore = await readAssignedSkillsForAgentPackage(HELD_TURN_AGENT_PACKAGE);
  const snapshot: InstanceSnapshot = {
    runToken: currentRunToken() ?? mintRunToken(),
    openAIConnection: before.fields,
    openAIKeyWasStored: before.keyStored,
    openAIConnectionWritten: !before.keyStored,
    openAIKeyFingerprint: null,
    openAIConnectionAfterWrite: null,
    mcpPublicBaseUrl: beforeMcp.publicBaseUrl,
    mcpPublicBaseUrlSource: beforeMcp.publicBaseUrlSource,
    mcpWritten,
    mcpAfterWrite: null,
    assignedSkillExistedBefore: assignedBefore.some((row) => row.skillId === HELD_TURN_SKILL_ID),
    assignedSkillInsert: "not_attempted",
  };
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);

  // (1) The provider PRESENCE placeholder. Without it `runAssistantTurn` answers
  //     "No LLM provider configured." and returns BEFORE the pre-router line, so
  //     `agent_runs` stays empty and the flow fails with no card and no diagnosis.
  //
  //     A row that ALREADY holds a key satisfies presence, so it is left exactly
  //     as it is — see the header. Otherwise the placeholder is written OVER the
  //     row's own non-secret fields rather than instead of them: the model, the
  //     body-logging preference and the model list are the developer's, and none
  //     of them changes what this flow proves (the turn is served by the scripted
  //     provider and no model is consulted at all).
  if (before.keyStored) {
    console.log("[fixture] openai_connection already holds a key — row left untouched");
  } else {
    writeOpenAIConnection({
      ...asConnection(before.fields),
      apiKey: "sk-not-a-real-key-chat-hitl-s9k",
    });
    // READ BACK WHAT WAS JUST WRITTEN, and record it. This is what makes the
    // restore able to compare the LIVE row against THIS FIXTURE'S OWN bytes: the
    // sealed placeholder's fingerprint says whether the key stored at teardown is
    // still the one written here, and the non-secret fields say whether the row is
    // still untouched since. Without it the restore could only replay a snapshot,
    // which is how it came to delete a developer's connection and clear a real key.
    const afterWrite = readNonSecretConnection();
    snapshot.openAIKeyFingerprint = afterWrite.keyFingerprint;
    snapshot.openAIConnectionAfterWrite = afterWrite.fields;
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log("[fixture] openai_connection presence placeholder written (no real key)");
  }

  // (2) The MCP public base URL — an origin-only value on the connector-config row.
  if (mcpWritten) {
    setMcpPublicBaseUrl(BASE);
    // Same discipline: the pair as it reads immediately after this write is what
    // the restore compares against, so an origin somebody changed mid-run is
    // recognizable and left alone.
    const afterMcpWrite = getMcpPublicBaseUrl();
    snapshot.mcpAfterWrite = {
      publicBaseUrl: afterMcpWrite.publicBaseUrl,
      publicBaseUrlSource: afterMcpWrite.publicBaseUrlSource,
    };
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `[fixture] mcp public base url = ${BASE} (was ${beforeMcp.publicBaseUrl ?? "unset"})`,
    );
  } else {
    console.log(`[fixture] mcp public base url already ${BASE} — left untouched`);
  }

  // (3) THE ONE ROW THAT MAKES THE CHECKPOINT REACHABLE. The recommendation scorer
  //     offers an agent's ASSIGNED skills and nothing else, so with no assignment
  //     `maybeHoldRunForRecommendation` answers "no recommendation candidates",
  //     returns `held:false`, and the run dispatches unheld — a green flow proving
  //     the opposite of what it claims. Exactly one skill is assigned, deliberately:
  //     the §V row releases only once EVERY chip is decided, so one chip makes
  //     "Confirm" and "Skip" single, unambiguous presses.
  // The crash window is CLAIMED before it is entered, not reconstructed afterwards.
  snapshot.assignedSkillInsert = "pending";
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  const assigned = await insertAssignedSkill({
    agentPackageName: HELD_TURN_AGENT_PACKAGE,
    skillId: HELD_TURN_SKILL_ID,
    createdBy: HELD_TURN_FIXTURE_ACTOR,
  });
  console.log(
    `[fixture] assigned skill ${HELD_TURN_SKILL_ID} -> ${HELD_TURN_AGENT_PACKAGE}: ${assigned.outcome}`,
  );
  // Recorded BEFORE the cap check, so even the throwing path leaves the teardown
  // an accurate ownership answer.
  snapshot.assignedSkillInsert = assigned.outcome;
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (assigned.outcome === "cap_exceeded") {
    throw new Error("fixtures: assigned-skill cap exceeded — the lane database is not clean");
  }

  console.log("fixtures done");
}

// ---------------------------------------------------------------------------
// RESTORE — and PROVE it, by reading the state back.
// ---------------------------------------------------------------------------

/** The stored key changed under the restore's own compare-and-swap. Not an error. */
class PlaceholderReplaced extends Error {}

if (MODE === "restore") {
  let snapshot: InstanceSnapshot | null = null;
  try {
    snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as InstanceSnapshot;
  } catch (err) {
    // ONLY "the file is not there" is benign, and only because `apply` writes the
    // snapshot BEFORE its first mutation: no file means nothing was changed. Any
    // other read or parse failure means a snapshot exists and cannot be read, so
    // the instance may be mid-fixture with nothing to guide the restore — that
    // must fail loudly rather than print a verdict it did not earn.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new Error(
        `fixtures: the restore snapshot at ${SNAPSHOT_PATH} exists but could not be read — ` +
          "the instance may still carry the fixture's changes and this teardown cannot " +
          `undo them: ${String(err)}`,
      );
    }
    console.log("[fixture] no snapshot — nothing was recorded, so this teardown changed nothing");
    console.log(`restore ${SNAPSHOT_SKIPPED_VERDICT}`);
  }

  // A SNAPSHOT THIS RUN DID NOT WRITE IS UNTOUCHABLE — no restore, and above all
  // no `rmSync`. It is the live record of another run's instance state.
  if (snapshot && snapshotClaim(snapshot.runToken, currentRunToken()) === "foreign") {
    console.log(
      `[fixture] the snapshot at ${SNAPSHOT_PATH} was written by another run (token ` +
        `${JSON.stringify(snapshot.runToken)}, this run ${JSON.stringify(currentRunToken())}) — ` +
        "it is left exactly as it is, and this teardown changed nothing",
    );
    console.log(`restore ${SNAPSHOT_SKIPPED_VERDICT}`);
    snapshot = null;
  }

  if (snapshot) {
    // (1) THE CONNECTION ROW — reverted only where the LIVE row is still this
    //     fixture's own write, never on the strength of the snapshot alone.
    //
    //     `connectionRevertPlan` (`state-rules.ts`, unit-covered) decides, from
    //     the fingerprint of the sealed key recorded straight after `apply`'s
    //     write and the fingerprint of what is stored now:
    //
    //       leave        — the stored key is NOT this fixture's placeholder any
    //                      more (a real key was added during the run), or there is
    //                      nothing stored at all. Touch nothing. This is the arm
    //                      that used to CLEAR a developer's real key.
    //       delete-row   — the placeholder is still stored AND the row's
    //                      non-secret fields still read exactly as this fixture
    //                      left them, so the row present now is the row this
    //                      fixture created. Remove it, through the shipped
    //                      metadata writer. A factory-reset row is not the same
    //                      state as no row, so clearing would not restore it.
    //                      This is the arm that used to fire unconditionally and
    //                      delete a connection the developer created mid-run.
    //       clear-secret — the placeholder is still stored but the row is not
    //                      solely this fixture's (it pre-existed, or somebody
    //                      edited its non-secret fields during the run). Only the
    //                      placeholder goes; every concurrent edit is carried
    //                      forward by re-reading the row LIVE.
    //
    //     HONEST LIMIT, unchanged: `clear-secret` is a read-then-write, not the
    //     store's own atomic read-modify-write (`mutateOpenAIConnection` is not
    //     exported), so a write landing inside that window is still lost. The
    //     window is milliseconds wide instead of the whole suite.
    const liveConnection = readNonSecretConnection();
    let connectionPlan = connectionRevertPlan({
      fixtureWroteConnection: snapshot.openAIConnectionWritten,
      rowExistedBefore: snapshot.openAIConnection !== null,
      fixtureKeyFingerprint: snapshot.openAIKeyFingerprint,
      liveKeyFingerprint: liveConnection.keyFingerprint,
      fixtureWroteNonSecret: snapshot.openAIConnectionAfterWrite,
      liveNonSecret: liveConnection.fields,
    });
    if (connectionPlan === "delete-row") {
      // RE-VERIFIED IMMEDIATELY BEFORE THE REMOVAL, so the window between the
      // decision and the act is one statement wide.
      //
      // HONEST LIMIT, and the reason it is a limit rather than a race closed:
      // there is no CONDITIONAL delete on the metadata row. The store exports a
      // compare-and-swap for WRITES (which is what makes the clear below atomic)
      // and an unconditional delete, so "remove this row only while it is still
      // byte-equal to what I read" is not expressible without widening a
      // production surface for a test. A row created inside this window is still
      // removed; the window is two adjacent synchronous statements rather than
      // the whole suite.
      const stillOurs = readNonSecretConnection();
      if (
        connectionRevertPlan({
          fixtureWroteConnection: snapshot.openAIConnectionWritten,
          rowExistedBefore: snapshot.openAIConnection !== null,
          fixtureKeyFingerprint: snapshot.openAIKeyFingerprint,
          liveKeyFingerprint: stillOurs.keyFingerprint,
          fixtureWroteNonSecret: snapshot.openAIConnectionAfterWrite,
          liveNonSecret: stillOurs.fields,
        }) === "delete-row"
      ) {
        deleteMetadataValueInternal(OPENAI_CONNECTION_METADATA_KEY);
      } else {
        console.log(
          "[fixture] openai_connection: the row changed between the check and the removal. " +
            "LEFT UNTOUCHED, and not asserted.",
        );
        connectionPlan = "leave";
      }
    } else if (connectionPlan === "clear-secret") {
      // ATOMIC, not read-then-write. `writeSealedOpenAIConnectionRow` is the
      // shipped writer `writeOpenAIConnection` itself delegates to, and given an
      // UPDATER it re-derives the payload inside each merge-and-swap attempt and
      // swaps only while the stored row is still byte-equal to the one the
      // updater just inspected. So the fingerprint is re-checked INSIDE the swap:
      // a real key stored between the plan above and this write makes the updater
      // throw, and nothing is written at all. That is the race the previous
      // read-then-write documented as an honest limit; it is now closed, without
      // widening any production surface (this writer is already exported for the
      // store's own mutations).
      try {
        writeSealedOpenAIConnectionRow((current) => {
          if (sealedSecretFingerprint(current?.apiKey) !== snapshot!.openAIKeyFingerprint) {
            throw new PlaceholderReplaced();
          }
          // The secret is dropped from the payload rather than carried: this file
          // never holds key material, and `preserveExistingSecret: false` is what
          // clears the stored blob.
          const nonSecret = { ...(current ?? {}) } as Partial<StoredOpenAIConnectionRow>;
          delete nonSecret.apiKey;
          return asConnection(nonSecret as NonSecretRow);
        }, { preserveExistingSecret: false });
      } catch (err) {
        if (!(err instanceof PlaceholderReplaced)) throw err;
        console.log(
          "[fixture] openai_connection: a key was stored between the check and the write, so " +
            "the clear was ABANDONED inside the swap. LEFT UNTOUCHED, and not asserted.",
        );
        connectionPlan = "leave";
      }
    } else if (snapshot.openAIConnectionWritten) {
      console.log(
        "[fixture] openai_connection: what is stored now is not the placeholder this fixture " +
          "wrote — a key or a row somebody else put there. LEFT UNTOUCHED, and not asserted.",
      );
    }

    // (2) The MCP public base URL — VALUE AND PROVENANCE.
    //
    //     `setMcpPublicBaseUrl` can only ever write `manual`, so restoring through
    //     it would silently demote an auto-provisioned URL (a Tailscale funnel
    //     tagged `tailscale-auto` / `tailscale-funnel`) to an operator-pasted one.
    //     The row is therefore rebuilt with the SAME pure shape builder that writer
    //     uses — the one the published CLI writes clone databases with — over the
    //     row read live, so every sibling field stays where it is and the source is
    //     put back as it was. The snapshot holds no part of that row but the origin
    //     and its source, both non-secret.
    //
    //     AND ONLY WHILE THE ROW STILL HOLDS WHAT THIS FIXTURE WROTE. An origin
    //     changed during the run belongs to whoever changed it; putting the
    //     snapshot back over it would be this teardown undoing somebody else's
    //     write under a passing verdict.
    const liveMcpBeforeRestore = getMcpPublicBaseUrl();
    let mcpPlan = mcpRevertPlan({
      mcpWritten: snapshot.mcpWritten,
      fixtureWrote: snapshot.mcpAfterWrite,
      live: liveMcpBeforeRestore,
    });
    if (mcpPlan === "restore") {
      const restoredSource =
        snapshot.mcpPublicBaseUrlSource === "tailscale-auto" ||
        snapshot.mcpPublicBaseUrlSource === "tailscale-funnel"
          ? { source: snapshot.mcpPublicBaseUrlSource }
          : undefined;
      // RE-CHECK, THEN READ THE ROW, THEN WRITE — in that order, and nothing in
      // between. The sibling fields the restored row carries forward come from a
      // read taken AFTER the re-check, so a concurrent edit to any of them is
      // either seen and carried forward or lands after this write; an earlier
      // draft read the row before the re-check and would have replayed a stale
      // copy of those fields over it.
      //
      // HONEST LIMIT: `writeConnectorConfigToDatabase` is the shipped writer and
      // it is not a compare-and-swap. The store DOES export raw-read plus
      // conditional-swap primitives, but they bypass this writer's own sealing
      // and connector-config cache eviction, so reaching for them here would
      // trade a millisecond-wide window for a stale cache and a second sealing
      // implementation. An origin changed inside the remaining window is still
      // overwritten.
      if (
        mcpRevertPlan({
          mcpWritten: snapshot.mcpWritten,
          fixtureWrote: snapshot.mcpAfterWrite,
          live: getMcpPublicBaseUrl(),
        }) === "restore"
      ) {
        const currentRow = readConnectorConfigFromDatabase<Record<string, unknown>>(
          MCP_CONNECTOR_ID,
          {},
        );
        writeConnectorConfigToDatabase(
          MCP_CONNECTOR_ID,
          buildMcpPublicBaseUrlRow(currentRow, snapshot.mcpPublicBaseUrl, restoredSource),
        );
      } else {
        console.log(
          "[fixture] mcp public base url: the origin changed between the check and the write. " +
            "LEFT UNTOUCHED, and not asserted.",
        );
        mcpPlan = "leave";
      }
    } else if (snapshot.mcpWritten) {
      console.log(
        "[fixture] mcp public base url: the origin stored now is not the one this fixture " +
          `wrote (${JSON.stringify(liveMcpBeforeRestore.publicBaseUrl)}, source ` +
          `${liveMcpBeforeRestore.publicBaseUrlSource}) — somebody changed it during the run. ` +
          "LEFT UNTOUCHED, and not asserted.",
      );
    }

    // (3) The assignment, removed ONLY when this fixture is the reason it is there:
    //     it was absent before, AND the insert either created it or died inside the
    //     window where it may have. Every other state belongs to somebody else.
    const fixtureOwnsAssignment =
      !snapshot.assignedSkillExistedBefore &&
      (snapshot.assignedSkillInsert === "assigned" ||
        snapshot.assignedSkillInsert === "pending");
    //     AND ONLY WHILE THE ROW PRESENT NOW IS STILL THIS FIXTURE'S. The delete
    //     is keyed on (package, skill), so a row somebody removed and re-created
    //     during the run would answer to it too; `created_by` is what tells them
    //     apart, and it is this fixture's own actor constant.
    const liveAssignment = (
      await readAssignedSkillsForAgentPackage(HELD_TURN_AGENT_PACKAGE)
    ).find((row) => row.skillId === HELD_TURN_SKILL_ID);
    const removeAssignment =
      fixtureOwnsAssignment && liveAssignment?.createdBy === HELD_TURN_FIXTURE_ACTOR;
    if (removeAssignment) {
      const removed = await deleteAssignedSkill({
        agentPackageName: HELD_TURN_AGENT_PACKAGE,
        skillId: HELD_TURN_SKILL_ID,
      });
      console.log(`[fixture] assigned skill removed: ${removed.deleted}`);
    } else if (fixtureOwnsAssignment) {
      console.log(
        `[fixture] assigned skill ${HELD_TURN_SKILL_ID}: the row present now was created by ` +
          `${JSON.stringify(liveAssignment?.createdBy ?? null)}, not by this fixture. LEFT ` +
          "UNTOUCHED, and not asserted.",
      );
    }

    // (4) READ IT BACK. A teardown that only calls the writers proves the calls
    //     were made, not that the instance is back where it started — which is the
    //     whole claim. Every mismatch is named.
    //
    //     SCOPED TO WHAT THIS FIXTURE ACTUALLY CHANGED. The claim this teardown
    //     makes is "everything I changed, I put back" — not "nothing on this
    //     instance moved while the suite ran". Those are different sentences, and
    //     asserting the second reds the run on somebody else's write: the
    //     connector stamping `lastValidatedAt`, a model list refreshing, the
    //     developer editing the row in another tab. So each field is compared ONLY
    //     when the snapshot recorded this fixture as having written it. An
    //     untouched field gets no claim at all, for the same reason the untouched
    //     assignment row below gets none.
    const after = readNonSecretConnection();
    const afterMcp = getMcpPublicBaseUrl();
    const afterAssigned = await readAssignedSkillsForAgentPackage(HELD_TURN_AGENT_PACKAGE);
    const mismatches: string[] = [];
    // EVERY CLAIM IS SCOPED TO WHAT THE RESTORE ACTUALLY DID. Each half asserts
    // the outcome of the PLAN it took, and the `leave` arms assert nothing at all —
    // this teardown made no change there, so it has nothing to vouch for, and an
    // assertion would red on somebody else's write rather than on anything this
    // suite did.
    if (connectionPlan === "delete-row") {
      // The fixture created the WHOLE row, and it was still exactly that row, so
      // the whole row must be gone — a factory-reset row is a different state to
      // every reader.
      if (after.fields !== null) {
        mismatches.push(
          "openai_connection: the row this fixture created is still present, read " +
            `${JSON.stringify(after.fields)}`,
        );
      }
    } else if (connectionPlan === "clear-secret") {
      // The one field this fixture added was the placeholder key. That is the one
      // thing asserted. The non-secret fields are deliberately NOT compared — the
      // restore carried whatever they now hold forward rather than overwriting
      // them, so a snapshot comparison here would fail precisely when the restore
      // did the right thing.
      if (after.keyStored !== snapshot.openAIKeyWasStored) {
        mismatches.push(
          `openai_connection stored key presence: expected ${snapshot.openAIKeyWasStored}, ` +
            `read ${after.keyStored} (the placeholder key this fixture wrote was not dropped)`,
        );
      }
    }
    if (mcpPlan === "restore") {
      if (afterMcp.publicBaseUrl !== snapshot.mcpPublicBaseUrl) {
        mismatches.push(
          `mcp publicBaseUrl: expected ${snapshot.mcpPublicBaseUrl ?? "unset"}, ` +
            `read ${afterMcp.publicBaseUrl ?? "unset"}`,
        );
      }
      if (afterMcp.publicBaseUrlSource !== snapshot.mcpPublicBaseUrlSource) {
        mismatches.push(
          `mcp publicBaseUrlSource: expected ${snapshot.mcpPublicBaseUrlSource}, ` +
            `read ${afterMcp.publicBaseUrlSource}`,
        );
      }
    }
    // A row this fixture removed must be GONE. A row it left alone gets no claim at
    // all: this teardown neither created nor removed it, and asserting a value for
    // somebody else's row would red on their concurrent write rather than on
    // anything this suite did.
    const assignedNow = afterAssigned.some((row) => row.skillId === HELD_TURN_SKILL_ID);
    if (removeAssignment && assignedNow) {
      mismatches.push(
        `agent_assigned_skills for ${HELD_TURN_AGENT_PACKAGE}: ${HELD_TURN_SKILL_ID} is still ` +
          "assigned although this fixture created it",
      );
    }
    if (mismatches.length > 0) {
      throw new Error(
        `fixtures: the instance was NOT restored to the state the suite found it in — ` +
          mismatches.join("; "),
      );
    }

    console.log(
      `[fixture] restored: openai_connection=${
        snapshot.openAIConnectionWritten
          ? connectionPlan === "delete-row"
            ? "row removed"
            : connectionPlan === "clear-secret"
              ? "placeholder key cleared"
              : "not this fixture's any more, left untouched"
          : "never changed"
      }, mcp=${
        snapshot.mcpWritten
          ? mcpPlan === "restore"
            ? "put back"
            : "changed during the run, left untouched"
          : "never changed"
      }, assignment=${
        removeAssignment
          ? "removed"
          : fixtureOwnsAssignment
            ? "not this fixture's any more, kept"
            : "not this fixture's, kept"
      }`,
    );
    rmSync(SNAPSHOT_PATH, { force: true });
    console.log("restore verified");
  }
}
