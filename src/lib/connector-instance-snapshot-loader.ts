import "server-only";

// Per-server catalog snapshot loader (cinatra#2018 S3): the host
// `loadServerSnapshot` implementation behind the governed invoker, moved out
// of the boot binder (`register-host-connector-services.ts` only BINDS) so the
// exposure-mode dispatch is unit-testable with injected deps.
//
// Exposure-mode classification comes from the WIRE the invoker will actually
// speak, never from a payload's declared tool surface: the loader calls the
// wire `tools/list` once per load and inspects the returned tool names for the
// triad trio — present ⇒ `triad-only` (expand via discover → get-ability-info),
// absent ⇒ `first-class` (snapshot built from the SAME `tools/list` rows; one
// wire round-trip serves both classification and the snapshot). The verdict is
// written back to the enrollment row on first classification and RE-VERIFIED on
// every re-fetch; a flip updates the row, invalidates that server's cached
// snapshot and emits a `server_exposure_mode_changed` audit event — a
// classification flip is never a silent parser change.
//
// The grandfathered default server is PINNED `triad-only` at row creation and
// keeps the exact pre-S3 expansion path (no `tools/list` call, no
// classification write) — byte-identical wire behavior for existing installs.

import {
  TRIAD_DISCOVER_ABILITIES,
  TRIAD_EXECUTE_ABILITY,
  TRIAD_GET_ABILITY_INFO,
} from "@/lib/connector-instance-mcp-transport";
import {
  CATALOG_DEFAULT_SERVER_ID,
  buildFirstClassSnapshot,
  expandTriadCatalog,
  type CatalogExposureMode,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import { logAuditEvent } from "@/lib/authz/audit";

/** Classify a wire `tools/list` row set: a server exposing ALL THREE triad
 * wire tools is `triad-only`; anything else (including an empty tool set) is
 * `first-class`. Pure — also used by manual-route verification. */
export function classifyExposureModeFromWireTools(
  tools: ReadonlyArray<Record<string, unknown>>,
): CatalogExposureMode {
  const names = new Set<string>();
  for (const tool of tools) {
    if (typeof tool.name === "string") names.add(tool.name);
  }
  const triad = [TRIAD_DISCOVER_ABILITIES, TRIAD_GET_ABILITY_INFO, TRIAD_EXECUTE_ABILITY];
  return triad.every((name) => names.has(name)) ? "triad-only" : "first-class";
}

export type ConnectorInstanceSnapshotLoaderDeps = {
  /** Execute one wire tool (the S2 transport). Used for triad expansion. */
  callWireTool: (input: {
    endpoint: string;
    authHeader: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Wire `tools/list` (the S3 transport primitive). Classification source +
   * first-class snapshot rows. */
  listTools: (input: {
    endpoint: string;
    authHeader: string;
  }) => Promise<Array<Record<string, unknown>>>;
  /** Read the enrollment row's stored exposure mode (null = not yet classified). */
  readExposureMode: (
    connectorKey: string,
    instanceId: string,
    serverId: string,
  ) => Promise<CatalogExposureMode | null>;
  /** Write back the classified exposure mode onto the enrollment row. */
  recordExposureMode: (input: {
    connectorKey: string;
    instanceId: string;
    serverId: string;
    exposureMode: CatalogExposureMode;
  }) => Promise<void>;
  /** Evict the server's cached snapshot on a classification flip. */
  invalidateSnapshot: (instanceId: string, serverId: string) => void;
  /** Audit sink (defaults to the host audit log). */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
};

export type LoadConnectorInstanceServerSnapshot = (input: {
  connectorKey: string;
  instanceId: string;
  serverId: string;
  endpoint: string;
  authHeader: string;
}) => Promise<CatalogServerSnapshot>;

/**
 * Build the per-server snapshot loader the invoker deps bind. Every failure
 * (wire, store read/write) THROWS — the invoker's acquire loop owns the
 * serve-stale / omit / health-record fallout, this module owns only the
 * dispatch. Errors never carry the auth header (the transport classifies).
 */
export function createConnectorInstanceSnapshotLoader(
  deps: ConnectorInstanceSnapshotLoaderDeps,
): LoadConnectorInstanceServerSnapshot {
  const audit = deps.audit ?? ((event: Parameters<typeof logAuditEvent>[0]) => logAuditEvent(event));
  return async (input) => {
    const callWireTool = (name: string, args: Record<string, unknown>) =>
      deps.callWireTool({
        endpoint: input.endpoint,
        authHeader: input.authHeader,
        name,
        arguments: args,
      });

    // The grandfathered default server: pinned triad-only (no classification).
    if (input.serverId === CATALOG_DEFAULT_SERVER_ID) {
      return expandTriadCatalog({ serverId: input.serverId, callWireTool });
    }

    const rows = await deps.listTools({ endpoint: input.endpoint, authHeader: input.authHeader });
    const classified = classifyExposureModeFromWireTools(rows);
    const stored = await deps.readExposureMode(input.connectorKey, input.instanceId, input.serverId);
    if (stored !== classified) {
      await deps.recordExposureMode({
        connectorKey: input.connectorKey,
        instanceId: input.instanceId,
        serverId: input.serverId,
        exposureMode: classified,
      });
      if (stored !== null) {
        // A FLIP (not the first classification): the previous snapshot was
        // built under the other parser — evict it and leave an operator trail.
        deps.invalidateSnapshot(input.instanceId, input.serverId);
        await audit({
          resourceType: "connector_instance",
          resourceId: input.instanceId,
          actorPrincipalType: "system",
          authSource: "worker",
          operation: "server_exposure_mode_changed",
          decision: "allowed",
          policyVersion: "connector-instance-server-enrollment",
          metadata: {
            connectorKey: input.connectorKey,
            serverId: input.serverId,
            from: stored,
            to: classified,
          },
        });
      }
    }

    return classified === "triad-only"
      ? await expandTriadCatalog({ serverId: input.serverId, callWireTool })
      : buildFirstClassSnapshot({ serverId: input.serverId, tools: rows });
  };
}
