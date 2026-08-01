/**
 * cinatra#1705 — AC1 / AC2 / AC3 live-provider proof lane.
 *
 * Every layer under test is the SHIPPED one, wired the way boot wires it:
 *   - the broker, worker, hardened L0 profile, attributing egress gateway and
 *     the per-command Ed25519 voucher boundary come up through the PRODUCTION
 *     constructor `constructLocalDevExecutionBroker` (src/lib/execution);
 *   - its audit sink is the production `toAuthzAuditEventInput -> logAuditEvent`
 *     pair, so every row asserted below is a REAL row in a REAL Postgres
 *     `cinatra.audit_events` table (resource_type `execution_sandbox`);
 *   - the turn goes through the REAL orchestration entry point
 *     `generate()` in packages/llm, so the REAL `injectExecutionCapability`
 *     composes the tool + cue;
 *   - the provider adapter is the connector's own `createOpenAIProviderAdapter`
 *     / `createAnthropicProviderAdapter`, resolved through the REAL
 *     `llm-provider-adapter` capability surface;
 *   - the provider call is a REAL HTTPS call to api.openai.com /
 *     api.anthropic.com.
 *
 * DOCUMENTED DEVIATION (the only one): the API key is handed to the connector's
 * adapter factory directly from the process environment instead of being
 * resolved through Nango, because this lane runs no Nango instance. Everything
 * downstream of the factory is untouched production code.
 *
 * Nothing here executes a sandbox command on the model's behalf. The model
 * either calls the capability or it does not; a refusal is recorded as a
 * refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import * as path from "node:path";
import { Pool } from "pg";

import { createLocalSkillShellTool, generate } from "@cinatra-ai/llm";
import type { LlmTool } from "@cinatra-ai/llm";
import { mintExecutionSession } from "@cinatra-ai/llm/execution-plane";
import {
  constructLocalDevExecutionBroker,
  type ConstructedExecutionBroker,
} from "@/lib/execution/execution-broker-construct";
import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";
import { createOpenAIProviderAdapter } from "@cinatra-ai/openai-connector/adapter";
import { createAnthropicProviderAdapter } from "@cinatra-ai/anthropic-connector/adapter";
import { registerOpenAIConnector } from "@cinatra-ai/openai-connector/deps";
import { registerAnthropicConnector } from "@cinatra-ai/anthropic-connector/deps";

/** One id for one invocation of this file — stamped into every artifact. */
const RUN_ID = `ac123-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const EVIDENCE_DIR = path.resolve(__dirname, "..");
const RAW_DIR = path.join(EVIDENCE_DIR, "raw");
const OPENAI_LOG_DIR = path.join(process.cwd(), "data", "logs", "openai-api");
const ANTHROPIC_LOG_DIR = path.join(process.cwd(), "data", "logs", "anthropic-api");
const WIRE_DIRS = [OPENAI_LOG_DIR, ANTHROPIC_LOG_DIR];

const ORG_ID = process.env.AC123_ORG_ID ?? "";
const USER_ID = process.env.AC123_USER_ID ?? "";
const OPENAI_KEY = process.env.AC123_OPENAI_KEY ?? "";
const ANTHROPIC_KEY = process.env.AC123_ANTHROPIC_KEY ?? "";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";

/** Shell-CAPABLE OpenAI model (not in OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS). */
const OPENAI_SHELL_MODEL = process.env.AC123_OPENAI_SHELL_MODEL ?? "gpt-5.4";
/** Shell-INCOMPATIBLE OpenAI model — forces the sandbox_execute function fallback. */
const OPENAI_FN_MODEL = process.env.AC123_OPENAI_FN_MODEL ?? "gpt-5-mini";
const ANTHROPIC_MODEL = process.env.AC123_ANTHROPIC_MODEL ?? "claude-sonnet-5";

let plane: ConstructedExecutionBroker;
let pool: Pool;

// ---------------------------------------------------------------------------
// The scenario every arm runs — one task that cannot be answered without
// (a) writing + running a script, (b) installing a package absent from L0
// through the gateway and USING it in a LATER command, (c) reading back a file
// an earlier command wrote.
// ---------------------------------------------------------------------------

/** The generator program, byte-identical in the prompt and in the off-stack check. */
const GEN_PY = [
  "import hashlib",
  's = "".join(str(i*i*i) for i in range(4000))',
  'open("/workspace/data.txt","w").write(s)',
  'print("WROTE", len(s))',
].join("\n");

/** Off-stack recomputation of the three reported values — no sandbox, no app. */
function offStackExpectation(marker: string): { len: number; b58: string; marker: string } {
  let s = "";
  for (let i = 0; i < 4000; i += 1) s += String(i * i * i);
  const digest = createHash("sha256").update(s, "utf8").digest();
  return { len: s.length, b58: base58(digest), marker };
}

/** base58 (bitcoin alphabet) — the same encoding the sandbox's `base58` package emits. */
function base58(buf: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of buf) {
    if (byte === 0) out += ALPHABET[0];
    else break;
  }
  for (let k = digits.length - 1; k >= 0; k -= 1) out += ALPHABET[digits[k]];
  return out;
}

function scenarioPrompt(marker: string): string {
  return [
    "You have a sandbox tool. Use it. Do not answer from reasoning: the values below",
    "are not derivable without running the code, and a guessed answer is a wrong answer.",
    "",
    "Run these FOUR commands, in this order, in the SAME sandbox session so the",
    "workspace and the installed package persist between them.",
    "",
    "IMPORTANT: issue each of the four as its OWN separate command — a separate entry",
    "in the commands array. Do NOT join them with newlines or `&&` into a single",
    "command entry. You may still send them in one tool call.",
    "",
    "1) Write this exact program to /workspace/gen.py (use a heredoc so it is written verbatim):",
    "",
    GEN_PY,
    "",
    "2) Run it:  python3 /workspace/gen.py",
    "",
    "3) Install a package that is NOT present in the base image:",
    "   pip install --user --quiet base58",
    "",
    "4) Finally run this command, which READS BACK the file step 2 wrote and USES the",
    "   package step 3 installed:",
    "",
    `   python3 -c "import base58,hashlib; d=open('/workspace/data.txt').read(); print('${marker}'); print(len(d)); print(base58.b58encode(hashlib.sha256(d.encode()).digest()).decode())"`,
    "",
    "Then reply with the literal stdout of command 4 and nothing else — three lines:",
    `the marker ${marker}, the length, and the base58 string.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function registerAdapterSurface(providerId: "openai" | "anthropic", model: string) {
  const packageName =
    providerId === "openai" ? "@cinatra-ai/openai-connector" : "@cinatra-ai/anthropic-connector";
  registerCapabilityProvider("llm-provider-adapter", {
    packageName,
    impl: {
      abiVersion: 1,
      providerId,
      createAdapter: async () =>
        providerId === "openai"
          ? createOpenAIProviderAdapter({
              apiKey: OPENAI_KEY,
              defaultModel: model,
              loggingEnabled: true,
              promptCachingEnabled: false,
              availableModels: [],
            })
          : createAnthropicProviderAdapter({
              apiKey: ANTHROPIC_KEY,
              defaultModel: model,
            }),
    },
  });
}

