// -----------------------------------------------------------------------------
// LEG 2 — the CONNECTOR-SERVICE SECRET, without a browser.
//
// The Secrets screen posts to `saveNangoConnectionAction`, which (after the
// manage-permission gate) calls the connector's `saveNangoSettings` and then
// REDIRECTS. `saveNangoSettings` performs a read-modify-write of ONE
// instance-global connector-config row through the injected config store, and
// that store's `write` member IS the host's `writeConnectorConfigToDatabase`
// (bound in `registerHostConnectorServices`). So the at-rest codec, the row
// shape, and the preserve-on-blank merge below are the screen's own — reached
// in-process, with no redirect and no bound extension required.
//
// SEALING IS NOT REPEATED HERE. `secretKey` is a designated secret field, so
// `writeConnectorConfigToDatabase` seals it through `sealSecretFields`
// (AES-256-GCM under a field-scoped AAD) before anything is persisted. This
// module never encrypts, never decrypts, and never logs the value.
// -----------------------------------------------------------------------------

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";
import { assertDevelopmentRuntime } from "@/lib/dev-instance-provisioning/runtime-gate";

/** The connector-config row id the connector reads and writes. */
export const CONNECTOR_SERVICE_CONFIG_ID = "nango";

type ConnectorServiceSettings = {
  secretKey?: string;
  serverUrl?: string;
};

export type ProvisionConnectorServiceSecretInput = {
  /** Travels in memory from the caller. Blank keeps whatever is on file. */
  secretKey?: string;
  serverUrl?: string;
};

export type ProvisionConnectorServiceSecretOutcome = {
  written: boolean;
  /** Presence only — the value never leaves this call. */
  secretKeyOnFile: boolean;
  serverUrl: string | undefined;
};

export function provisionConnectorServiceSecret(
  input: ProvisionConnectorServiceSecretInput,
): ProvisionConnectorServiceSecretOutcome {
  assertDevelopmentRuntime("provisionConnectorServiceSecret");

  const stored = readConnectorConfigFromDatabase<ConnectorServiceSettings | null>(
    CONNECTOR_SERVICE_CONFIG_ID,
    null,
  );
  const current: ConnectorServiceSettings = stored ?? {};

  // The connector's own merge, verbatim: a blank field KEEPS the stored value.
  const next: ConnectorServiceSettings = {
    ...current,
    secretKey: input.secretKey?.trim() || current.secretKey,
    serverUrl: input.serverUrl?.trim() || current.serverUrl,
  };

  const unchanged =
    stored !== null &&
    next.secretKey === current.secretKey &&
    next.serverUrl === current.serverUrl;
  if (unchanged) {
    return {
      written: false,
      secretKeyOnFile: Boolean(current.secretKey),
      serverUrl: current.serverUrl,
    };
  }

  writeConnectorConfigToDatabase(CONNECTOR_SERVICE_CONFIG_ID, next);
  return {
    written: true,
    secretKeyOnFile: Boolean(next.secretKey),
    serverUrl: next.serverUrl,
  };
}
