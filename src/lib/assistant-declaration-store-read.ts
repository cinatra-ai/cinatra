// Production-store-read validation of an agent's assistant DECLARATION
// (cinatra#1874, Epic #1873 W1) — the host-side consumer of the shared parser
// at the runtime store-read touchpoint.
//
// The pure `runtime-loader` (`@cinatra-ai/sdk-extensions/runtime-loader`)
// discovers a materialized `kind:"agent"` package and, when its sibling
// `cinatra/config.json` declares an `assistant` block, carries the RAW parsed
// config on the store record as `assistantConfigRaw` (it never imports zod, so
// it cannot validate). A present-but-unparseable config sets
// `invalidAssistantConfigDeclared`. THIS module is the host consumer that
// resolves + VALIDATES that raw declaration through the single shared parser —
// exactly mirroring how `connector-access-config-host.ts` parses the connector
// `accessConfig` raw pass-through. Fail-closed: a broken/unparseable declaration
// THROWS (never silently "no assistant"), so a torn on-disk package can never be
// adopted with a half-understood declaration.
//
// The live boot / adoption caller (the agent-adoption saga that upserts
// `agent_templates.assistant_config` + mints the principal) is the item-2
// install-choreography consumer; this validation seam is landed + unit-tested
// ahead of it, the same way the connector parse helpers preceded their callers.

import {
  parseAssistantDeclaration,
  type ResolvedAssistantDeclaration,
} from "@cinatra-ai/sdk-extensions/assistant-declaration";

/** The store-record fields this validator reads (structural subset of
 *  `PackageStoreRecord`, carried by the runtime loader for a `kind:"agent"`
 *  package that declares an assistant block). */
export type AssistantStoreRecordView = {
  packageName: string;
  assistantConfigRaw?: unknown;
  invalidAssistantConfigDeclared?: boolean;
};

export class AssistantStoreDeclarationError extends Error {
  constructor(message: string) {
    super(`[assistant-declaration-store-read] ${message}`);
    this.name = "AssistantStoreDeclarationError";
  }
}

/**
 * Resolve + validate the assistant declaration a materialized store record
 * carries. Returns:
 *   - `null` when the record declares no assistant (no `assistantConfigRaw`,
 *     no invalid marker) — the package is an ordinary agent, nothing to adopt;
 *   - the {@link ResolvedAssistantDeclaration} when a well-formed `assistant`
 *     block is present.
 * THROWS {@link AssistantStoreDeclarationError} fail-closed when the config was
 * PRESENT but unparseable (`invalidAssistantConfigDeclared`), and rethrows the
 * shared parser's `AssistantDeclarationError` when the block itself is malformed
 * — a broken declaration is never silently downgraded to "no assistant".
 */
export function resolveAssistantDeclarationFromStoreRecord(
  record: AssistantStoreRecordView,
): ResolvedAssistantDeclaration | null {
  if (record.invalidAssistantConfigDeclared) {
    throw new AssistantStoreDeclarationError(
      `${record.packageName} ships a cinatra/config.json that is not valid JSON — ` +
        `a present-but-unparseable declaration is refused (never treated as "no assistant")`,
    );
  }
  if (record.assistantConfigRaw === undefined) return null;
  // The shared parser THROWS on a malformed block (fail-closed) and returns
  // `null` only when the (valid) file carries no `assistant` block — but the
  // loader only sets `assistantConfigRaw` when a block IS present, so `null`
  // here would mean the raw config drifted from the loader's presence gate;
  // treat that as no declaration rather than fabricating one.
  return parseAssistantDeclaration(record.assistantConfigRaw, {
    packageName: record.packageName,
  });
}