type ArmResult = {
  answer: string;
  rows: Array<Record<string, unknown>>;
  rawRequestFiles: string[];
};

/** Rows this arm's session minted, newest last. */
async function readSandboxRows(orgId: string, since: Date) {
  const res = await pool.query(
    `SELECT id, organization_id, actor_principal_id, resource_type, operation, decision,
            run_id, metadata, created_at
       FROM cinatra.audit_events
      WHERE resource_type = 'execution_sandbox'
        AND organization_id = $1
        AND created_at >= $2
      ORDER BY created_at ASC`,
    [orgId, since],
  );
  return res.rows as Array<Record<string, unknown>>;
}

async function readVoucherRows(orgId: string, since: Date) {
  const res = await pool.query(
    `SELECT resource_type, operation, decision, created_at
       FROM cinatra.audit_events
      WHERE resource_type = 'execution_command_voucher'
        AND organization_id = $1
        AND created_at >= $2
      ORDER BY created_at ASC`,
    [orgId, since],
  );
  return res.rows as Array<Record<string, unknown>>;
}

async function runArm(input: {
  label: string;
  provider: "openai" | "anthropic";
  model: string;
  surface: "chat" | "agent_run" | "deterministic_task";
  marker: string;
  /** Recorded in the arm manifest so the wire form is evidence, not prose. */
  wireForm: string;
  extraTools?: LlmTool[];
}): Promise<ArmResult> {
  const orgId = `${ORG_ID}-${input.label}`;
  const since = new Date(Date.now() - 1000);
  registerAdapterSurface(input.provider, input.model);
  for (const d of WIRE_DIRS) if (existsSync(d)) rmSync(d, { recursive: true, force: true });

  const session = mintExecutionSession({
    orgId,
    userId: USER_ID,
    surface: input.surface,
  });

  const response = await generate({
    provider: input.provider,
    model: input.model,
    system:
      "You are a careful engineer with a real Linux sandbox. Always run code rather than predicting its output.",
    prompt: scenarioPrompt(input.marker),
    maxSteps: 14,
    tools: input.extraTools,
    executionSession: session,
    executionExecutor: plane.executor,
    actorContext: {
      kind: "user",
      id: USER_ID,
      organizationId: orgId,
      platformRole: "platform_admin",
      orgRole: "org_owner",
    } as never,
    logLabel: `ac123-${input.label}`,
  });

  // Let the fire-and-forget audit inserts land before reading them back.
  await new Promise((r) => setTimeout(r, 2500));

  const rows = await readSandboxRows(orgId, since);
  const rawRequestFiles: string[] = [];
  for (const d of WIRE_DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith("request.json")).sort()) {
      rawRequestFiles.push(f);
    }
  }

  const answer = typeof response.text === "string" ? response.text : JSON.stringify(response);

  // Persist the RAW turn, not a projection: the whole adapter response object
  // plus (OpenAI) the connector's own on-the-wire request/response captures.
  // Wiped first so the directory holds THIS arm's capture only.
  rmSync(path.join(RAW_DIR, input.label), { recursive: true, force: true });
  mkdirSync(path.join(RAW_DIR, input.label), { recursive: true });
  writeFileSync(
    path.join(RAW_DIR, input.label, "response.json"),
    JSON.stringify(response, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(RAW_DIR, input.label, "audit-rows.json"),
    JSON.stringify({ sandbox: rows, voucher: await readVoucherRows(orgId, since) }, null, 2),
    "utf8",
  );
  for (const d of WIRE_DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      writeFileSync(path.join(RAW_DIR, input.label, `wire-${f}`), readFileSync(path.join(d, f)));
    }
  }

  writeArmManifest({
    label: input.label,
    provider: input.provider,
    requestedModel: input.model,
    resolvedModel: (response as unknown as { model?: unknown }).model,
    surface: input.surface,
    wireForm: input.wireForm,
    outDir: path.join(RAW_DIR, input.label),
  });

  return { answer, rows, rawRequestFiles };
}

