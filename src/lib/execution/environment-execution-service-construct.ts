import "server-only";

// A2 execution-environment service — the boot-only concrete CONSTRUCTION
// (exec-plane S3, cinatra#1708). Separated from the pure composition core
// (`environment-execution-service.ts`) because it imports the execution-plane
// VALUES (EnvironmentLayerCache / TrustedEnvironmentBuilder / resolveL0ImageRef)
// + the durable pg store — the heavy graph that must never load at the hot
// route's module scope or in app-unit-test env. The boot phase imports this
// ONLY in the `ready` branch.

import {
  EnvironmentLayerCache,
  resolveL0ImageRef,
  TrustedEnvironmentBuilder,
  type EnvironmentPlatform,
} from "@cinatra-ai/execution-plane";
import {
  buildReadyExecutionEnvironmentSlot,
  type ExecutionEnvironmentReadiness,
} from "@/lib/execution/environment-execution-service";
import { createDurableEnvironmentLayerStore } from "@/lib/execution/environment-layer-store.pg";
import type { ExecutionEnvironmentServiceSlot } from "@/lib/execution/register-execution-environment-service";

/**
 * Construct the real `ready` singletons from a resolved-ready readiness (the
 * boot path). The durable store + cache + builder are constructed here; the
 * executor comes from the registered S1 factory.
 */
export function constructReadyExecutionEnvironmentSlot(
  ready: Extract<ExecutionEnvironmentReadiness, { state: "ready" }>,
  env: Record<string, string | undefined> = process.env,
): ExecutionEnvironmentServiceSlot {
  const store = createDurableEnvironmentLayerStore();
  const cache = new EnvironmentLayerCache({
    store,
    provenanceKey: ready.provenanceKey,
    sharePrivateLayers: env.EXECUTION_ENVIRONMENT_SHARE_PRIVATE_LAYERS === "1",
  });
  const platform: EnvironmentPlatform = {
    os: "linux",
    arch: process.arch === "x64" ? "amd64" : "arm64",
  };
  const builder = new TrustedEnvironmentBuilder({
    cache,
    provenanceKey: ready.provenanceKey,
    l0ImageRef: resolveL0ImageRef(env.CINATRA_SANDBOX_L0_IMAGE),
    platform,
    allowInsecureLocalDevNetwork:
      env.EXECUTION_ENVIRONMENT_ALLOW_INSECURE_LOCAL_DEV_NETWORK === "1",
  });
  return buildReadyExecutionEnvironmentSlot({
    cache,
    store,
    builder,
    executor: ready.executorFactory(),
  });
}
