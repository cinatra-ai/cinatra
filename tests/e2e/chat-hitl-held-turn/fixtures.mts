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
  /** The row's non-secret fields, or `null` when the row did not exist at all. */
  openAIConnection: NonSecretRow | null;
  /** Whether a key was already stored — the reason the row is left alone. */
  openAIKeyWasStored: boolean;
  /** Whether `apply` wrote the connection row (so `restore` must put it back). */
  openAIConnectionWritten: boolean;
  mcpPublicBaseUrl: string | null;
  mcpPublicBaseUrlSource: McpPublicBaseUrlSource;
  mcpWritten: boolean;
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

function readNonSecretConnection(): { fields: NonSecretRow | null; keyStored: boolean } {
  // RAW, never unsealed: this file has no business decrypting the operator's key,
  // and the snapshot has no business holding it.
  const raw = readRawOpenAIConnectionRow();
  if (!raw) return { fields: null, keyStored: false };
  const { apiKey, ...nonSecret } = raw;
  const keyStored =
    typeof apiKey === "string" ? apiKey.length > 0 : apiKey !== undefined && apiKey !== null;
  return { fields: nonSecret, keyStored };
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

/** Key-order-independent structural compare — a rewritten row need not be byte-equal. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return JSON.stringify(walk(value) ?? null);
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
    openAIConnection: before.fields,
    openAIKeyWasStored: before.keyStored,
    openAIConnectionWritten: !before.keyStored,
    mcpPublicBaseUrl: beforeMcp.publicBaseUrl,
    mcpPublicBaseUrlSource: beforeMcp.publicBaseUrlSource,
    mcpWritten,
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
    console.log("[fixture] openai_connection presence placeholder written (no real key)");
  }

  // (2) The MCP public base URL — an origin-only value on the connector-config row.
  if (mcpWritten) {
    setMcpPublicBaseUrl(BASE);
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
    console.log("[fixture] no snapshot — nothing was changed, nothing to restore");
    console.log("restore verified");
  }

  if (snapshot) {
    // (1) The connection row.
    if (snapshot.openAIConnectionWritten) {
      if (snapshot.openAIConnection === null) {
        // A factory-reset row is NOT the same state as no row: `readOpenAIConnection`
        // answers `null` for the second and a defaults object for the first, and the
        // instance this suite ran on had the second. So the row this fixture created
        // is removed, through the shipped metadata writer.
        deleteMetadataValueInternal(OPENAI_CONNECTION_METADATA_KEY);
      } else {
        // `clearSecret` drops the placeholder key this fixture wrote. It is only
        // ever reached when NO key was stored before, so nothing else can be lost.
        writeOpenAIConnection(asConnection(snapshot.openAIConnection), { clearSecret: true });
      }
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
    if (snapshot.mcpWritten) {
      const currentRow = readConnectorConfigFromDatabase<Record<string, unknown>>(
        MCP_CONNECTOR_ID,
        {},
      );
      const restoredSource =
        snapshot.mcpPublicBaseUrlSource === "tailscale-auto" ||
        snapshot.mcpPublicBaseUrlSource === "tailscale-funnel"
          ? { source: snapshot.mcpPublicBaseUrlSource }
          : undefined;
      writeConnectorConfigToDatabase(
        MCP_CONNECTOR_ID,
        buildMcpPublicBaseUrlRow(currentRow, snapshot.mcpPublicBaseUrl, restoredSource),
      );
    }

    // (3) The assignment, removed ONLY when this fixture is the reason it is there:
    //     it was absent before, AND the insert either created it or died inside the
    //     window where it may have. Every other state belongs to somebody else.
    const fixtureOwnsAssignment =
      !snapshot.assignedSkillExistedBefore &&
      (snapshot.assignedSkillInsert === "assigned" ||
        snapshot.assignedSkillInsert === "pending");
    if (fixtureOwnsAssignment) {
      const removed = await deleteAssignedSkill({
        agentPackageName: HELD_TURN_AGENT_PACKAGE,
        skillId: HELD_TURN_SKILL_ID,
      });
      console.log(`[fixture] assigned skill removed: ${removed.deleted}`);
    }

    // (4) READ IT BACK. A teardown that only calls the writers proves the calls
    //     were made, not that the instance is back where it started — which is the
    //     whole claim. Every mismatch is named.
    const after = readNonSecretConnection();
    const afterMcp = getMcpPublicBaseUrl();
    const afterAssigned = await readAssignedSkillsForAgentPackage(HELD_TURN_AGENT_PACKAGE);
    const mismatches: string[] = [];
    if (canonical(after.fields) !== canonical(snapshot.openAIConnection)) {
      mismatches.push(
        `openai_connection non-secret fields: expected ${JSON.stringify(snapshot.openAIConnection)}, ` +
          `read ${JSON.stringify(after.fields)}`,
      );
    }
    if (after.keyStored !== snapshot.openAIKeyWasStored) {
      mismatches.push(
        `openai_connection stored key presence: expected ${snapshot.openAIKeyWasStored}, ` +
          `read ${after.keyStored}`,
      );
    }
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
    // A row this fixture owns must be GONE. A row it does not own gets no claim at
    // all: this teardown neither created nor removed it, and asserting a value for
    // somebody else's row would red on their concurrent write rather than on
    // anything this suite did.
    const assignedNow = afterAssigned.some((row) => row.skillId === HELD_TURN_SKILL_ID);
    if (fixtureOwnsAssignment && assignedNow) {
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
        snapshot.openAIConnectionWritten ? "put back" : "never changed"
      }, mcp=${snapshot.mcpWritten ? "put back" : "never changed"}, assignment=${
        fixtureOwnsAssignment ? "removed" : "not this fixture's, kept"
      }`,
    );
    rmSync(SNAPSHOT_PATH, { force: true });
    console.log("restore verified");
  }
}
