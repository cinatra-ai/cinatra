import "server-only";

// Wire the host storage behind the SDK's generic connector-config accessor.
//
// Extension server actions call getExtensionConnectorConfig / setExtensionConnectorConfig
// from `@cinatra-ai/sdk-extensions` (a leaf contract) instead of importing
// `@/lib/database` directly — which would re-anchor the package to the host `src/`
// tree and break standalone extraction. This module supplies the ONE host
// implementation (the legacy global connector-config KV), bound ONCE — no
// per-connector host binding (mirrors register-extension-action-guard).
//
// Auto-registers on import; `src/instrumentation.node.ts` imports it at boot.

import { setExtensionConnectorConfigStore } from "@cinatra-ai/sdk-extensions";
import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
  deleteConnectorConfig,
} from "@/lib/database";

setExtensionConnectorConfigStore({
  get<T>(_packageId: string, key: string, fallback: T): T {
    return readConnectorConfigFromDatabase<T>(key, fallback);
  },
  set(_packageId: string, key: string, value: unknown): void {
    writeConnectorConfigToDatabase(key, value);
  },
  delete(_packageId: string, key: string): void {
    deleteConnectorConfig(key);
  },
});