/**
 * Assert the three AC1 legs against the audit rows this arm minted.
 *
 * Strengthened after the Codex convergence round, which correctly found the
 * first version too weak: it accepted three rows for a four-command scenario,
 * never pinned `seq`, never required `exitCode === 0`, and only asked that
 * SOME row carry egress rather than the install one.
 */
function assertAc1Legs(rows: Array<Record<string, unknown>>, marker: string, answer: string) {
  const exp = offStackExpectation(marker);
  const md = (r: Record<string, unknown>) => r.metadata as Record<string, unknown>;

  // (0) FOUR commands were asked for, so four rows must exist — one per
  //     command, in order, each its own authorization decision.
  expect(rows.length, "one execution_sandbox row per scenario command").toBe(4);
  expect(rows.map((r) => md(r).seq), "rows are seq 0..3, in order").toEqual([0, 1, 2, 3]);

  // every row is an allowed, cleanly-exited command
  for (const r of rows) {
    expect(r.decision).toBe("allowed");
    expect(md(r).termination).toBe("exited");
    expect(md(r).exitCode, "every scenario command exits 0").toBe(0);
    expect(md(r).egressMode).toBe("default_internet");
  }

  // (b) THE INSTALL COMMAND is the one that drove bytes through the attributing
  //     gateway. `egressTotalBytes` is a job-CUMULATIVE snapshot the worker
  //     reads after each command, so the assertion is on the DELTA: zero before
  //     the install (seq 0,1), non-zero at the install (seq 2), and no further
  //     egress afterwards (seq 3 adds none).
  const egress = rows.map((r) => Number(md(r).egressTotalBytes ?? 0));
  expect(egress[0], "no egress before the install").toBe(0);
  expect(egress[1], "no egress before the install").toBe(0);
  expect(egress[2], "the install command drove real bytes through the gateway").toBeGreaterThan(0);
  expect(egress[3], "the read-back command adds no further egress").toBe(egress[2]);

  // the answer carries the off-stack-verified values (proves (a)+(b)+(c) jointly:
  // the digest is over a file an earlier command wrote, encoded by a package a
  // later command installed)
  expect(answer).toContain(marker);
  expect(answer).toContain(String(exp.len));
  expect(answer).toContain(exp.b58);
}

