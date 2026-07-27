import "server-only";

// Boot-only CONSTRUCTION of the broker-backed execution executor (exec-plane
// S1b activation, cinatra#2138 deliverables 1 + 3 + 4; epic #1705).
//
// This is the app-integration #1706 deliberately deferred: the executor core,
// the broker, the local-dev worker, the hardened L0 profile and the attributing
// egress gateway are all MERGED — they simply had no caller. This module is
// that caller. It builds nothing the packages already own; it composes them and
// binds the three host-owned seams the packages left injectable:
//
//   * the AUDIT SINK          → the existing authz audit kernel
//     (`toAuthzAuditEventInput` → `logAuditEvent`), METADATA-only by
//     construction (deliverable 3);
//   * the RUN-LIVENESS PROBE  → the agent-run store, so a hard-removed run
//     fails the next command closed (the merged fail-closed contract);
//   * the EGRESS POLICY       → the instance settings, resolved onto the
//     attributing gateway the boot phase brings up (deliverable 4).
//
// Separated from the boot phase itself so the phase module stays free of the
// heavy `@cinatra-ai/execution-plane` graph (the phase list is imported by unit
// tests); the phase reaches this module only on the local-dev branch.

import * as path from "node:path";

import { readAgentRunById } from "@cinatra-ai/agents";
import {
  createBrokerSandboxExecutor,
  DEFAULT_SANDBOX_NETWORK,
  ExecutionBroker,
  LocalDevSandboxWorker,
  startLocalGateway,
  toAuthzAuditEventInput,
  type EgressPolicy,
  type ExecutionAuditRecord,
  type LocalGateway,
} from "@cinatra-ai/execution-plane";
import {
  mintExecutionSession,
  sealExecutionSession,
  type ExecutionSession,
} from "@cinatra-ai/llm/execution-plane";
import type { SandboxExecutor } from "@cinatra-ai/llm";

import { logAuditEvent } from "@/lib/authz/audit";
import type {
  ExecutionBrokerGatewayInfo,
  ExecutionBrokerHandshake,
  ExecutionBrokerLiveness,
} from "@/lib/execution/execution-broker-slot";
import type { ExecutionPlaneSettings } from "@/lib/execution/execution-plane-settings";

/**
 * Attribution the BOOT HANDSHAKE runs under. Deliberately a reserved,
 * non-tenant identity: the handshake is an instance self-check, not an org's
 * work, so it must never appear inside a tenant's audit scope.
 */
export const BOOT_HANDSHAKE_ORG_ID = "__execution_plane";
export const BOOT_HANDSHAKE_ACTOR_ID = "__boot_handshake";

/** The probe command. Trivial, no network, no writes — it proves the WORKER. */
const HANDSHAKE_COMMAND = "printf cinatra-exec-handshake";
const HANDSHAKE_EXPECTED_STDOUT = "cinatra-exec-handshake";

/**
 * Host path of the gateway script to bind-mount into the trusted gateway
 * container. Resolved from the repo root rather than `import.meta.url`: the app
 * consumes `@cinatra-ai/execution-plane` through a bundler, so the package's own
 * module URL points into the build output.
 */
function resolveGatewayScriptPath(): string {
  return path.join(
    process.cwd(),
    "packages",
    "execution-plane",
    "runtime",
    "egress-gateway.cjs",
  );
}

/** Project the instance settings onto the merged package's egress vocabulary. */
export function egressPolicyFromSettings(settings: ExecutionPlaneSettings): EgressPolicy {
  if (settings.egressMode === "none") return { mode: "none" };
  if (settings.egressMode === "allowlist") {
    return { mode: "allowlist", allowlist: [...settings.egressAllowlist] };
  }
  return { mode: "default_internet" };
}

/**
 * The audit sink (deliverable 3). Every broker command — executed, refused and
 * terminated alike — becomes ONE authz-kernel row.
 *
 * METADATA ONLY: the projection is the merged package's own
 * `toAuthzAuditEventInput`, which carries surface / cwd / refusal reason / exit
 * code / termination / image digest / egress TIER + byte total / wall time /
 * workspace size — and deliberately drops the executed command string and the
 * per-destination egress list. stdout/stderr never enter an audit record at all
 * (they ride the separate stdio sink). The kernel additionally strips its
 * sensitive-key blocklist on write, so this is defense in depth, not the only
 * guard.
 */
