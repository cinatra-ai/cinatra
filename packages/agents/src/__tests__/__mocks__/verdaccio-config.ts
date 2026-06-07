// Sandbox stub for `@/lib/verdaccio-config`.
//
// The real host-app wrapper at `src/lib/verdaccio-config.ts` composes
// `loadVerdaccioConfigAsync` from `@cinatra-ai/registries` with the host-app's
// identity reader + decryptor. The vitest sandbox cannot resolve `@/lib/*`
// (no Next.js path mapping), so this stub mirrors the wrapper's behavior with
// no-op stubs for the identity reader and decryptor. Tests that exercise the
// publish-vendor-guard flow mock `loadVerdaccioConfigAsync` from
// `@cinatra-ai/registries`; this stub forwards through that mock so the wrapper
// path's mocking cascade works naturally.

import { loadVerdaccioConfigAsync } from "@cinatra-ai/registries";
import type { InstanceIdentitySnapshot } from "@cinatra-ai/registries";

const stubReadIdentity = (): InstanceIdentitySnapshot | null => null;
const stubDecryptToken = (_input: { ciphertext: string; iv: string }): string => "stub-token";

export async function loadVerdaccioConfigForServer() {
  return loadVerdaccioConfigAsync(stubReadIdentity, stubDecryptToken);
}