beforeAll(async () => {
  expect(DB_URL, "SUPABASE_DB_URL must point at the lane Postgres").not.toBe("");
  expect(ORG_ID).not.toBe("");
  expect(USER_ID).not.toBe("");

  // The connector's own logging path needs its host deps registered; this is
  // the connector's shipped DI seam. Only the two members the adapter's log
  // writer reads are exercised.
  registerOpenAIConnector({
    readOpenAIConnectionFromDatabase: () => ({ loggingEnabled: true }),
    isAppDevelopmentMode: () => true,
  } as never);
  // Anthropic's request logging is default-ENABLED; its deps slot only needs
  // the connector-config reader the logging authority consults.
  registerAnthropicConnector({
    readConnectorConfigFromDatabase: <T,>(_key: string, fallback: T) => fallback,
    isAppDevelopmentMode: () => true,
  } as never);

  pool = new Pool({ connectionString: DB_URL });

  // Docker must be present — this lane never skips (no stub-smoke).
  execFileSync("docker", ["info"], { stdio: "ignore" });
  execFileSync("docker", ["build", "-t", "cinatra-sandbox-l0:dev", "docker/sandbox"], {
    stdio: "inherit",
  });

  const built = await constructLocalDevExecutionBroker({
    settings: { mode: "local-dev", egressMode: "default_internet", egressAllowlist: [] } as never,
  });
  if (!built.ok) throw new Error(`execution plane did not come up: ${built.reason}`);
  plane = built.value;

  mkdirSync(RAW_DIR, { recursive: true });

  // NEGATIVE PROBE (Codex convergence): the AC says the installed package must
  // be "absent from L0". Prove that about the IMAGE rather than assuming it
  // from the Dockerfile — run `import base58` in a throwaway container of the
  // very image the arms run over, and record that it fails. Without this, an
  // image that happened to ship base58 would make the install-then-use leg
  // vacuous.
  const probe = execFileSync(
    "docker",
    [
      "run", "--rm", "--network", "none", "cinatra-sandbox-l0:dev",
      "bash", "-lc",
      "python3 -c 'import base58' 2>&1; echo EXIT=$?; pip list --disable-pip-version-check 2>/dev/null",
    ],
    { encoding: "utf8" },
  );
  expect(probe, "base58 must be ABSENT from the L0 image").toContain("ModuleNotFoundError");
  expect(probe).toContain("EXIT=1");
  writeFileSync(path.join(RAW_DIR, "l0-package-absence-probe.txt"), probe, "utf8");

  writeFileSync(
    path.join(RAW_DIR, "boot-handshake.json"),
    JSON.stringify(
      { runId: RUN_ID, handshake: plane.handshake, gateway: plane.gateway, models: {
        openaiShellCapable: OPENAI_SHELL_MODEL,
        openaiShellIncompatible: OPENAI_FN_MODEL,
        anthropic: ANTHROPIC_MODEL,
      } },
      null,
      2,
    ),
    "utf8",
  );
}, 900_000);