export function createExecutionAuditSink(): (record: ExecutionAuditRecord) => Promise<void> {
  return async (record: ExecutionAuditRecord): Promise<void> => {
    // logAuditEvent never throws by contract; the extra guard keeps a sink
    // failure from ever propagating into a model's tool loop.
    try {
      await logAuditEvent(toAuthzAuditEventInput(record));
    } catch {
      // Auditing is best-effort at the transport layer; the broker has already
      // enforced its decision before the sink runs.
    }
  };
}

/**
 * Run-liveness probe (the merged broker's per-command revalidation seam).
 * A session bound to a run resolves against the run store: a row that no longer
 * exists is `gone` (hard removal via force_delete / purge) and fails the NEXT
 * command closed. Sessions with no run binding (chat, deterministic tasks) have
 * no run row to consult and rely on carrier expiry — the contract's documented
 * `alive` answer. A store failure answers `alive` rather than killing live jobs
 * on a transient read error; the carrier TTL still bounds the exposure.
 */
export function createRunLivenessProbe(): (
  session: ExecutionSession,
) => Promise<"alive" | "archived" | "gone"> {
  return async (session) => {
    if (!session.runId) return "alive";
    try {
      const run = await readAgentRunById(session.runId);
      return run ? "alive" : "gone";
    } catch {
      return "alive";
    }
  };
}

export type ConstructedExecutionBroker = {
  broker: ExecutionBroker;
  executor: SandboxExecutor;
  handshake: ExecutionBrokerHandshake;
  gateway?: ExecutionBrokerGatewayInfo;
  probeLiveness: () => Promise<ExecutionBrokerLiveness>;
  stop: () => Promise<void>;
};

export type ConstructExecutionBrokerResult =
  | { ok: true; value: ConstructedExecutionBroker }
  | { ok: false; reason: string };

/**
 * Bring up the local-dev placement and prove it works.
 *
 * THE READINESS CONDITION (issue AC3), stated exactly: this function returns
 * `ok` — and therefore the boot phase registers an executor factory, and
 * therefore `resolveExecutionEnvironmentReadiness()` can report `ready` — ONLY
 * when a broker↔worker health handshake COMPLETED: a real job opened against a
 * freshly sealed session carrier, a real container ran the probe command over
 * the L0 image, and it returned exit code 0 with `termination: "exited"` and the
 * expected stdout. Any other outcome (docker absent, image missing, gateway
 * unreachable, non-zero exit, timeout) returns `ok:false`, nothing registers,
 * and every environment's readiness stays in the store's not-ready state — the
 * merged fail-closed refusal, unchanged.
 */
