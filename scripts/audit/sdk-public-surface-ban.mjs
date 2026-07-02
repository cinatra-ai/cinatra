#!/usr/bin/env node
// SDK public-surface ban — the @cinatra-ai/sdk-extensions host-bus FENCE
// (SDK-P2 — the types-first SDK publish boundary).
//
// THE RULE — the public author root (packages/sdk-extensions/src/index.ts) is
// types-first. It must NOT re-export any host service-bus ADDRESSING CONSTANT
// (the `@cinatra-ai/host:*` capability ids the host registers per-concern
// service impls under). Those are host-internal and live ONLY behind the
// host-only `./internal` subpath (packages/sdk-extensions/src/internal.ts).
// An extension types a capability `impl` resolved from `ctx.capabilities`
// against the public `Host*Service` / provider TYPES and inlines the
// capability-id string literal — it never value-imports the constant.
//
// This is the STATIC source-text gate: it parses the `export { … }` (VALUE)
// re-export statements in src/index.ts and FAILS (exit 1) if any names a
// capability-id constant. `export type { … }` blocks are ignored (the
// Host*Service / provider TYPES are legitimate public surface). The companion
// runtime gate (packages/sdk-extensions/src/__tests__/public-surface.test.ts)
// proves the same fence by import-reachability.
//
// Caught (any VALUE export of one of these identifiers from index.ts):
//   - the named 20 fenced constants (HOST_CONNECTOR_SERVICE_CAPABILITIES,
//     NANGO_SYSTEM_CAPABILITY, …), AND
//   - ANY future identifier matching /_CAPABILITY$/ /_CAPABILITY_ID$/ —
//     fail-closed so a new host capability id can't silently leak.
//
// Usage:    node scripts/audit/sdk-public-surface-ban.mjs
// Exit:     0 clean (no capability-id VALUE export on the public root)
//           1 leak (offending export(s) printed)
//           2 internal error (cannot read the entrypoint)
//
// Unit tests: scripts/audit/__tests__/sdk-public-surface-ban.test.mjs

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export const INDEX_REL = "packages/sdk-extensions/src/index.ts";

// The known host-internal capability-id constants (the fence's explicit
// contract). Listed so the gate names them precisely when one leaks back. Any
// FUTURE id is also caught fail-closed by CAPABILITY_IDENT_RE below — this list
// is for precise messaging, not the detection set.
export const FENCED_CONSTANTS = Object.freeze([
  "HOST_CONNECTOR_SERVICE_CAPABILITIES",
  "NANGO_CONNECTION_SAVED_CAPABILITY",
  "NANGO_CONNECTION_MATERIALIZER_CAPABILITY",
  "LLM_TOOLBOX_CAPABILITY",
  "SOCIAL_POST_CAPABILITY",
  "CRM_PROVIDER_CAPABILITY",
  "PM_PROVIDER_CAPABILITY",
  "EMAIL_SEND_CAPABILITY",
  "OBJECT_TYPE_REGISTRAR_CAPABILITY",
  "CRM_SYNC_BOOTSTRAP_CAPABILITY",
  "CRM_POINTER_WRITER_CAPABILITY",
  "DEV_TUNNEL_STATUS_CAPABILITY",
  "BLOG_SYSTEM_CAPABILITY",
  "SOCIAL_MEDIA_SYSTEM_CAPABILITY",
  "EMAIL_SYSTEM_CAPABILITY",
  "LLM_PROVIDER_SURFACE_CAPABILITY",
  "CHAT_USER_CONTEXT_CAPABILITY_ID",
  "CRM_LIST_READER_CAPABILITY_ID",
  "EMAIL_SENDER_IDENTITIES_CAPABILITY_ID",
  "APPOINTMENT_SCHEDULES_CAPABILITY_ID",
  "NANGO_SYSTEM_CAPABILITY",
]);

// A capability-id constant follows one of these shapes — fail-closed for any
// FUTURE id, not just the named 20.
const CAPABILITY_IDENT_RE =
  /(?:_CAPABILITY|_CAPABILITY_ID)$|^HOST_CONNECTOR_SERVICE_CAPABILITIES$/;

// The host-bus capability-id CONSTANTS are physically defined in these per-concern
// contract modules. A `export *` / `export * as ns` re-export from ANY of them on
// the public root would re-expose every fenced constant (flat or under a namespace
// object) — invisible to a name-only matcher. The fence treats a star re-export
// from one of these modules as a LEAK regardless of the named ids it carries.
export const HOST_BUS_CONTRACT_MODULES = Object.freeze([
  "host-connector-services-contract",
  "chat-user-context-contract",
  "crm-list-reader-contract",
  "email-sender-identities-contract",
  "appointment-schedules-contract",
  "nango-system-contract",
]);