/**
 * Bind every artifact to ONE invocation (Codex convergence: "all six arms in a
 * single invocation" was asserted in prose but nothing established it). Each
 * arm writes a `manifest.json` carrying this run's id, the provider, the
 * resolved model id, the wire form, and a sha256 of every file the arm
 * produced. A reader can re-hash the directory and see the arms agree.
 */
function writeArmManifest(input: {
  label: string;
  provider: "openai" | "anthropic";
  requestedModel: string;
  resolvedModel: unknown;
  surface: string;
  wireForm: string;
  outDir: string;
}) {
  const files: Record<string, string> = {};
  for (const f of readdirSync(input.outDir).sort()) {
    if (f === "manifest.json") continue;
    files[f] = createHash("sha256")
      .update(readFileSync(path.join(input.outDir, f)))
      .digest("hex");
  }
  writeFileSync(
    path.join(input.outDir, "manifest.json"),
    JSON.stringify(
      {
        runId: RUN_ID,
        arm: input.label,
        provider: input.provider,
        requestedModel: input.requestedModel,
        resolvedModel: input.resolvedModel,
        surface: input.surface,
        wireForm: input.wireForm,
        sandboxImage: plane.handshake.imageDigest,
        capturedAt: new Date().toISOString(),
        sha256: files,
      },
      null,
      2,
    ),
    "utf8",
  );
}

afterAll(async () => {
  await plane?.stop().catch(() => {});
  await pool?.end().catch(() => {});
});

describe("AC1 — per-provider live turn: write+run, install-then-use, read-back", () => {
  it("anthropic: a real turn reaches the sandbox and completes all three legs", async () => {
    const marker = "AC1-ANTHROPIC";
    const arm = await runArm({
      label: "ac1-anthropic",
      provider: "anthropic",
      model: ANTHROPIC_MODEL,
      surface: "chat",
      wireForm: "sandbox_execute function tool",
      marker,
    });
    assertAc1Legs(arm.rows, marker, arm.answer);
  });

  it("openai NATIVE shell wire form: a shell-capable model drives the sandbox", async () => {
    const marker = "AC1-OPENAI-NATIVE";
    const arm = await runArm({
      label: "ac1-openai-native",
      provider: "openai",
      model: OPENAI_SHELL_MODEL,
      surface: "chat",
      wireForm: 'native type:"shell"',
      marker,
    });
    // The wire form itself, read off the connector's own request capture.
    const wire = readdirSync(path.join(RAW_DIR, "ac1-openai-native")).filter((f) =>
      f.endsWith("request.json"),
    );
    expect(wire.length).toBeGreaterThan(0);
    const body = JSON.parse(
      readFileSync(path.join(RAW_DIR, "ac1-openai-native", wire[0]), "utf8"),
    ) as { tools?: Array<{ type?: string }> };
    const shells = (body.tools ?? []).filter((t) => t.type === "shell");
    expect(shells.length).toBe(1);
    assertAc1Legs(arm.rows, marker, arm.answer);
  });

  it("openai FUNCTION fallback: a shell-incompatible model drives the sandbox", async () => {
    const marker = "AC1-OPENAI-FN";
    const arm = await runArm({
      label: "ac1-openai-fn",
      provider: "openai",
      model: OPENAI_FN_MODEL,
      surface: "chat",
      wireForm: "sandbox_execute function fallback",
      marker,
    });
    const wire = readdirSync(path.join(RAW_DIR, "ac1-openai-fn")).filter((f) =>
      f.endsWith("request.json"),
    );
    const body = JSON.parse(
      readFileSync(path.join(RAW_DIR, "ac1-openai-fn", wire[0]), "utf8"),
    ) as { tools?: Array<{ type?: string; name?: string }> };
    expect((body.tools ?? []).some((t) => t.type === "shell")).toBe(false);
    expect(
      (body.tools ?? []).some((t) => t.type === "function" && t.name === "sandbox_execute"),
    ).toBe(true);
    assertAc1Legs(arm.rows, marker, arm.answer);
  });
});