export async function constructLocalDevExecutionBroker(input: {
  settings: ExecutionPlaneSettings;
  env?: Record<string, string | undefined>;
}): Promise<ConstructExecutionBrokerResult> {
  const env = input.env ?? process.env;
  const policy = egressPolicyFromSettings(input.settings);
  const network = env.EXECUTION_SANDBOX_NETWORK?.trim() || DEFAULT_SANDBOX_NETWORK;

  const worker = new LocalDevSandboxWorker({
    ...(env.CINATRA_SANDBOX_L0_IMAGE ? { imageRef: env.CINATRA_SANDBOX_L0_IMAGE } : {}),
    ...(env.EXECUTION_ENVIRONMENT_PROVENANCE_KEY
      ? { provenanceKey: env.EXECUTION_ENVIRONMENT_PROVENANCE_KEY }
      : {}),
  });

  // Deliverable 4 — the remaining egress edge. Every gateway-requiring tier
  // needs the attributing gateway UP before the broker exists: the merged
  // `resolveEgress` refuses fail-closed rather than granting an unattributed
  // route, so a gateway that will not start must leave the plane unwired, not
  // silently network-free.
  let gateway: LocalGateway | null = null;
  if (policy.mode !== "none") {
    try {
      gateway = await startLocalGateway(policy, {
        internalNetwork: network,
        scriptPath: resolveGatewayScriptPath(),
        ...(env.CINATRA_SANDBOX_L0_IMAGE ? { imageRef: env.CINATRA_SANDBOX_L0_IMAGE } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        reason: `egress gateway did not start: ${(err as Error).message}`,
      };
    }
  }

  const broker = new ExecutionBroker({
    worker,
    auditSink: createExecutionAuditSink(),
    livenessProbe: createRunLivenessProbe(),
    egressPolicyResolver: () => policy,
    sandboxNetwork: network,
    ...(gateway ? { gateway: gateway.endpoint } : {}),
  });

  const handshake = await runBrokerHandshake(broker);
  if (!handshake.ok) {
    await gateway?.stop().catch(() => {});
    return { ok: false, reason: handshake.reason };
  }

  const executor = createBrokerSandboxExecutor(broker);

  return {
    ok: true,
    value: {
      broker,
      executor,
      handshake: handshake.value,
      ...(gateway
        ? {
            gateway: {
              containerName: gateway.containerName,
              proxyPort: gateway.endpoint.port,
              ...(gateway.endpoint.adminUrl ? { adminOrigin: gateway.endpoint.adminUrl } : {}),
            },
          }
        : {}),
      // The health surface asks "is the worker alive RIGHT NOW", not "did it
      // come up at boot" — so the live probe re-runs the SAME handshake.
      probeLiveness: async (): Promise<ExecutionBrokerLiveness> => {
        const result = await runBrokerHandshake(broker);
        return result.ok
          ? {
              ok: true,
              detail: `Handshake completed in ${result.value.wallMs} ms over image ${result.value.imageDigest}.`,
              atMs: result.value.completedAtMs,
            }
          : { ok: false, detail: result.reason, atMs: Date.now() };
      },
      stop: async () => {
        await gateway?.stop().catch(() => {});
      },
    },
  };
}

type HandshakeResult =
  | { ok: true; value: ExecutionBrokerHandshake }
  | { ok: false; reason: string };

/**
 * ONE broker↔worker health handshake: seal a fresh carrier, open a job, run the
 * probe command in a real container, close the job and remove its workspace.
 * Never throws — every failure mode becomes a precise `reason` string the boot
 * phase and the health surface can show an operator verbatim.
 */
export async function runBrokerHandshake(broker: ExecutionBroker): Promise<HandshakeResult> {
  let carrier: string;
  try {
    carrier = sealExecutionSession(
      mintExecutionSession({
        orgId: BOOT_HANDSHAKE_ORG_ID,
        userId: BOOT_HANDSHAKE_ACTOR_ID,
        surface: "deterministic_task",
      }),
    );
  } catch (err) {
    return { ok: false, reason: `cannot seal a handshake session: ${(err as Error).message}` };
  }

  let opened: Awaited<ReturnType<ExecutionBroker["openJob"]>>;
  try {
    opened = await broker.openJob(carrier);
  } catch (err) {
    return { ok: false, reason: `broker refused to open the handshake job: ${(err as Error).message}` };
  }
  if (!opened.ok) {
    return { ok: false, reason: `broker refused to open the handshake job (${opened.reason}): ${opened.message}` };
  }

  try {
    const executed = await broker.exec(opened.jobId, HANDSHAKE_COMMAND);
    if (!executed.ok) {
      return { ok: false, reason: `handshake command refused (${executed.reason}): ${executed.message}` };
    }
    const result = executed.result;
    if (result.termination !== "exited" || result.exitCode !== 0) {
      return {
        ok: false,
        reason: `handshake command did not complete on a live worker (termination=${result.termination}, exit=${String(result.exitCode)})`,
      };
    }
    if (result.stdout.trim() !== HANDSHAKE_EXPECTED_STDOUT) {
      return {
        ok: false,
        reason: "handshake command produced unexpected output — the worker is not running the expected sandbox",
      };
    }
    return {
      ok: true,
      value: {
        completedAtMs: Date.now(),
        imageDigest: result.imageDigest,
        wallMs: result.wallMs,
      },
    };
  } catch (err) {
    return { ok: false, reason: `handshake command threw: ${(err as Error).message}` };
  } finally {
    await broker.closeJob(opened.jobId, { removeWorkspace: true }).catch(() => {});
  }
}