// Extract the set of identifiers exported as VALUES from `source`:
//   - `export { A, B as C } from "…";`   → A, C
//   - `export const X` / `export function X` / `export class X` → X
// Deliberately EXCLUDES `export type { … }` and `export type X = …` (TYPE-only
// — the public Host*Service / provider shapes that extensions legitimately use).
//
// The `export { … }` matcher uses a negative-lookbehind-free guard: it skips a
// block whose `export` keyword is immediately followed by `type` (i.e.
// `export type {`). Members written as `type Foo` INSIDE a value block (mixed
// `export { value, type Foo }` — not used in index.ts but tolerated) are
// dropped as type-only members.
export function valueExports(source) {
  const names = new Set();

  // export { ... } [from "..."]; — capture brace body, skip `export type {`.
  const braceRe = /export(\s+type)?\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = braceRe.exec(source)) !== null) {
    if (m[1]) continue; // `export type { … }` — entirely type-only
    const body = m[2];
    for (const raw of body.split(",")) {
      const member = raw.trim();
      if (!member) continue;
      if (/^type\s+/.test(member)) continue; // inline `type X` member → type-only
      // `A as B` re-export → the EXPORTED name is B; the SOURCE name is A.
      // A leak is the EXPORTED identifier, but we flag if EITHER matches a
      // capability shape (an alias can't launder a host constant onto the root).
      const parts = member.split(/\s+as\s+/).map((s) => s.trim());
      for (const p of parts) if (p) names.add(p);
    }
  }

  // export const|function|class|let|var NAME
  const declRe =
    /export\s+(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(source)) !== null) names.add(m[1]);

  return names;
}

// `export * from "./m";` and `export * as ns from "./m";` — these re-export a
// module's ENTIRE value surface (flat, or under a namespace object), which a
// name-only matcher cannot see into. Returns the list of module specifiers a
// star re-export targets, paired with the namespace alias (or null for bare `*`).
export function starReexports(source) {
  const out = [];
  // export * [as Ns] from "spec";
  const re = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ alias: m[1] ?? null, spec: m[2] });
  }
  return out;
}

// A star re-export is a LEAK when its target module is a host-bus contract module
// (it would re-expose the fenced constants). Match on the trailing module name so
// "./nango-system-contract" / "../x/nango-system-contract" both resolve.
function isHostBusContractSpec(spec) {
  const base = spec.replace(/\.[mc]?[jt]sx?$/, "").split("/").pop();
  return HOST_BUS_CONTRACT_MODULES.includes(base);
}

// Wrapper/launder aliases: `export const X = SOME_FENCED_CONSTANT` (or `let|var`),
// re-publishing a fenced constant's VALUE under a fence-evading name. We catch the
// case where a value declaration's initializer is exactly (or starts with) a
// reference to one of the named fenced constants. Conservative: only the explicit
// FENCED_CONSTANTS identifiers, so legitimate code referencing unrelated values is
// untouched.
export function wrapperAliasLeaks(source) {
  const leaks = [];
  const fenced = new Set(FENCED_CONSTANTS);
  // export const|let|var NAME = <init...>;
  const re = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const init = m[2];
    // identifiers referenced in the initializer
    for (const idMatch of init.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const id = idMatch[0];
      if (fenced.has(id) || CAPABILITY_IDENT_RE.test(id)) {
        leaks.push(`${m[1]} = …${id}… (wrapper/launder of a fenced constant)`);
        break;
      }
    }
  }
  return leaks;
}

export function findLeaks(source) {
  const leaks = [];
  // 1. Direct VALUE re-exports / declarations of a capability id.
  for (const name of valueExports(source)) {
    if (CAPABILITY_IDENT_RE.test(name)) leaks.push(name);
  }
  // 2. Star / namespace re-exports from a host-bus contract module — these
  //    re-expose every fenced constant past a name-only matcher.
  for (const { alias, spec } of starReexports(source)) {
    if (isHostBusContractSpec(spec)) {
      leaks.push(
        `export *${alias ? ` as ${alias}` : ""} from "${spec}" (star re-export of host-bus contract module)`,
      );
    }
  }
  // 3. Wrapper/launder aliases of a fenced constant's value.
  leaks.push(...wrapperAliasLeaks(source));
  return leaks.sort();
}

export function runGate(repoRoot) {
  let source;
  try {
    source = readFileSync(resolve(repoRoot, INDEX_REL), "utf8");
  } catch (e) {
    return { ok: false, fatal: true, errors: [`cannot read ${INDEX_REL} — ${e.message}`] };
  }
  const leaks = findLeaks(source);
  return { ok: leaks.length === 0, leaks };
}

function main() {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const { ok, fatal, errors, leaks } = runGate(repoRoot);
  if (fatal) {
    console.error("[sdk-public-surface-ban] fatal:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(2);
  }
  if (ok) {
    console.log(
      `[sdk-public-surface-ban] PASS — ${INDEX_REL} re-exports NO host capability-id constant as a value (the host bus addressing scheme stays behind ./internal).`,
    );
    process.exit(0);
  }
  console.error("[sdk-public-surface-ban] FAIL — host capability-id constant(s) leaked onto the public author root:");
  for (const name of leaks) console.error(`  - ${name}`);
  console.error(
    `\nThese are host service-bus addressing constants. The public root (${INDEX_REL})\n` +
      `must stay types-first:\n` +
      `  - a direct VALUE re-export of a capability id → move it to src/internal.ts\n` +
      `    (host imports it via "@cinatra-ai/sdk-extensions/internal"); keep only the\n` +
      `    corresponding \`export type { … }\` on the public root.\n` +
      `  - a \`export *\` / \`export * as ns\` from a host-bus contract module → remove it;\n` +
      `    the root uses explicit named \`export type { … }\` (no star) by convention.\n` +
      `  - a wrapper alias (\`export const X = SOME_*_CAPABILITY\`) → delete it; do not\n` +
      `    re-publish a fenced constant's value under another name.\n`,
  );
  process.exit(1);
}

const isDirect =
  process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isDirect) {
  try {
    main();
  } catch (e) {
    console.error("[sdk-public-surface-ban] fatal:", e);
    process.exit(2);
  }
}