describe("AC2 — chat-surface install-then-use", () => {
  it("a chat-surface turn installs a non-L0 package and uses it in a later command", async () => {
    const marker = "AC2-CHAT";
    const arm = await runArm({
      label: "ac2-chat",
      provider: "anthropic",
      model: ANTHROPIC_MODEL,
      surface: "chat",
      wireForm: "sandbox_execute function tool",
      marker,
    });
    // Two surface=chat rows minimum, and non-zero gateway egress on the install.
    const chatRows = arm.rows.filter(
      (r) => (r.metadata as Record<string, unknown>).surface === "chat",
    );
    expect(chatRows.length).toBeGreaterThanOrEqual(2);
    expect(
      chatRows.some(
        (r) => Number((r.metadata as Record<string, unknown>).egressTotalBytes ?? 0) > 0,
      ),
    ).toBe(true);
    assertAc1Legs(arm.rows, marker, arm.answer);
  });
});

describe("AC3 — OpenAI skill-shell step against the real API", () => {
  // The skill is a REAL directory on disk, and the tool that carries it is
  // built by the PRODUCTION delivery-layer builder `createLocalSkillShellTool`
  // (packages/llm/src/tools/skills.ts) — the same function the chat/bridge
  // skill-delivery path calls. Nothing about the tool's shape is hand-written
  // here, so `environment.skills` on the wire is composed by shipped code
  // (`nativeShellSkillListing`, openai-adapter.ts:161) from a real staged
  // snapshot resolved by the real `resolveStagedSkillFiles` walker.
  const SKILL_SLUG = "ac3-lane-probe";
  const PASSPHRASE = "AC3-SKILL-PASSPHRASE-7719";
  const SKILL_BODY = [
    "---",
    "name: AC3 lane probe",
    "description: Lane probe skill carrying a pass phrase.",
    "---",
    "",
    "# AC3 lane probe",
    "",
    `The lane pass phrase is ${PASSPHRASE}.`,
    "",
  ].join("\n");

  let skillDir = "";

  function buildSkillDeliveryTool(): LlmTool {
    return createLocalSkillShellTool({
      mountedSkills: [
        {
          id: SKILL_SLUG,
          name: "AC3 lane probe",
          slug: SKILL_SLUG,
          description: "Lane probe skill carrying a pass phrase.",
          sourcePath: path.join(skillDir, "SKILL.md"),
          directoryPath: skillDir,
          source: null,
        },
      ],
    }) as unknown as LlmTool;
  }

  async function runSkillArm(input: {
    label: string;
    model: string;
    prompt: string;
  }): Promise<{
    response: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
    requestBody: {
      model?: string;
      tools?: Array<{
        type?: string;
        name?: string;
        environment?: { skills?: Array<{ name?: string; path?: string }> };
      }>;
    };
    outDir: string;
  }> {
    const orgId = `${ORG_ID}-${input.label}`;
    const since = new Date(Date.now() - 1000);
    registerAdapterSurface("openai", input.model);
    for (const d of WIRE_DIRS) if (existsSync(d)) rmSync(d, { recursive: true, force: true });

    const session = mintExecutionSession({ orgId, userId: USER_ID, surface: "chat" });
    const response = (await generate({
      provider: "openai",
      model: input.model,
      system:
        "You are a careful engineer with a real Linux sandbox and staged skill files. " +
        "Never guess the contents of a file — read it.",
      prompt: input.prompt,
      maxSteps: 8,
      tools: [buildSkillDeliveryTool()],
      executionSession: session,
      executionExecutor: plane.executor,
      actorContext: {
        kind: "user",
        id: USER_ID,
        organizationId: orgId,
        platformRole: "platform_admin",
        orgRole: "org_owner",
      } as never,
      logLabel: `ac123-${input.label}`,
    })) as unknown as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 2500));

    const rows = await readSandboxRows(orgId, since);
    const outDir = path.join(RAW_DIR, input.label);
    // Evidence integrity: this arm's directory holds THIS arm's capture only.
    // Without the wipe a re-run leaves the previous attempt's wire files behind
    // and the assertions below can read a stale request.
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "response.json"),
      JSON.stringify(response, null, 2),
      "utf8",
    );
    writeFileSync(
      path.join(outDir, "audit-rows.json"),
      JSON.stringify({ sandbox: rows, voucher: await readVoucherRows(orgId, since) }, null, 2),
      "utf8",
    );
    for (const d of WIRE_DIRS) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) {
        writeFileSync(path.join(outDir, `wire-${f}`), readFileSync(path.join(d, f)));
      }
    }

    const requests = readdirSync(outDir)
      .filter((f) => f.startsWith("wire-") && f.endsWith("request.json"))
      .sort();
    expect(requests.length, "the connector captured its own on-the-wire request").toBeGreaterThan(0);
    const requestBody = JSON.parse(readFileSync(path.join(outDir, requests[0]), "utf8"));
    return { response, rows, requestBody, outDir };
  }

  beforeAll(() => {
    // Inside the repo's real `data/skills` root, so the staged-file read runs
    // under the same containment verdict the production reader applies.
    skillDir = path.join(process.cwd(), "data", "skills", SKILL_SLUG);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf8");
  });

  it("shell-capable model: ONE native shell carries the skill, and the model reads /skills/<slug>/SKILL.md on the plane", async () => {
    const arm = await runSkillArm({
      label: "ac3-openai-skill-shell",
      model: OPENAI_SHELL_MODEL,
      prompt:
        `Read the file /skills/${SKILL_SLUG}/SKILL.md and reply with the pass phrase it ` +
        "contains, verbatim, and nothing else. Do not guess it — read the file.",
    });

    // 1. Exactly one native `type:"shell"` entry on the wire...
    const shells = (arm.requestBody.tools ?? []).filter((t) => t.type === "shell");
    expect(shells.length, "exactly one native shell entry").toBe(1);

    // 2. ...and its environment.skills listing names the attached skill at its
    //    staged path. (Composed by nativeShellSkillListing from the real staged
    //    snapshot — not written by this driver.)
    const listing = shells[0]?.environment?.skills ?? [];
    expect(listing.some((s) => s.name === SKILL_SLUG && s.path === `/skills/${SKILL_SLUG}`)).toBe(
      true,
    );

    // 3. No second shell surface and no skill_file_read degradation on a
    //    shell-capable, execution-authorized request.
    expect(
      (arm.requestBody.tools ?? []).some((t) => t.name === "skill_file_read"),
    ).toBe(false);

    // 4. The model issued a shell_call whose OWN action reads the staged path.
    //    Asserted on the parsed call object, not by string-matching the file
    //    (Codex convergence: a substring hit anywhere in the capture would not
    //    establish that the path belongs to that call).
    const shellCalls = readdirSync(arm.outDir)
      .filter((f) => f.startsWith("wire-") && f.endsWith("response.json"))
      .sort()
      .flatMap((f) => {
        const body = JSON.parse(readFileSync(path.join(arm.outDir, f), "utf8")) as {
          output?: Array<{ type?: string; status?: string; action?: { commands?: string[] } }>;
        };
        return (body.output ?? []).filter((o) => (o.type ?? "").startsWith("shell_call"));
      });
    expect(shellCalls.length, "the model issued a shell_call").toBeGreaterThanOrEqual(1);
    const readingCall = shellCalls.find((c) =>
      (c.action?.commands ?? []).some((cmd) => cmd.includes(`/skills/${SKILL_SLUG}/SKILL.md`)),
    );
    expect(readingCall, "a shell_call whose OWN action reads the staged SKILL.md").toBeDefined();
    expect(readingCall?.status).toBe("completed");

    // 5. A matching execution_sandbox row exists — the read ran ON THE PLANE.
    expect(arm.rows.length, "at least one execution_sandbox row").toBeGreaterThanOrEqual(1);
    for (const r of arm.rows) {
      expect(r.decision).toBe("allowed");
      expect((r.metadata as Record<string, unknown>).termination).toBe("exited");
    }

    // 6. And the model came back with the staged pass phrase — a string that
    //    appears nowhere in the prompt, the system message or any tool
    //    description, so the only route to it was reading the staged file.
    expect(String(arm.response.text ?? "")).toContain(PASSPHRASE);
    expect(JSON.stringify(arm.requestBody), "the passphrase is NOT in the request").not.toContain(
      PASSPHRASE,
    );

    writeArmManifest({
      label: "ac3-openai-skill-shell",
      provider: "openai",
      requestedModel: OPENAI_SHELL_MODEL,
      resolvedModel: arm.response.model,
      surface: "chat",
      wireForm: 'native type:"shell" with environment.skills',
      outDir: arm.outDir,
    });
  });

  it("shell-INCOMPATIBLE model: the same skill degrades to the restricted skill_file_read function tool", async () => {
    const arm = await runSkillArm({
      label: "ac3-openai-skill-degrade",
      model: OPENAI_FN_MODEL,
      prompt:
        `Read the file /skills/${SKILL_SLUG}/SKILL.md and reply with the pass phrase it ` +
        "contains, verbatim, and nothing else. Do not guess it — read the file.",
    });

    const tools = arm.requestBody.tools ?? [];
    // No native shell for a model that rejects it...
    expect(tools.some((t) => t.type === "shell")).toBe(false);
    // ...the skill surface is the RESTRICTED named function tool...
    expect(tools.some((t) => t.type === "function" && t.name === "skill_file_read")).toBe(true);
    // ...and execution stays available as its own named function tool.
    expect(tools.some((t) => t.type === "function" && t.name === "sandbox_execute")).toBe(true);

    // The model actually CALLED the restricted tool — asserted on the parsed
    // function_call, not merely on the answer text (Codex convergence).
    const fnCalls = readdirSync(arm.outDir)
      .filter((f) => f.startsWith("wire-") && f.endsWith("response.json"))
      .sort()
      .flatMap((f) => {
        const body = JSON.parse(readFileSync(path.join(arm.outDir, f), "utf8")) as {
          output?: Array<{ type?: string; name?: string; arguments?: string }>;
        };
        return (body.output ?? []).filter((o) => o.type === "function_call");
      });
    const skillRead = fnCalls.find((c) => c.name === "skill_file_read");
    expect(skillRead, "the model called skill_file_read").toBeDefined();
    expect(String(skillRead?.arguments ?? "")).toContain(`/skills/${SKILL_SLUG}/SKILL.md`);
    // No native shell was ever dispatched on this model.
    expect(fnCalls.some((c) => (c.type ?? "").startsWith("shell_call"))).toBe(false);

    // The degradation is a real, usable surface: the model got the pass phrase.
    expect(String(arm.response.text ?? "")).toContain(PASSPHRASE);

    writeArmManifest({
      label: "ac3-openai-skill-degrade",
      provider: "openai",
      requestedModel: OPENAI_FN_MODEL,
      resolvedModel: arm.response.model,
      surface: "chat",
      wireForm: "skill_file_read + sandbox_execute function tools (no native shell)",
      outDir: arm.outDir,
    });
  });
});
