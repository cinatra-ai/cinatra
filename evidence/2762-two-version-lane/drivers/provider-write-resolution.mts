// Which install row does the PROVIDER-WRITE seam target?
//
// `writeSetupProviderConnection` (src/lib/setup-provider-connection-writer.ts)
// resolves the row it writes a connection against by filtering the package's
// rows to the live ones, dropping organization rows superseded by a live
// workspace install, applying the SHARED source-precedence policy, and taking
// the first remaining default. This script runs that same selection over the
// rows the application actually holds, using the application's OWN policy
// function and its OWN canonical store — no reimplementation of the policy.
//
// It reports the row id, so it can be compared with the ids the setup and
// settings surfaces resolved in the browser. All three must be the same row.
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import { applyInstallRowPrecedence } from "@cinatra-ai/extensions/static-bundle-anchor";
import { isWorkspaceAnchoredRow } from "@cinatra-ai/extensions/canonical-types";

const PKG =
  process.argv[2] ?? "@cinatra-ai/google-appointment-schedules-connector";
const LIVE = new Set(["active", "locked"]);

const rows = await readInstalledExtensionsByPackageName(PKG);
console.log(`rows for ${PKG}:`);
for (const row of rows) {
  console.log(
    `  ${row.id}  version=${row.version}  status=${row.status}  isDefault=${row.isDefault}` +
      `  ownerLevel=${row.ownerLevel}  org=${row.organizationId ?? "(none)"}` +
      `  source=${(row.source as { type?: string } | null)?.type}`,
  );
}

// The writer's selection, in the writer's order.
const liveRows = rows.filter((row) => LIVE.has(row.status));
const effectiveRows = liveRows.some((row) =>
  isWorkspaceAnchoredRow({
    ownerLevel: row.ownerLevel ?? "",
    ownerId: row.ownerId ?? null,
    organizationId: row.organizationId ?? null,
  }),
)
  ? liveRows.filter((row) => (row.organizationId ?? null) === null)
  : liveRows;
const install = applyInstallRowPrecedence(effectiveRows).find(
  (row) => row.isDefault !== false,
);

console.log(`live rows: ${liveRows.length}`);
console.log(`after supersession: ${effectiveRows.length}`);
console.log(`after source precedence: ${applyInstallRowPrecedence(effectiveRows).length}`);
console.log(`PROVIDER-WRITE RESOLVED INSTALL ID: ${install?.id ?? "(none)"}`);
console.log(`PROVIDER-WRITE RESOLVED VERSION: ${install?.version ?? "(none)"}`);
