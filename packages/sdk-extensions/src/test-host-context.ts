// Typed author-facing entry point for the local test harness host context.
//
// The IMPLEMENTATION is the dependency-free `./test-host-context.mjs` (plain JS,
// so it is ALSO consumable by the zero-dependency release-tooling validator /
// canary verifier, which run unauthenticated before the registry is reachable).
// This `.ts` re-export gives TypeScript authors the fully-typed surface (via the
// colocated `test-host-context.d.ts`). Keep `host-context.ts` type-only — the
// runtime harness lives HERE, not on the frozen ABI type surface.

export {
  createTestHostContext,
  summarizeRecorder,
  sanitizeAtom,
  bindTestProviderIdentity,
  isReservedHostProviderIdentity,
  TEST_HOST_PORT_NAMES,
  TEST_AMBIENT_PORTS,
  HOST_RESERVED_PROVIDER_NAMESPACE,
} from "./test-host-context.mjs";

export type {
  TestHostRecorder,
  CreateTestHostContextOptions,
  CreateTestHostContextResult,
} from "./test-host-context.mjs";
