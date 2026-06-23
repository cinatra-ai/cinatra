#!/usr/bin/env node
// Build-time extension manifest generator (the GENERATED_MANIFEST_FILES set).
//
// Emits the StaticBundleLoader's input — the SAME normalized records the future
// RuntimePackageLoader will consume — split into files so server
// registrars never drag `server-only`/DB across the React "use client" boundary:
//   - src/lib/generated/extensions.server.ts          — server-side static manifest (data)
//   - src/lib/generated/connector-setup-pages.ts      — literal dynamic-import map (Turbopack-safe)
//   - src/lib/generated/extensions.client.tsx         — true client widgets (scaffold)
//   - src/lib/generated/widget-stream-public-paths.ts — widget-stream public path list
//   - src/lib/generated/__tests__/guarded-optional-loaders.test.ts
//                                                      — generated test pinning the
//                                                        per-entry resolution classification
//
// POSTURE — CONSUMED: the generated maps are the host's runtime source of
// truth for the connector surfaces. `src/lib/connector-setup-pages.ts` and
// `src/lib/connector-modules.server.ts` resolve setup/settings pages and
// connector entry modules from here; the StaticBundleLoader activates
// `serverEntry` extensions from here. The `extensions-dev-watcher` readdir
// boot scan remains the registration source for filesystem-loaded extension
// kinds (agents/skills/artifacts/workflows). Parity is checked against the
// connector catalog descriptors. `--check` is FAIL-CLOSED (cinatra#36):
// the generated tree is the coupling gates' one permanent-exempt class, so a
// generated file drifting from the generator's byte-exact output — or a
// catalog parity break — fails CI (exit 1). The emitted file set is the
// shared GENERATED_MANIFEST_FILES list (generated-manifest-files.mjs) — the
// SAME list the gates exempt, so generator and exemption cannot drift apart.
//
// Usage:
//   node scripts/extensions/generate-extension-manifest.mjs                # (re)write generated files
//   node scripts/extensions/generate-extension-manifest.mjs --check        # CANONICAL drift + parity check (exit 1 on either)
//   node scripts/extensions/generate-extension-manifest.mjs --check --self # NON-CANONICAL self-check (regenerated tree only)
//   node scripts/extensions/generate-extension-manifest.mjs --print        # print the manifest, write nothing
//
// `--check` MODES (cinatra#7): plain `--check` is the CANONICAL mode for
// the full clone-back CI tree — there the on-disk src/lib/generated/* IS the
// committed artifact, so the byte-exact comparison pins the committed maps
// (fail-closed, unchanged contract). `--check --self` is for NON-CANONICAL
// presence universes (fresh public clone after regeneration, the prod image
// build stage after lock acquisition): it verifies the regenerated on-disk
// tree against a fresh in-memory emission for THIS tree (self-consistency:
// catches partial regeneration / post-regen hand edits) plus catalog parity —
// and deliberately NEVER binds or mentions the committed tree, whose presence
// universe may legitimately differ.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInventory } from "./inventory.mjs";
import { GENERATED_MANIFEST_FILES } from "./generated-manifest-files.mjs";
import { CONNECTOR_DESCRIPTORS } from "../../packages/connectors-catalog/src/descriptors.mjs";
import {
  validateFieldRendererDeclarations,
  mergeFieldRendererBindings,
  mergeRoleDeclarations,
  ARTIFACT_DEFAULT_FLOOR_ROLE,
} from "./agent-binding-kinds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const GEN_DIR = join(REPO_ROOT, "src/lib/generated");

// anthropic-connector stays in-tree (owner directive) but is still a real
// loadable extension, so it remains in the manifest. The private vendor scope is in-tree.
const fileExists = (p) => existsSync(join(REPO_ROOT, p));

// Host-port names — a LITERAL MIRROR of HOST_PORT_NAMES in
// @cinatra-ai/sdk-extensions (host-context.ts). The TS table is canonical; this
// plain .mjs build script can't import the TS SDK, so it keeps a hand-maintained
// copy. The copy is GUARDED, not trusted: a vitest parity test
// (scripts/extensions/__tests__/host-port-tiers-parity.test.ts) imports this Set
// and asserts it exactly equals HOST_PORT_NAMES, so any drift fails CI. A
// manifest declaring an unknown requestedHostPort is flagged by checkParity() so
// typos are caught at generation, not silently treated as an ungranted (no-op) port.
export const VALID_HOST_PORTS = new Set([
  "db",
  "settings",
  "secrets",
  "nango",
  "authSession",
  "mcp",
  "objects",
  "jobs",
  "notifications",
  "ui",
  "logger",
  "runtime",
  "capabilities",
  "telemetry",
]);

// RESERVED-tier ports — a LITERAL MIRROR of RESERVED_HOST_PORTS in
// @cinatra-ai/sdk-extensions (host-context.ts: the ports whose HOST_PORT_TIER is
// "reserved"). The TS HOST_PORT_TIER table is canonical; this is the same
// guarded-parity mirror convention as VALID_HOST_PORTS above (the .mjs build
// script can't import the TS SDK). Drift is CAUGHT, not silent: the same vitest
// parity test (host-port-tiers-parity.test.ts) asserts this Set exactly equals
// the SDK's derived RESERVED_HOST_PORTS, so changing the TS tier table without
// updating this copy fails CI. A manifest declaring a reserved port in
// requestedHostPorts is WARNED (not failed) by checkParity(): the port exists in
// the frozen surface but is not wired, so accessing it fail-louds at runtime —
// pre-declaring it for a future wiring is tolerated (matches the existing
// granted-but-unwired tolerance), not build-blocked. Today: ["db"].
export const RESERVED_HOST_PORTS = new Set(["db"]);

// Read the `cinatra` manifest block of an extension for the loader fields
// (serverEntry / requestedHostPorts) the inventory doesn't surface.
function readCinatraManifest(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
    return pkg.cinatra ?? {};
  } catch {
    return {};
  }
}

// Resolve `cinatra.displayName` (trimmed, non-empty) or null.
export function resolveDisplayName(cin) {
  return typeof cin.displayName === "string" && cin.displayName.trim().length > 0
    ? cin.displayName.trim()
    : null;
}

// Resolve self-declared connector vendor identity (`cinatra.vendor`, #12) or
// null. Carried THROUGH unvalidated — the SDK/host own no vendor roster, so the
// only structural shaping here is "object with non-empty string key + name".
// Authoritative validation (shape conformance, name/key ownership + uniqueness,
// provider mapping) is the marketplace publish gate's job (separate repo).
export function resolveVendor(cin) {
  const v = cin.vendor;
  if (!v || typeof v !== "object") return null;
  const key = typeof v.key === "string" ? v.key.trim() : "";
  const name = typeof v.name === "string" ? v.name.trim() : "";
  if (key.length === 0 || name.length === 0) return null;
  return { key, name };
}

// PURE SVG sanitizer — given raw SVG text, return a bounded inline data URI
// or null. Defends the host card surface from a hostile/marketplace logo asset.
// A logo icon needs only a tiny shape/group/gradient vocabulary, so this FAILS
// CLOSED via an ALLOWLIST of element + attribute names (rather than a fragile
// denylist that namespace-prefixes / CSS-escapes can slip past): every tag and
// attribute name must be in the safe set, no namespaced (`ns:tag`) elements, no
// backslashes (CSS escapes), no entities (encoding bypass), no doctype/entity/
// CDATA, and only INTERNAL `url(#id)` references (e.g. a gradient).
export const MAX_LOGO_BYTES = 16 * 1024;
const ALLOWED_SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask",
  "symbol", "title", "desc", "metadata", "text", "tspan",
]);
const ALLOWED_SVG_ATTRS = new Set([
  "id", "class", "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "opacity", "clip-path", "clip-rule", "mask", "offset",
  "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod",
  "preserveaspectratio", "version", "color", "vector-effect", "shape-rendering",
  "color-interpolation", "color-interpolation-filters", "role", "aria-hidden",
  "aria-label", "focusable",
]);
export function sanitizeSvgToDataUri(svg) {
  if (typeof svg !== "string") return null;
  if (Buffer.byteLength(svg, "utf8") > MAX_LOGO_BYTES) return null;
  const s = svg.trim();
  // Bare SVG document (optional XML prolog) — nothing executable before the root.
  if (!/^(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(s)) return null;
  // Reject numeric + non-XML-predefined named entities (entity-encoding bypass),
  // backslashes (CSS hex escapes like `u\72l(`), and DTD/CDATA constructs.
  if (/&#/.test(s) || /&(?!(?:amp|lt|gt|quot|apos);)[a-z0-9]+;/i.test(s)) return null;
  if (/\\/.test(s)) return null;
  if (/<!doctype|<!entity|<!\[cdata/i.test(s)) return null;
  // Element allowlist — every (possibly-namespaced) tag name must be safe; a
  // namespace prefix (`ns:script`) is rejected outright.
  for (const m of s.matchAll(/<\s*\/?\s*([a-zA-Z_][\w.:-]*)/g)) {
    const tag = m[1].toLowerCase();
    if (tag.includes(":") || !ALLOWED_SVG_TAGS.has(tag)) return null;
  }
  // Attribute allowlist — every attribute name must be safe; xmlns / xmlns:* and
  // the xml: namespace are the only permitted namespaced attrs (declarations
  // only — no xlink:href / data refs).
  for (const m of s.matchAll(/[\s"'\/]([a-zA-Z_][\w.:-]*)\s*=/g)) {
    const attr = m[1].toLowerCase();
    if (attr === "xmlns" || attr.startsWith("xmlns:") || attr === "xml:space") continue;
    if (!ALLOWED_SVG_ATTRS.has(attr)) return null;
  }
  // Attribute VALUES must carry no external-reference vector. xmlns/xmlns:* alone
  // legitimately hold the SVG namespace URI; every other quoted attribute value
  // is rejected if it contains a scheme (`://`), an external `url()` (anything
  // but an internal `url(#id)`), or any CSS function that can fetch a resource
  // (image-set / cross-fade / image() / element() / paint() / src() / -webkit-*).
  for (const m of s.matchAll(/([a-zA-Z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1].toLowerCase();
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const value = m[2] ?? m[3] ?? "";
    if (/:\/\//.test(value)) return null;
    if (/url\(\s*['"]?\s*(?!#)/i.test(value)) return null;
    if (/(?:image-set|cross-fade|\bimage|\belement|\bpaint|\bsrc)\s*\(/i.test(value)) return null;
    if (/-webkit-/i.test(value)) return null;
  }
  // Belt-and-suspenders: no external url(...) anywhere (only internal url(#id)).
  if (/url\(\s*['"]?\s*(?!#)/i.test(s)) return null;
  return `data:image/svg+xml;base64,${Buffer.from(s, "utf8").toString("base64")}`;
}

// Read + sanitize `cinatra.logo` (a package-relative .svg) into a data URI,
// or null. Path-contained to the package via realpath on BOTH ends (a package-
// local symlink that escapes the package is rejected); any read failure or
// rejected content → null so the host falls back to its static icon map.
export function sanitizeLogoDataUri(dir, logoRel) {
  if (typeof logoRel !== "string" || !logoRel.trim().toLowerCase().endsWith(".svg")) return null;
  const pkgRoot = resolve(join(REPO_ROOT, dir));
  const abs = resolve(pkgRoot, logoRel);
  // Lexical containment first (cheap reject of `../` escapes).
  if (abs !== pkgRoot && !abs.startsWith(pkgRoot + sep)) return null;
  let realRoot;
  let realAbs;
  try {
    realRoot = realpathSync(pkgRoot);
    realAbs = realpathSync(abs); // follows symlinks — then re-check containment
  } catch {
    return null;
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) return null;
  let svg;
  try {
    svg = readFileSync(realAbs, "utf8");
  } catch {
    return null;
  }
  return sanitizeSvgToDataUri(svg);
}

function entryFlags(rec) {
  const d = rec.dir; // repo-relative
  const has = (sub) => fileExists(join(d, sub));
  return {
    hasOas: has("cinatra/oas.json"),
    hasMcpModule: has("src/mcp/module.ts"),
    hasSetupPage: has("src/setup-page.tsx"),
    hasSettingsPage: has("src/settings-page.tsx"),
    // Conventional skills-settings tab module: a connector that contributes a
    // tab to the host's /configuration/skills page ships
    // `src/skills-settings-page.tsx` exporting `SkillsSettingsTabContent`
    // (openai today). Presence-aware like every other surface.
    hasSkillsSettingsPage: has("src/skills-settings-page.tsx"),
  };
}

// ---------------------------------------------------------------------------
// MCP capability-module + primitive-handler factory discovery.
//
// A connector exposes its MCP capability module by exporting a single
// `create*Module()` factory from `src/mcp/module.ts` (subpath `<pkg>/mcp-module`)
// and, optionally, its in-process primitive handlers by exporting a single
// `create*PrimitiveHandlers()` factory from `src/mcp/handlers.ts` (subpath
// `<pkg>/mcp-handlers`). The generator records the factory EXPORT NAME next to
// the literal dynamic-import loader so the host can resolve the factory from
// the imported namespace without naming any connector package.
// ---------------------------------------------------------------------------
const MCP_MODULE_FACTORY_RE = /export\s+function\s+(create[A-Za-z0-9]*Module)\s*\(/g;
const PRIMITIVE_HANDLERS_FACTORY_RE = /export\s+function\s+(create[A-Za-z0-9]*PrimitiveHandlers)\s*\(/g;
// External-MCP toolbox factory (`src/mcp/toolbox.ts` → subpath `<pkg>/mcp-toolbox`).
// Participation requires BOTH the `cinatra.providesExternalMcpToolbox: true`
// capability marker AND the toolbox module; the marker alone means the
// extension's external MCP server resolves through the host registry
// (`external_mcp_servers`) instead of a first-party builder.
const EXTERNAL_MCP_TOOLBOX_FACTORY_RE = /export\s+function\s+(create[A-Za-z0-9]*ExternalMcpToolbox)\s*\(/g;
const WIDGET_CHAT_TOOL_FACTORY_RE = /export\s+function\s+(create[A-Za-z0-9]*WidgetChatTool)\s*\(/g;

// Extract the factory export name from a connector MCP source file, or null
// when the file exports no matching factory (the connector does not take part
// in that surface). MORE THAN ONE match is ambiguous and FAILS generation —
// the host resolves exactly one factory per loader entry.
export function extractFactoryExport(source, re, context) {
  re.lastIndex = 0;
  const matches = Array.from(source.matchAll(re)).map((m) => m[1]);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `[extension-manifest] ${context}: ambiguous factory exports (${matches.join(", ")}) — exactly one is required`,
    );
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Chat-widget manifest/widgets pairing check (source-level, pure + exported).
//
// The pure-data manifest module (src/widgets/manifest.ts) references widgets
// by `widgetId:` (wizard steps: a string literal; detectors: a string literal
// OR a Record whose string VALUES are widget ids); the component module
// (src/widgets/index.ts) defines the widgets (`id:` string literals inside the
// WidgetDefinition[]). The route-handler catalog path loads ONLY the manifest
// module, so a manifest naming a widget the package does not define cannot be
// detected at runtime there — it MUST fail generation:
//   - every collected widgetId must be a DEFINED widget id;
//   - a `widgetId:` whose value is not a plain string literal ('/"/` without
//     ${}) or an inline record of plain string values is NON-LITERAL
//     (identifier, computed, template interpolation) and is rejected outright
//     — the check cannot see through it, so it fails closed.
// Over-collection of `id:` literals from the widgets source (e.g. other
// object literals) can only weaken the coverage check, never false-fail it.
// ---------------------------------------------------------------------------
// A plain string literal: '...' | "..." | `...` with no ${} interpolation —
// and NOTHING after it but the value terminator (`,` `}` `]` `)` `;` or end of
// line), so a computed expression with a literal PREFIX ("x" + suffix) never
// passes as a literal (it falls through to the non-literal rejection).
const STRING_LITERAL_RE = /^(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)(?=\s*(?:[,}\]);]|$|\r|\n))/;
const WIDGETS_DEFINED_ID_RE = /\bid:\s*(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)/g;

function literalValue(m) {
  return m[1] ?? m[2] ?? m[3];
}

export function assertManifestWidgetIdsCovered(manifestSource, widgetsSource, context) {
  const defined = new Set(
    Array.from(widgetsSource.matchAll(WIDGETS_DEFINED_ID_RE), literalValue),
  );
  const referenced = [];
  const WIDGET_ID_KEY_RE = /\bwidgetId:\s*/g;
  let key;
  while ((key = WIDGET_ID_KEY_RE.exec(manifestSource)) !== null) {
    const rest = manifestSource.slice(key.index + key[0].length);
    const lit = STRING_LITERAL_RE.exec(rest);
    if (lit) {
      referenced.push(literalValue(lit));
      continue;
    }
    if (rest.startsWith("{")) {
      // Detector record form: { group: "widget.id", ... } — validate the
      // string VALUES inside the balanced braces; any non-literal value
      // (depth-1 `:` not followed by a plain string literal) fails closed.
      let depth = 0;
      let end = 0;
      for (; end < rest.length; end++) {
        if (rest[end] === "{") depth++;
        else if (rest[end] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) {
        throw new Error(
          `[extension-manifest] ${context}: unbalanced widgetId record in src/widgets/manifest.ts`,
        );
      }
      const record = rest.slice(0, end + 1);
      // Literal values must be IMMEDIATELY terminated (`,` or `}`) — a value
      // with a literal prefix and a trailing expression ("x" + y) fails the
      // lookahead and is captured by the catch-all → non-literal rejection.
      const VALUE_RE = /:\s*(?:"([^"\\]*)"(?=\s*[,}])|'([^'\\]*)'(?=\s*[,}])|`([^`\\$]*)`(?=\s*[,}])|([^,}\s][^,}]*))/g;
      let v;
      while ((v = VALUE_RE.exec(record)) !== null) {
        if (v[4] !== undefined) {
          throw new Error(
            `[extension-manifest] ${context}: non-literal widgetId record value ` +
              `(${v[4].trim()}) in src/widgets/manifest.ts — widget ids must be plain string literals`,
          );
        }
        referenced.push(v[1] ?? v[2] ?? v[3]);
      }
      continue;
    }
    throw new Error(
      `[extension-manifest] ${context}: non-literal widgetId value in src/widgets/manifest.ts ` +
        `(${rest.slice(0, 40).trim()}…) — widget ids must be plain string literals ` +
        `(no identifiers, no computed values, no \${} interpolation)`,
    );
  }
  const missing = referenced.filter((id) => !defined.has(id));
  if (missing.length > 0) {
    throw new Error(
      `[extension-manifest] ${context}: manifest wizard step(s)/detector(s) reference widget id(s) ` +
        `not defined in src/widgets/index.ts: ${[...new Set(missing)].join(", ")} ` +
        `(declare every referenced widget id as an id: "..." literal in the widgets module)`,
    );
  }
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Widget-stream capability declaration (`cinatra.widgetStream`).
//
// A connector that backs an in-CMS chat widget declares its stream surface in
// its package.json instead of being hardcoded in the host's
// /api/agents/[agentSlug]/stream route:
//   - `agentSlug`        — the public route slug the widget posts to
//   - `label`            — human CMS label used in the system prompt
//   - `subjectNoun`      — what the agent edits ("node"/"post"/…)
//   - `skillCapability`  — the `cinatra.capabilities` key (declared by the
//                          skill-bearing package) the route resolves + self-heals
//                          through the generic extension-skill-resolver
//   - `contextFields`    — ordered `{ key, maxLength }` list embedded (sanitized)
//                          into the system prompt from the request context
//   - `auth`             — `{ tokenConfigKey, instancesConfigKey,
//                          requiredInstanceFields }` driving the generic
//                          origin-allowlist + bearer-token validation
// The package must also ship `src/widget-chat-tool.ts` exporting exactly one
// `create*WidgetChatTool()` factory; the generator records the factory name next
// to a literal dynamic-import loader (Turbopack-safe), exactly like the
// connector MCP surfaces. FAIL-CLOSED: a malformed declaration, a missing
// factory, or an unresolvable `<pkg>/widget-chat-tool` subpath is a generation
// error — a silently dropped entry would 404 the live widget.
// ---------------------------------------------------------------------------
const WIDGET_AGENT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WIDGET_CONTEXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const WIDGET_CONFIG_KEY_RE = /^[a-z0-9_]+$/;

export function validateWidgetStreamDeclaration(pkgName, ws) {
  const errors = [];
  const at = `${pkgName} cinatra.widgetStream`;
  if (!isObj(ws)) return [`${at}: must be an object`];
  if (typeof ws.agentSlug !== "string" || !WIDGET_AGENT_SLUG_RE.test(ws.agentSlug)) {
    errors.push(`${at}.agentSlug: must be a kebab-case slug`);
  }
  if (typeof ws.label !== "string" || !ws.label.trim()) {
    errors.push(`${at}.label: must be a non-empty string`);
  }
  if (typeof ws.subjectNoun !== "string" || !ws.subjectNoun.trim()) {
    errors.push(`${at}.subjectNoun: must be a non-empty string`);
  }
  if (typeof ws.skillCapability !== "string" || !ws.skillCapability.trim()) {
    errors.push(`${at}.skillCapability: must be a non-empty string`);
  }
  if (
    ws.relayAgentPackage !== undefined &&
    (typeof ws.relayAgentPackage !== "string" ||
      !/^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/.test(ws.relayAgentPackage))
  ) {
    errors.push(`${at}.relayAgentPackage: must be an npm package name (e.g. @cinatra-ai/wordpress-agent) when present`);
  }
  if (!Array.isArray(ws.contextFields) || ws.contextFields.length === 0) {
    errors.push(`${at}.contextFields: must be a non-empty array`);
  } else {
    const seen = new Set();
    ws.contextFields.forEach((f, i) => {
      if (!isObj(f) || typeof f.key !== "string" || !WIDGET_CONTEXT_KEY_RE.test(f.key)) {
        errors.push(`${at}.contextFields[${i}].key: must be an identifier`);
        return;
      }
      if (seen.has(f.key)) errors.push(`${at}.contextFields[${i}].key: duplicate "${f.key}"`);
      seen.add(f.key);
      if (!Number.isInteger(f.maxLength) || f.maxLength <= 0) {
        errors.push(`${at}.contextFields[${i}].maxLength: must be a positive integer`);
      }
    });
  }
  if (!isObj(ws.auth)) {
    errors.push(`${at}.auth: must be an object`);
  } else {
    for (const k of ["tokenConfigKey", "instancesConfigKey"]) {
      if (typeof ws.auth[k] !== "string" || !WIDGET_CONFIG_KEY_RE.test(ws.auth[k])) {
        errors.push(`${at}.auth.${k}: must be a snake_case connector-config key`);
      }
    }
    if (
      !Array.isArray(ws.auth.requiredInstanceFields) ||
      ws.auth.requiredInstanceFields.some((f) => typeof f !== "string" || !f.trim())
    ) {
      errors.push(`${at}.auth.requiredInstanceFields: must be an array of non-empty strings`);
    }
    // cinatra#408 — optional per-agent "require user token" flag. Absent is
    // valid (defaults to ENFORCE on the public_site_widget surface); when
    // present it MUST be a boolean. An explicit `false` is the audited opt-out.
    if ("requireUserToken" in ws.auth && typeof ws.auth.requireUserToken !== "boolean") {
      errors.push(`${at}.auth.requireUserToken: must be a boolean when present`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Inbound-webhook declaration (`cinatra.webhooks`, cinatra#340).
//
// A connector OPTS IN to receiving webhooks by declaring `cinatra.webhooks` in
// its package.json:
//   - `hooks`        — non-empty array of declared hooks; each:
//       - `id`          — kebab-case hook id (the `<hook>` URL segment)
//       - `handler`     — package-relative subpath (e.g. "./src/webhooks/post")
//                         whose module exports the named `factory`
//       - `factory`     — the named export the host invokes (a function)
//       - `label`       — optional human label (#342 registry UI); derived from
//                         the id when absent
//       - `rejectStatus`— optional 4xx (400-499) the route returns for a
//                         `rejected` outcome (default 204)
//       - `schemaVersion`— optional declared payload schema version (carried as
//                         metadata; integer >= 1 when present)
// FAIL-CLOSED: a malformed declaration, a duplicate hook id within the package,
// a missing handler subpath, or a missing/non-function factory is a generation
// error — a silently dropped hook would 404 a live webhook, and an over-emitted
// one would dispatch to a non-existent handler.
// ---------------------------------------------------------------------------
const WEBHOOK_HOOK_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WEBHOOK_FACTORY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WEBHOOK_HANDLER_SUBPATH_RE = /^\.\/[A-Za-z0-9._/-]+$/;

export function validateWebhooksDeclaration(pkgName, w) {
  const errors = [];
  const at = `${pkgName} cinatra.webhooks`;
  if (!isObj(w)) return [`${at}: must be an object`];
  if (!Array.isArray(w.hooks) || w.hooks.length === 0) {
    return [`${at}.hooks: must be a non-empty array`];
  }
  const seen = new Set();
  w.hooks.forEach((h, i) => {
    const hat = `${at}.hooks[${i}]`;
    if (!isObj(h)) {
      errors.push(`${hat}: must be an object`);
      return;
    }
    if (typeof h.id !== "string" || !WEBHOOK_HOOK_ID_RE.test(h.id)) {
      errors.push(`${hat}.id: must be a kebab-case hook id`);
    } else if (seen.has(h.id)) {
      errors.push(`${hat}.id: duplicate hook id "${h.id}" within ${pkgName}`);
    } else {
      seen.add(h.id);
    }
    if (typeof h.handler !== "string" || !WEBHOOK_HANDLER_SUBPATH_RE.test(h.handler)) {
      errors.push(`${hat}.handler: must be a package-relative subpath (e.g. "./src/webhooks/post")`);
    }
    if (typeof h.factory !== "string" || !WEBHOOK_FACTORY_RE.test(h.factory)) {
      errors.push(`${hat}.factory: must be a non-empty identifier`);
    }
    if (h.label !== undefined && (typeof h.label !== "string" || !h.label.trim())) {
      errors.push(`${hat}.label: must be a non-empty string when present`);
    }
    if (h.rejectStatus !== undefined) {
      if (!Number.isInteger(h.rejectStatus) || h.rejectStatus < 400 || h.rejectStatus > 499) {
        errors.push(`${hat}.rejectStatus: must be an integer 400-499 when present`);
      }
    }
    if (h.schemaVersion !== undefined) {
      if (!Number.isInteger(h.schemaVersion) || h.schemaVersion < 1) {
        errors.push(`${hat}.schemaVersion: must be a positive integer when present`);
      }
    }
  });
  return errors;
}

// Source-level assertion that a webhook handler module exports the named
// `factory` as a CALLABLE function. The generator never transpiles/imports the
// TS, so callability is proven structurally and FAIL-CLOSED:
//   - `export function NAME(`            / `export async function NAME(`
//   - `export const NAME = (...) =>`     (arrow, incl. async / typed / bare /
//                                          extra-parenthesized params)
//   - `export const NAME = function`     / `export const NAME = async function`
//   - `export const NAME: Type = (` / `= async (` / `= function`
// REJECTED: a non-function `export const NAME = 5`, OR a lookalike that only
// appears inside a comment / string / template / regex literal. Two defences
// stack: (1) those literals are STRIPPED first (the stripper is FAIL-CLOSED-
// biased: an ambiguous `/` after `)`/`]`/`}` is treated as a regex and stripped,
// since over-stripping only risks a false-REJECT — the safe direction — while
// under-stripping could risk a false-PASS), and (2) the `export` keyword must
// sit at STATEMENT POSITION (start of source or right after `;`/`{`/`}`/newline).
// This is a source-level structural gate, not a full JS parser; its purpose is
// to catch HONEST author mistakes (typo'd / non-function factory) fail-closed.
// A pathological false-PASS (a real export absent but a lookalike hidden in an
// exotic literal the stripper still missed) is additionally backstopped at
// RUNTIME: the generated dynamic import resolves `NAME` to `undefined` and
// buildWebhookHandler fails loud — so the connector author gains nothing.
export function webhookHandlerExportsFactory(source, factory) {
  const cleaned = stripCommentsAndStrings(source);
  const name = factory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Statement-position prefix: BOS or after `;`/`{`/`}`/newline, then optional
  // whitespace. (Captured so we can re-test successive candidates.)
  const stmt = `(?:^|[;{}\\n])\\s*`;
  // `export [async] function NAME(` or `<` (generic) at statement position.
  const fnDecl = new RegExp(`${stmt}export\\s+(?:async\\s+)?function\\s+${name}\\s*[(<]`);
  if (fnDecl.test(cleaned)) return true;
  // `export const NAME[: Type] = <function form>` at statement position, where
  // the function form is `[async] function …` OR an arrow whose head is an
  // IDENTIFIER param (`x =>`) or a balanced `(...)` param list (possibly with a
  // default containing nested `()`), optionally wrapped in extra parens.
  const head = new RegExp(`${stmt}export\\s+const\\s+${name}\\b[^=;]*=\\s*`, "g");
  head.lastIndex = 0;
  let m;
  while ((m = head.exec(cleaned)) !== null) {
    // Re-arm lastIndex by one so overlapping statement separators still match
    // the next candidate on a subsequent iteration.
    head.lastIndex = m.index + 1;
    let i = m.index + m[0].length;
    let rest = cleaned.slice(i);
    // `[async] function …` form.
    if (/^async\s+function\b/.test(rest) || /^function\b/.test(rest)) return true;
    // Arrow form. Optional `async`.
    const asyncM = /^async\s+/.exec(rest);
    if (asyncM) {
      i += asyncM[0].length;
      rest = cleaned.slice(i);
    }
    // Peel leading `(` WRAPPER parens (e.g. `((deps) => …)`): a leading `(` is a
    // wrapper iff it is NOT itself the start of an arrow param head. Stop as
    // soon as the remaining text IS an arrow paren head (or anything else).
    while (rest[0] === "(" && !isArrowParenHead(rest)) {
      i += 1;
      rest = cleaned.slice(i);
    }
    // Bare identifier arrow head: `x =>` (no parens).
    if (/^[A-Za-z_$][A-Za-z0-9_$]*\s*=>/.test(rest)) return true;
    // Optional `<generics>` (angle-bracket BALANCED, so nested generics like
    // `<T extends Record<string, unknown>>` are skipped whole) then `(...)`.
    if (rest[0] === "<") {
      const gclose = matchBalancedAngle(cleaned, i);
      if (gclose >= 0) {
        i = gclose;
        const ws = /^\s*/.exec(cleaned.slice(i));
        i += ws[0].length;
        rest = cleaned.slice(i);
      }
    }
    if (rest[0] !== "(") continue;
    const close = matchBalancedParen(cleaned, i);
    if (close < 0) continue;
    // After the params: optional `: ReturnType` then the `=>` arrow token.
    if (/^\s*(?::[^=]*?)?=>/.test(cleaned.slice(close))) return true;
  }
  return false;
}

// True when `rest` begins with a balanced `(...)` param list immediately
// followed (modulo a `: ret` annotation) by `=>`.
function isArrowParenHead(rest) {
  if (rest[0] !== "(") return false;
  const close = matchBalancedParen(rest, 0);
  if (close < 0) return false;
  return /^\s*(?::[^=]*?)?=>/.test(rest.slice(close));
}

// Index just past the `)` that balances the `(` at `open`, or -1 if unbalanced.
function matchBalancedParen(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// Index just past the `>` that balances the `<` at `open` (a generic param
// list), or -1 if unbalanced. Only used immediately after `export const NAME =`,
// where a `<` is a generic, not a comparison.
function matchBalancedAngle(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "<") depth++;
    else if (s[j] === ">") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// Strip line comments, block comments, string literals, regex literals, and the
// LITERAL TEXT of template literals (recursing into `${ … }` interpolations,
// whose embedded strings are themselves stripped) from JS/TS source — so a
// structural source-level gate cannot be satisfied by a name that only appears
// in a comment, a string, a regex, or a template-literal text/nested string.
// Conservative + FAIL-CLOSED: replaces every stripped span with a single space
// (never merges adjacent tokens) and KEEPS the code inside `${ … }` (real
// expressions) for re-scanning. Not a full parser, but it removes every place an
// `export …` lookalike can hide.
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  // Track the previous two significant chars to disambiguate a `/` that begins
  // a regex literal from a division operator (incl. division after a postfix
  // `++`/`--`, where the immediate prev char is `+`/`-` but it is NOT a regex
  // context). `prevWord` is the most recent identifier/keyword token — a regex
  // can also start right after a keyword like `return`/`typeof`/`case`/etc.
  let prevSignificant = "";
  let prevSignificant2 = "";
  let prevWord = "";
  // Keywords after which a `/` begins a REGEX literal (expression position),
  // not division. (An identifier/`)`/`]`/literal before `/` means division.)
  const REGEX_PREV_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "do", "else", "yield", "await", "case", "default",
  ]);
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    // Line comment.
    if (c === "/" && c2 === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Block comment.
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // Regex literal — only where a regex can legally START: after an operator /
    // opening bracket / separator, or at the start of input (prevSignificant
    // empty). A postfix `++`/`--` (prev two chars both `+` or both `-`) is NOT a
    // regex context — the following `/` is division. Otherwise `/` is division
    // and falls through to be kept verbatim.
    const postfixIncDec =
      (prevSignificant === "+" && prevSignificant2 === "+") ||
      (prevSignificant === "-" && prevSignificant2 === "-");
    // A regex starts here if: BOS, OR after regex-context punctuation, OR the
    // immediately-preceding token is a regex-context keyword (return, typeof,…).
    // When the prev significant char is a word char, a regex can only follow if
    // that word is one of REGEX_PREV_KEYWORDS (else it's an identifier → div).
    const prevIsWordChar = /[A-Za-z0-9_$]/.test(prevSignificant);
    // NOTE on `)` `]` `}`: these are genuinely ambiguous (a `/` after them can be
    // division — `(a)/b` — OR a regex — `if (c) /re/`). For this FAIL-CLOSED gate
    // we treat them as regex-start, i.e. we STRIP the `/…/` span. Over-stripping a
    // real division can only cause a false-REJECT (the safe direction); leaving a
    // regex body un-stripped could cause a false-PASS (the unsafe direction), so
    // we bias to stripping. A handler-factory module dividing right after `)`/`]`
    // /`}` and then `export`ing on the same logical line is not a real shape.
    const regexCanStart =
      prevSignificant === "" ||
      (prevIsWordChar
        ? REGEX_PREV_KEYWORDS.has(prevWord)
        : /[([{,;:=!&|?+\-*%<>~^)\]}]/.test(prevSignificant));
    if (c === "/" && !postfixIncDec && regexCanStart) {
      i++;
      let inClass = false;
      while (i < n) {
        const r = source[i];
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) {
          i++;
          break;
        } else if (r === "\n") break; // unterminated — bail (treat as not-regex)
        i++;
      }
      // Skip trailing flags.
      while (i < n && /[a-z]/i.test(source[i])) i++;
      out += " ";
      prevSignificant2 = prevSignificant;
      prevSignificant = "/";
      prevWord = "";
      continue;
    }
    // Plain string literal.
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      prevSignificant2 = prevSignificant;
      prevSignificant = quote;
      prevWord = "";
      continue;
    }
    // Template literal — strip text spans, recurse into `${ … }` expressions.
    if (c === "`") {
      i++;
      out += " ";
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          i++;
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          // Capture the balanced `${ … }` expression and re-strip it (a nested
          // template string inside it is handled by the recursion).
          let depth = 0;
          let j = i + 1;
          for (; j < n; j++) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
          }
          out += " " + stripCommentsAndStrings(source.slice(i + 2, j - 1)) + " ";
          i = j;
          continue;
        }
        i++; // ordinary template text char — dropped.
      }
      prevSignificant2 = prevSignificant;
      prevSignificant = "`";
      prevWord = "";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) {
      prevSignificant2 = prevSignificant;
      prevSignificant = c;
      // Maintain the trailing word token: extend on a word char, else reset.
      prevWord = /[A-Za-z0-9_$]/.test(c) ? prevWord + c : "";
    }
    i++;
  }
  return out;
}

// Derive a default human label from a kebab-case hook id (title-case words).
function deriveWebhookLabel(id) {
  return id
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// A plain-JS shape validator that MIRRORS the authoritative TS parser
// `parseSchemaConfig` (src/lib/extension-schema-config.ts) closely enough to
// FAIL the manifest generation when a connector declares
// `cinatra.uiSurface:"schema-config"` with a malformed `cinatra.configSchema`.
// This is a generation-time gate, not the runtime renderer's validation: the
// dispatch route still calls the real `parseSchemaConfig` for the fail-closed
// verdict it renders from. Returns an array of error strings ([] = valid).
//
// The .mjs build script cannot import the TS parser, so this duplicates its
// CORE rules (non-empty fields, known kind, per-kind required keys, key/actionId
// regex, duplicate-key detection, flat repeatable-list item fields). Kept
// deliberately conservative — any divergence errs toward REJECTING at
// generation, which is the safe direction (a connector with a malformed schema
// never reaches the manifest).
const SCHEMA_CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SCHEMA_CONFIG_FIELD_KINDS = new Set([
  "text",
  "secret",
  "nango-connect",
  "repeatable-list",
  "status-probe",
  "copyable-credential",
  "named-action",
]);
function nonEmptyStr(v) {
  return typeof v === "string" && v.length > 0;
}
function validateConfigSchemaField(kind, raw, at, errors, seenKeys) {
  if (!nonEmptyStr(raw.label)) {
    errors.push(`${at}: missing "label"`);
    return;
  }
  const needsKey =
    kind === "text" || kind === "secret" || kind === "copyable-credential" || kind === "repeatable-list";
  if (needsKey) {
    if (!nonEmptyStr(raw.key) || !SCHEMA_CONFIG_KEY_RE.test(raw.key)) {
      errors.push(`${at}: invalid or missing "key"`);
      return;
    }
    if (seenKeys.has(raw.key)) {
      errors.push(`${at}: duplicate key "${raw.key}"`);
      return;
    }
    seenKeys.add(raw.key);
  }
  if (kind === "nango-connect" && !nonEmptyStr(raw.providerConfigKey)) {
    errors.push(`${at}: nango-connect requires "providerConfigKey"`);
  }
  if ((kind === "status-probe" || kind === "named-action") && (!nonEmptyStr(raw.actionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.actionId))) {
    errors.push(`${at}: ${kind} requires a valid "actionId"`);
  }
  if (kind === "repeatable-list") {
    const items = raw.itemFields;
    if (!Array.isArray(items) || items.length === 0) {
      errors.push(`${at}: repeatable-list requires a non-empty "itemFields"`);
      return;
    }
    const itemSeen = new Set();
    items.forEach((item, j) => {
      const itemAt = `${at}.itemFields[${j}]`;
      if (!isObj(item) || (item.kind !== "text" && item.kind !== "secret")) {
        errors.push(`${itemAt}: must be a flat text or secret field`);
        return;
      }
      validateConfigSchemaField(item.kind, item, itemAt, errors, itemSeen);
    });
  }
}
export function validateConfigSchema(raw) {
  if (!isObj(raw)) return ["configSchema must be an object"];
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    return ["configSchema.fields must be a non-empty array"];
  }
  const errors = [];
  const seenKeys = new Set();
  raw.fields.forEach((field, i) => {
    const at = `fields[${i}]`;
    if (!isObj(field)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (typeof field.kind !== "string" || !SCHEMA_CONFIG_FIELD_KINDS.has(field.kind)) {
      errors.push(`${at}: unknown field kind ${JSON.stringify(field.kind)}`);
      return;
    }
    validateConfigSchemaField(field.kind, field, at, errors, seenKeys);
  });
  return errors;
}

// schema-config vs bundled-react classification. The classifier
// PREFERS a manifest-declared `cinatra.uiSurface`:
//   - `"schema-config"` → the connector ships NO React; the host renders its
//     declared `cinatra.configSchema` (DATA). FAIL-CLOSED: an invalid configSchema
//     is a generation error (see `classifyConnectorUiSurfaceErrors`), never a
//     silent bundled-react fallback.
//   - `"bundled-react"` → the connector's React setup page is base-image-only.
// When no `uiSurface` is declared the legacy heuristic applies: a bespoke
// setup/settings page → bundled-react; otherwise (facade/runtime connector) →
// null. Agents/artifacts/skills/workflows are declarative → always null.
export function classifyUiSurface(rec, flags, cin = {}) {
  if (rec.kind !== "connector") return null;
  if (cin.uiSurface === "schema-config") return "schema-config";
  if (cin.uiSurface === "bundled-react") return "bundled-react";
  if (flags.hasSetupPage || flags.hasSettingsPage) return "bundled-react";
  return null;
}

// Returns the generation-time errors for a connector's declared UI surface (the
// fail-closed verdict `checkParity` and `buildManifest` enforce). A connector
// that declares `uiSurface:"schema-config"` MUST carry a valid `configSchema`.
export function classifyConnectorUiSurfaceErrors(rec, cin = {}) {
  if (rec.kind !== "connector") return [];
  if (cin.uiSurface === "schema-config") {
    if (!isObj(cin.configSchema)) {
      return [`${rec.packageName ?? rec.name ?? "extension"} declares uiSurface:"schema-config" but no object cinatra.configSchema`];
    }
    return validateConfigSchema(cin.configSchema).map(
      (e) => `${rec.packageName ?? rec.name ?? "extension"} cinatra.configSchema ${e}`,
    );
  }
  return [];
}

export async function buildManifest() {
  const inv = await buildInventory();
  // Generator-owned presence classification (cinatra#7): `"required"` =
  // member of the host-owned `cinatra.systemExtensions` locked set (its
  // loaders import UNGUARDED — absence stays a loud failure);
  // `"guardedOptional"` = everything else (its loaders route through the
  // standardized degraded-result guard, src/lib/extension-load-guard.ts).
  // Deliberately keyed on `systemExtensions`, NOT `extensions` (the
  // prod-acquisition set) — keying on the acquisition set would be circular
  // for the planned 33→systemExtensions shrink (cinatra#7). Downstream gates key
  // EXCLUSIVELY on this emitted field (missing/unknown ⇒ required,
  // fail-closed) — never on source-shape inference.
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const declaredSystem = rootPkg?.cinatra?.systemExtensions;
  if (!Array.isArray(declaredSystem) || declaredSystem.length === 0) {
    throw new Error(
      "[extension-manifest] root package.json must declare a non-empty cinatra.systemExtensions array (host-owned locked system set)",
    );
  }
  const systemSet = new Set(declaredSystem);
  const resolutionOf = (packageName) => (systemSet.has(packageName) ? "required" : "guardedOptional");
  const records = inv.extensions.map((x) => {
    const flags = entryFlags(x);
    const cin = readCinatraManifest(x.dir);
    // FAIL-CLOSED: a connector declaring uiSurface:"schema-config" with a
    // malformed configSchema is a generation error, not a silent fallback. The
    // record carries x.name as packageName so the error names the offender.
    const uiErrors = classifyConnectorUiSurfaceErrors({ kind: x.kind, packageName: x.name }, cin);
    if (uiErrors.length > 0) {
      throw new Error(`[extension-manifest] invalid schema-config declaration:\n  - ${uiErrors.join("\n  - ")}`);
    }
    // FAIL-CLOSED (#118): host migrations are a STORE-install capability — the
    // host applies `cinatra.migrationsDir` modules only for trusted-signed
    // store records (runtime loader / install pipeline). A bundled workspace
    // extension never takes that path, so a declaration here would silently
    // never run; refuse at generation instead. The retired JSON-DSL field
    // (`cinatra.migrations`) is refused everywhere.
    if (cin.migrations !== undefined || cin.migrationsDir !== undefined) {
      throw new Error(
        `[extension-manifest] ${x.name} declares ${cin.migrations !== undefined ? "the retired cinatra.migrations JSON-DSL field" : "cinatra.migrationsDir"} — ` +
          `bundled workspace extensions cannot ship host migrations (they run only for trusted-signed STORE installs, cinatra#118); ` +
          `move the schema change into the marketplace-installed package or the core migration chain`,
      );
    }
    return {
      packageName: x.name,
      scope: x.scope,
      kind: x.kind,
      version: x.version,
      sourceDir: x.dir,
      // The compiled server entry the loader imports (the `./register` export),
      // sourced from the manifest's `cinatra.serverEntry`. Most extensions don't
      // declare one yet (null) — they expose `register(ctx)` as they're decoupled.
      // The prototype slice (resend) declares "./register".
      serverEntry: cin.serverEntry ?? null,
      hasOas: flags.hasOas,
      hasMcpModule: flags.hasMcpModule,
      hasSetupPage: flags.hasSetupPage,
      hasSettingsPage: flags.hasSettingsPage,
      hasSkillsSettingsPage: flags.hasSkillsSettingsPage,
      uiSurface: classifyUiSurface(x, flags, cin),
      // The declared schema-config DATA the host renders the setup surface from
      // (validated above). null for bundled-react / no-UI extensions.
      configSchema: isObj(cin.configSchema) ? cin.configSchema : null,
      // Least-privilege host ports the extension requests (manifest-declared;
      // derived empirically per-extension during the decoupling sweep).
      requestedHostPorts: Array.isArray(cin.requestedHostPorts) ? cin.requestedHostPorts : [],
      // External-MCP-toolbox capability marker. The DISCRIMINATING selector for
      // the LLM toolbox-injection path (`hasMcpModule` is not one — self-MCP
      // capability modules also set it). Declared, never inferred.
      providesExternalMcpToolbox: cin.providesExternalMcpToolbox === true,
      // ABI range the extension was built against — the loader's ABI gate
      // consults it (null = unpinned). MUST round-trip or the gate is decorative.
      sdkAbiRange: typeof cin.sdkAbiRange === "string" ? cin.sdkAbiRange : null,
      // Canonical cross-kind dependency edges. Legacy agent/connectorDependencies
      // normalization is the inventory drift check's job; here we carry only the
      // canonical field (empty for every extension today).
      dependencies: Array.isArray(cin.dependencies) ? cin.dependencies : [],
      // Self-describing card identity (null → host catalog/icon fallback).
      displayName: resolveDisplayName(cin),
      logo: sanitizeLogoDataUri(x.dir, cin.logo),
      // Self-declared connector vendor identity (`cinatra.vendor`, #12); null
      // when undeclared. Carried through unvalidated — the marketplace publish
      // gate (separate repo) owns shape/ownership/uniqueness/provider-mapping.
      vendor: resolveVendor(cin),
      // Generator-owned presence classification (see resolutionOf above).
      resolution: resolutionOf(x.name),
    };
  });
  records.sort((a, b) => a.packageName.localeCompare(b.packageName));

  const connectorSetupPages = records
    .filter((r) => r.kind === "connector" && r.hasSetupPage)
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName, resolution: r.resolution }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const connectorSettingsPages = records
    .filter((r) => r.kind === "connector" && r.hasSettingsPage)
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName, resolution: r.resolution }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const connectorSkillsSettingsTabs = records
    .filter((r) => r.kind === "connector" && r.hasSkillsSettingsPage)
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName, resolution: r.resolution }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // Connector entry modules: the package root (src/index.ts) of every workspace
  // connector, keyed by slug. The host resolves a connector's server module
  // (status/config/action exports) through this map instead of importing the
  // package by name.
  const connectorEntryModules = records
    .filter((r) => r.kind === "connector" && fileExists(join(r.sourceDir, "src/index.ts")))
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName, resolution: r.resolution }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // Connector MCP capability modules: every connector that ships src/mcp/module.ts
  // (hasMcpModule) MUST export exactly one create*Module() factory — the host
  // registers these modules from this map, so a module the generator cannot
  // resolve would silently fall off the MCP surface. FAIL CLOSED at generation.
  const connectorMcpModules = records
    .filter((r) => r.kind === "connector" && r.hasMcpModule)
    .map((r) => {
      const moduleSource = readFileSync(join(REPO_ROOT, r.sourceDir, "src/mcp/module.ts"), "utf8");
      const factory = extractFactoryExport(
        moduleSource,
        MCP_MODULE_FACTORY_RE,
        `${r.packageName} src/mcp/module.ts`,
      );
      if (!factory) {
        throw new Error(
          `[extension-manifest] ${r.packageName} ships src/mcp/module.ts but exports no create*Module() factory`,
        );
      }
      return { slug: r.packageName.split("/")[1], packageName: r.packageName, factory, resolution: r.resolution };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // Connector in-process primitive handlers: a connector OPTS IN by exporting a
  // create*PrimitiveHandlers() factory from src/mcp/handlers.ts. A handlers file
  // without the factory export is not part of this surface (skipped, not an
  // error) — the factory export IS the registration.
  const connectorPrimitiveHandlers = records
    .filter(
      (r) => r.kind === "connector" && fileExists(join(r.sourceDir, "src/mcp/handlers.ts")),
    )
    .map((r) => {
      const handlersSource = readFileSync(
        join(REPO_ROOT, r.sourceDir, "src/mcp/handlers.ts"),
        "utf8",
      );
      const factory = extractFactoryExport(
        handlersSource,
        PRIMITIVE_HANDLERS_FACTORY_RE,
        `${r.packageName} src/mcp/handlers.ts`,
      );
      return factory
        ? { slug: r.packageName.split("/")[1], packageName: r.packageName, factory, resolution: r.resolution }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // External-MCP toolbox builders: an extension takes part in the LLM
  // toolbox-injection path by declaring the `providesExternalMcpToolbox`
  // capability marker. Marker + `src/mcp/toolbox.ts` → a first-party builder
  // loader entry (exactly one create*ExternalMcpToolbox() factory, FAIL CLOSED
  // like the MCP-module map). Marker WITHOUT the module → no entry (the host
  // resolves the extension's server through the external_mcp_servers
  // registry). A toolbox module WITHOUT the marker is dead code that would
  // silently never inject — generation error.
  const externalMcpToolboxes = records
    .map((r) => {
      const hasToolboxModule = fileExists(join(r.sourceDir, "src/mcp/toolbox.ts"));
      if (!r.providesExternalMcpToolbox) {
        if (hasToolboxModule) {
          throw new Error(
            `[extension-manifest] ${r.packageName} ships src/mcp/toolbox.ts but does not declare cinatra.providesExternalMcpToolbox: true — the toolbox would never be injected`,
          );
        }
        return null;
      }
      if (!hasToolboxModule) return null; // registry-resolved external-MCP extension
      const toolboxSource = readFileSync(join(REPO_ROOT, r.sourceDir, "src/mcp/toolbox.ts"), "utf8");
      const factory = extractFactoryExport(
        toolboxSource,
        EXTERNAL_MCP_TOOLBOX_FACTORY_RE,
        `${r.packageName} src/mcp/toolbox.ts`,
      );
      if (!factory) {
        throw new Error(
          `[extension-manifest] ${r.packageName} ships src/mcp/toolbox.ts but exports no create*ExternalMcpToolbox() factory`,
        );
      }
      return { slug: r.packageName.split("/")[1], packageName: r.packageName, factory, resolution: r.resolution };
    })
    .filter(Boolean)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // Widget-stream agents: a connector OPTS IN by declaring `cinatra.widgetStream`
  // (validated fail-closed) and shipping src/widget-chat-tool.ts with exactly one
  // create*WidgetChatTool() factory. Keyed by agentSlug — the host stream route
  // resolves the slug generically; adding a widget extension requires NO host
  // edit. The `<pkg>/widget-chat-tool` subpath must be resolvable (tsconfig path
  // alias or package.json exports) or the literal dynamic import would fail at
  // runtime — asserted here, at generation.
  const tsconfigText = readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8");
  const widgetStreamAgents = records
    .filter((r) => r.kind === "connector")
    .map((r) => {
      const ws = readCinatraManifest(r.sourceDir).widgetStream;
      if (ws === undefined) return null;
      const errors = validateWidgetStreamDeclaration(r.packageName, ws);
      if (errors.length > 0) {
        throw new Error(
          `[extension-manifest] invalid widgetStream declaration:\n  - ${errors.join("\n  - ")}`,
        );
      }
      const toolPath = join(r.sourceDir, "src/widget-chat-tool.ts");
      if (!fileExists(toolPath)) {
        throw new Error(
          `[extension-manifest] ${r.packageName} declares cinatra.widgetStream but ships no src/widget-chat-tool.ts`,
        );
      }
      const subpath = `${r.packageName}/widget-chat-tool`;
      const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, r.sourceDir, "package.json"), "utf8"));
      const hasExportsEntry = isObj(pkgJson.exports) && "./widget-chat-tool" in pkgJson.exports;
      if (!tsconfigText.includes(JSON.stringify(subpath)) && !hasExportsEntry) {
        throw new Error(
          `[extension-manifest] ${r.packageName} declares cinatra.widgetStream but "${subpath}" is not ` +
            `resolvable (no tsconfig.json path alias and no package.json exports["./widget-chat-tool"]) — ` +
            `the generated literal import would fail at runtime`,
        );
      }
      const toolSource = readFileSync(join(REPO_ROOT, toolPath), "utf8");
      const factory = extractFactoryExport(
        toolSource,
        WIDGET_CHAT_TOOL_FACTORY_RE,
        `${r.packageName} src/widget-chat-tool.ts`,
      );
      if (!factory) {
        throw new Error(
          `[extension-manifest] ${r.packageName} src/widget-chat-tool.ts exports no create*WidgetChatTool() factory`,
        );
      }
      return {
        agentSlug: ws.agentSlug,
        packageName: r.packageName,
        factory,
        resolution: r.resolution,
        label: ws.label,
        subjectNoun: ws.subjectNoun,
        skillCapability: ws.skillCapability,
        relayAgentPackage: ws.relayAgentPackage,
        contextFields: ws.contextFields.map((f) => ({ key: f.key, maxLength: f.maxLength })),
        auth: {
          tokenConfigKey: ws.auth.tokenConfigKey,
          instancesConfigKey: ws.auth.instancesConfigKey,
          requiredInstanceFields: [...ws.auth.requiredInstanceFields],
          // cinatra#408 — carry the optional flag through ONLY when explicitly
          // declared, so the generated literal stays minimal. The route enforces
          // BY DEFAULT (absent === ENFORCE for the public_site_widget surface);
          // an explicit `false` is the only opt-out and is preserved verbatim
          // here so it stays visible + auditable in the generated manifest.
          ...(typeof ws.auth.requireUserToken === "boolean"
            ? { requireUserToken: ws.auth.requireUserToken }
            : {}),
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.agentSlug.localeCompare(b.agentSlug));
  const widgetSlugOwners = new Map();
  for (const w of widgetStreamAgents) {
    const owner = widgetSlugOwners.get(w.agentSlug);
    if (owner) {
      throw new Error(
        `[extension-manifest] duplicate widgetStream agentSlug "${w.agentSlug}" (${owner} and ${w.packageName})`,
      );
    }
    widgetSlugOwners.set(w.agentSlug, w.packageName);
  }

  // Inbound webhooks (`cinatra.webhooks`, cinatra#340): a connector OPTS IN by
  // declaring its hooks. Each hook becomes a generated registry entry keyed
  // "<vendor>/<slug>/<hook>" — the host's generic /webhook route resolves it
  // WITHOUT importing a connector package or branching on vendor/slug. Segment
  // derivation is FAIL-CLOSED (per design §4): <vendor> = npm scope, <slug> =
  // npm package name, both required to be kebab/alnum; the handler subpath must
  // resolve to a real file exporting the named factory. A duplicate
  // (vendor,slug,hook) across packages is a generation error.
  const WEBHOOK_SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const webhookHooks = records
    .filter((r) => r.kind === "connector")
    .flatMap((r) => {
      const decl = readCinatraManifest(r.sourceDir).webhooks;
      if (decl === undefined) return [];
      const errors = validateWebhooksDeclaration(r.packageName, decl);
      if (errors.length > 0) {
        throw new Error(
          `[extension-manifest] invalid webhooks declaration:\n  - ${errors.join("\n  - ")}`,
        );
      }
      // FAIL-CLOSED segment derivation from the npm package name.
      const m = /^@([^/]+)\/([^/]+)$/.exec(r.packageName);
      if (!m || !WEBHOOK_SEGMENT_RE.test(m[1]) || !WEBHOOK_SEGMENT_RE.test(m[2])) {
        throw new Error(
          `[extension-manifest] ${r.packageName} declares cinatra.webhooks but its package name does not ` +
            `derive a kebab-case @<vendor>/<slug> pair (no silent remap)`,
        );
      }
      const vendor = m[1];
      const slug = m[2];
      const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, r.sourceDir, "package.json"), "utf8"));
      return decl.hooks.map((h) => {
        // The handler subpath must resolve to a real file AND be importable
        // (tsconfig path alias or a package.json exports entry) so the generated
        // literal import succeeds at runtime.
        const handlerRel = h.handler.replace(/^\.\//, "");
        const handlerPath = join(r.sourceDir, handlerRel);
        const candidates = [handlerPath, `${handlerPath}.ts`, `${handlerPath}.tsx`];
        const resolved = candidates.find((p) => fileExists(p));
        if (!resolved) {
          throw new Error(
            `[extension-manifest] ${r.packageName} cinatra.webhooks hook "${h.id}" handler "${h.handler}" ` +
              `does not resolve to a file (looked for ${candidates.map((c) => relative(REPO_ROOT, c)).join(", ")})`,
          );
        }
        // The import specifier the host dynamic-imports — the subpath (minus a
        // .ts/.tsx extension) under the package name. It MUST be resolvable
        // (tsconfig alias or package exports) or the literal import fails.
        const importSubpath = handlerRel.replace(/\.(ts|tsx)$/, "");
        const specifier = `${r.packageName}/${importSubpath}`;
        const exportsKey = `./${importSubpath}`;
        const hasExportsEntry = isObj(pkgJson.exports) && exportsKey in pkgJson.exports;
        if (!tsconfigText.includes(JSON.stringify(specifier)) && !hasExportsEntry) {
          throw new Error(
            `[extension-manifest] ${r.packageName} cinatra.webhooks hook "${h.id}" subpath "${specifier}" is not ` +
              `resolvable (no tsconfig.json path alias and no package.json exports["${exportsKey}"]) — ` +
              `the generated literal import would fail at runtime`,
          );
        }
        // Assert the named factory is actually an exported function.
        const handlerSource = readFileSync(join(REPO_ROOT, resolved), "utf8");
        if (!webhookHandlerExportsFactory(handlerSource, h.factory)) {
          throw new Error(
            `[extension-manifest] ${r.packageName} cinatra.webhooks hook "${h.id}": handler module "${resolved}" ` +
              `exports no "${h.factory}" function (declared factory must be an exported function)`,
          );
        }
        return {
          vendor,
          slug,
          hook: h.id,
          scope: `${vendor}/${slug}/${h.id}`,
          packageName: r.packageName,
          specifier,
          factory: h.factory,
          label: typeof h.label === "string" && h.label.trim() ? h.label.trim() : deriveWebhookLabel(h.id),
          ...(Number.isInteger(h.rejectStatus) ? { rejectStatus: h.rejectStatus } : {}),
          ...(Number.isInteger(h.schemaVersion) ? { schemaVersion: h.schemaVersion } : {}),
          resolution: r.resolution,
        };
      });
    })
    .sort((a, b) => a.scope.localeCompare(b.scope));
  // Cross-package duplicate gate: at most one owner per (vendor,slug,hook).
  const webhookScopeOwners = new Map();
  for (const h of webhookHooks) {
    const owner = webhookScopeOwners.get(h.scope);
    if (owner) {
      throw new Error(
        `[extension-manifest] duplicate webhook hook "${h.scope}" (${owner} and ${h.packageName})`,
      );
    }
    webhookScopeOwners.set(h.scope, h.packageName);
  }

  // Chat-widget modules: an extension OPTS IN to the chat widget/wizard surface
  // by shipping src/widgets/index.ts (WidgetDefinition[] + components). It MUST
  // then also ship src/widgets/manifest.ts (the pure-data WidgetManifest, no
  // React) — server surfaces that only need metadata (the chat API route's
  // wizard-manifest registry) load the manifest module and must never import
  // the component graph, while the RSC chat mount loads the component module.
  // FAIL CLOSED at generation: a component module without the manifest split
  // would silently fall off the server-side wizard surface, and a manifest
  // wizard step naming a widget the package does not define would advertise a
  // wizard the chat surface cannot render. The route-handler path loads ONLY
  // the manifest module (never the component graph), so this pairing defect
  // must be caught HERE — generation is where the pair is frozen into the
  // build by the literal import maps.
  const chatWidgetModules = records
    .filter((r) => fileExists(join(r.sourceDir, "src/widgets/index.ts")))
    .map((r) => {
      if (!fileExists(join(r.sourceDir, "src/widgets/manifest.ts"))) {
        throw new Error(
          `[extension-manifest] ${r.packageName} ships src/widgets/index.ts (chat widgets) ` +
            `without src/widgets/manifest.ts — the pure-data manifest split is required ` +
            `(route-handler bundles must not import the widget component graph)`,
        );
      }
      assertManifestWidgetIdsCovered(
        readFileSync(join(REPO_ROOT, r.sourceDir, "src/widgets/manifest.ts"), "utf8"),
        readFileSync(join(REPO_ROOT, r.sourceDir, "src/widgets/index.ts"), "utf8"),
        `${r.packageName} src/widgets`,
      );
      return { packageName: r.packageName, resolution: r.resolution };
    })
    .sort((a, b) => a.packageName.localeCompare(b.packageName));

  // FAIL-CLOSED system-extension coverage (cinatra#35 / IOC-43): the
  // host-owned `cinatra.systemExtensions` declaration (root package.json) is
  // the data source for the locked system set
  // (packages/extensions/src/system-extension-inventory.ts). Every declared
  // entry must resolve to a generated-manifest record — a typo'd or removed
  // package would otherwise silently never boot-lock. The declaration itself
  // is required (the lock set must never be implicitly empty).
  // (declaredSystem is read + validated at the top of this function — it also
  // keys the generator-owned `resolution` classification.)
  const recordNames = new Set(records.map((r) => r.packageName));
  const unknownSystem = declaredSystem.filter((name) => !recordNames.has(name));
  if (unknownSystem.length > 0) {
    throw new Error(
      `[extension-manifest] cinatra.systemExtensions entries missing from the generated manifest: ${unknownSystem.join(", ")}`,
    );
  }

  // Agent UI bindings + role bindings (cinatra#151 Stage 5): collected from
  // every present extension's `cinatra.fieldRenderers` / `cinatra.roles`
  // manifest metadata and validated FAIL-CLOSED via the shared validator
  // (agent-binding-kinds.mjs) — an invalid or conflicting declaration is a
  // generation error, so nothing invalid can ever become byte-pinned exempt
  // generated data. Presence-aware like every other map: only on-disk
  // packages contribute (the runtime collector in
  // packages/agents/src/field-renderer-bindings.server.ts covers packages
  // installed AFTER build with the same validator, skip-warn).
  const bindingErrors = [];
  const allFieldRendererEntries = [];
  const roleDeclarations = [];
  for (const r of records) {
    const cin = readCinatraManifest(r.sourceDir);
    const { entries, errors } = validateFieldRendererDeclarations(r.packageName, cin.fieldRenderers);
    bindingErrors.push(...errors);
    allFieldRendererEntries.push(...entries);
    if (cin.roles !== undefined) {
      roleDeclarations.push({ packageName: r.packageName, roles: cin.roles });
    }
  }
  const { merged: agentFieldRendererBindings, errors: mergeErrors } =
    mergeFieldRendererBindings(allFieldRendererEntries);
  const { roles: agentRoleBindings, errors: roleErrors } =
    mergeRoleDeclarations(roleDeclarations);
  bindingErrors.push(...mergeErrors, ...roleErrors);

  // Semantic-floor artifact binding (cinatra#151 Stage 6). The floor type is
  // STRUCTURAL — every artifact carries it as the eligible fallback, so its
  // role claim must exist in EVERY universe: exactly one claimant (the
  // single-claimant rule in mergeRoleDeclarations already rejects two) and
  // that claimant MUST be a cinatra.systemExtensions member (present in
  // every universe by the required lock). Fail-closed: a missing or
  // non-system claimant is a generation error, never a silent omission.
  const floorClaimant = agentRoleBindings[ARTIFACT_DEFAULT_FLOOR_ROLE];
  if (typeof floorClaimant !== "string" || floorClaimant.length === 0) {
    bindingErrors.push(
      `no present extension claims the "${ARTIFACT_DEFAULT_FLOOR_ROLE}" role — the semantic floor artifact type is structural (declare cinatra.roles: ["${ARTIFACT_DEFAULT_FLOOR_ROLE}"] on the floor artifact extension)`,
    );
  } else if (!systemSet.has(floorClaimant)) {
    bindingErrors.push(
      `the "${ARTIFACT_DEFAULT_FLOOR_ROLE}" claimant ${floorClaimant} is not a cinatra.systemExtensions member — the floor type must be present in every universe`,
    );
  }
  if (bindingErrors.length > 0) {
    throw new Error(
      `[extension-manifest] invalid extension binding / role declarations:\n  - ${bindingErrors.join("\n  - ")}`,
    );
  }

  return {
    records,
    connectorSetupPages,
    connectorSettingsPages,
    connectorSkillsSettingsTabs,
    connectorEntryModules,
    connectorMcpModules,
    connectorPrimitiveHandlers,
    externalMcpToolboxes,
    widgetStreamAgents,
    webhookHooks,
    chatWidgetModules,
    agentFieldRendererBindings,
    agentRoleBindings,
    artifactFloorClaimant: floorClaimant,
  };
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------
const HEADER = (script) =>
  `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
  `// Regenerate: node ${script}\n` +
  `// CONSUMED: the host's runtime source of truth for the connector surfaces —\n` +
  `// setup/settings-page loading, connector entry modules, and serverEntry\n` +
  `// activation resolve from these generated maps. The dev-watcher readdir scan\n` +
  `// remains the registration source for filesystem-loaded extension kinds;\n` +
  `// parity is checked against the connector catalog descriptors.\n`;

// Emit one `{ resolution, load, ... }` loader entry. The import specifier is a
// LITERAL string in BOTH branches (Turbopack only statically bundles literal
// dynamic imports — this helper never computes a specifier):
//   - guardedOptional → the loader routes through guardedExtensionImport (the
//     standardized degraded-result path: post-build absence resolves to a
//     degraded `absent` result the consuming surface degrades on per entry);
//   - required        → a plain unguarded import (absence stays a loud throw,
//     preserving the required-extension fail-loud contract).
// `extra` (e.g. `factory: "createXModule"`) is spliced verbatim after `load`.
function emitLoaderEntry(resolution, spec, extra = "") {
  const load =
    resolution === "guardedOptional"
      ? `guardedExtensionImport(${JSON.stringify(spec)}, () => import(${JSON.stringify(spec)}))`
      : `() => import(${JSON.stringify(spec)})`;
  return `{ resolution: ${JSON.stringify(resolution)}, load: ${load}${extra} }`;
}

// Prepend the guard import ONLY when at least one emitted loader is guarded —
// an unused value import would trip noUnusedLocals in presence universes
// where every emitted extension is a system (required) one.
function guardImportFor(body) {
  return body.includes("guardedExtensionImport(")
    ? `import { guardedExtensionImport } from "../extension-load-guard";
`
    : "";
}

function emitServer(records, connectorEntryModules, connectorMcpModules, connectorPrimitiveHandlers, externalMcpToolboxes, widgetStreamAgents, chatWidgetModules) {  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const body = records
    .map(
      (r) =>
        `  ${JSON.stringify(r.packageName)}: ${JSON.stringify(
          {
            packageName: r.packageName,
            scope: r.scope,
            kind: r.kind,
            version: r.version,
            sourceDir: r.sourceDir,
            serverEntry: r.serverEntry,
            hasOas: r.hasOas,
            hasMcpModule: r.hasMcpModule,
            hasSetupPage: r.hasSetupPage,
            hasSettingsPage: r.hasSettingsPage,
            uiSurface: r.uiSurface,
            configSchema: r.configSchema,
            requestedHostPorts: r.requestedHostPorts,
            providesExternalMcpToolbox: r.providesExternalMcpToolbox,
            sdkAbiRange: r.sdkAbiRange,
            dependencies: r.dependencies,
            displayName: r.displayName,
            logo: r.logo,
            vendor: r.vendor,
            resolution: r.resolution,
          },
        )},`,
    )
    .join("\n");
  // Literal dynamic-import map for records that declare a serverEntry. MUST be
  // literal `import("<pkg><subpath>")` strings (NOT computed) — Turbopack can
  // only statically bundle literal dynamic imports (same rule as the connector
  // setup-page map). The StaticBundleLoader consumes this to import + activate
  // a register(ctx)-shaped extension.
  const serverEntries = records
    .filter((r) => typeof r.serverEntry === "string" && r.serverEntry.length > 0)
    .map((r) => {
      // serverEntry "./register" → import specifier "<pkg>/register"
      const spec = r.packageName + r.serverEntry.replace(/^\./, "");
      return `  ${JSON.stringify(r.packageName)}: ${emitLoaderEntry(r.resolution, spec)},`;
    })
    .join("\n");
  // Connector entry-module loader map: slug → dynamic import of the connector
  // package root. Same literal-specifier rule as the server-entry map. The host
  // resolves bundled-connector server modules (status/config/action exports)
  // through this map, keyed by slug, instead of naming connector packages.
  const entryModules = connectorEntryModules
    .map((p) => `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, p.packageName)},`)
    .join("\n");
  // Connector MCP capability-module loader map: slug → { literal dynamic import
  // of <pkg>/mcp-module, factory export name }. Consumed by
  // src/lib/connector-mcp-registration.server.ts — the host registers connector
  // MCP modules from this map instead of importing them by package name.
  const mcpModules = connectorMcpModules
    .map(
      (p) =>
        `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/mcp-module`, `, factory: ${JSON.stringify(p.factory)}`)},`,
    )
    .join("\n");
  // Connector primitive-handler loader map: slug → { literal dynamic import of
  // <pkg>/mcp-handlers, factory export name }. Consumed by
  // src/lib/connector-mcp-registration.server.ts for the in-process
  // primitive-handler capture.
  const primitiveHandlers = connectorPrimitiveHandlers
    .map(
      (p) =>
        `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/mcp-handlers`, `, factory: ${JSON.stringify(p.factory)}`)},`,
    )
    .join("\n");
  // External-MCP toolbox loader map: slug → { literal dynamic import of
  // <pkg>/mcp-toolbox, factory export name }. Consumed by
  // src/lib/external-mcp-toolbox-loader.server.ts — the LLM toolbox-injection
  // path resolves first-party external-MCP builders from this map instead of
  // importing them by package name.
  const mcpToolboxes = externalMcpToolboxes
    .map(
      (p) =>
        `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/mcp-toolbox`, `, factory: ${JSON.stringify(p.factory)}`)},`,
    )
    .join("\n");
  // Widget-stream agent map: agentSlug → { literal dynamic import of
  // <pkg>/widget-chat-tool, factory export name, declared stream metadata }.
  // Consumed by src/lib/widget-stream-agents.server.ts — the host's
  // /api/agents/[agentSlug]/stream route resolves widget agents from this map
  // instead of branching on hardcoded slugs / importing connectors by name.
  const widgetAgents = widgetStreamAgents
    .map((w) => {
      const meta = {
        packageName: w.packageName,
        factory: w.factory,
        label: w.label,
        subjectNoun: w.subjectNoun,
        skillCapability: w.skillCapability,
        relayAgentPackage: w.relayAgentPackage,
        contextFields: w.contextFields,
        auth: w.auth,
      };
      const metaJson = JSON.stringify(meta).slice(1, -1); // splice resolution/load into the object literal
      const spec = `${w.packageName}/widget-chat-tool`;
      const load =
        w.resolution === "guardedOptional"
          ? `guardedExtensionImport(${JSON.stringify(spec)}, () => import(${JSON.stringify(spec)}))`
          : `() => import(${JSON.stringify(spec)})`;
      return `  ${JSON.stringify(w.agentSlug)}: { resolution: ${JSON.stringify(w.resolution)}, load: ${load}, ${metaJson} },`;
    })
    .join("\n");
  // Chat-widget loader maps: packageName → literal dynamic import of the
  // component module (src/widgets/index.ts — RSC chat mount only) and of the
  // pure-data manifest module (src/widgets/manifest.ts — safe in any server
  // bundle, including route handlers). Same literal-specifier rule as the other
  // maps. Presence in these maps IS the widget-bearing flag; both are consumed
  // by src/lib/chat-widget-catalog.server.ts, keyed by packageName so the
  // extension lifecycle (archived-tombstone gate) applies directly.
  const chatWidgets = chatWidgetModules
    .map((p) => `  ${JSON.stringify(p.packageName)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/widgets`)},`)
    .join("\n");
  const chatWidgetManifests = chatWidgetModules
    .map((p) => `  ${JSON.stringify(p.packageName)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/widgets/manifest`)},`)    .join("\n");
  const loaderBodies = [
    serverEntries,
    entryModules,
    mcpModules,
    primitiveHandlers,
    mcpToolboxes,
    widgetAgents,
    chatWidgets,
    chatWidgetManifests,
  ].join("\n");
  return (
    `${HEADER(script)}import "server-only";\n` +
    guardImportFor(loaderBodies) +
    `import type { NormalizedExtensionRecord, ExtensionResolution } from "@cinatra-ai/sdk-extensions";\n\n` +
    `export const STATIC_EXTENSION_MANIFEST: Record<string, NormalizedExtensionRecord> = {\n` +
    `${body}\n};\n\n` +
    `export const STATIC_EXTENSION_RECORDS: NormalizedExtensionRecord[] =\n` +
    `  Object.values(STATIC_EXTENSION_MANIFEST);\n\n` +
    `// Every loader-map entry below carries the generator-owned presence\n` +
    `// classification: resolution "required" (cinatra.systemExtensions member —\n` +
    `// unguarded import, absence fails loudly) | "guardedOptional" (loader\n` +
    `// routes through the standardized degraded-result guard,\n` +
    `// src/lib/extension-load-guard.ts — post-build absence degrades per entry).\n` +
    `// Downstream gates key EXCLUSIVELY on this field (missing/unknown ⇒\n` +
    `// required, fail-closed).\n` +
    `export type GeneratedExtensionLoaderEntry = {\n` +
    `  resolution: ExtensionResolution;\n` +
    `  load: () => Promise<unknown>;\n` +
    `};\n\n` +
    `// package → { resolution, server-entry loader } (register(ctx) module).\n` +
    `// Literal specifiers only (Turbopack-safe). Populated for extensions that\n` +
    `// declare cinatra.serverEntry.\n` +
    `export const GENERATED_EXTENSION_SERVER_ENTRIES: Record<string, GeneratedExtensionLoaderEntry> = {\n` +
    `${serverEntries}\n};\n\n` +
    `// connector slug → { resolution, loader } of the connector package root\n` +
    `// module. Literal specifiers only (Turbopack-safe). Consumed by\n` +
    `// src/lib/connector-modules.server.ts.\n` +
    `export const GENERATED_CONNECTOR_ENTRY_MODULES: Record<string, GeneratedExtensionLoaderEntry> = {\n` +
    `${entryModules}\n};\n\n` +
    `// slug → { resolution, loader, factory export name } for connector MCP\n` +
    `// surfaces. Literal specifiers only (Turbopack-safe). Consumed by\n` +
    `// src/lib/connector-mcp-registration.server.ts.\n` +
    `export type GeneratedConnectorFactoryEntry = {\n` +
    `  resolution: ExtensionResolution;\n` +
    `  load: () => Promise<unknown>;\n` +
    `  factory: string;\n` +
    `};\n\n` +
    `export const GENERATED_CONNECTOR_MCP_MODULES: Record<string, GeneratedConnectorFactoryEntry> = {\n` +
    `${mcpModules}\n};\n\n` +
    `export const GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: Record<string, GeneratedConnectorFactoryEntry> = {\n` +
    `${primitiveHandlers}\n};\n\n` +
    `// slug → { loader, factory export name } for extension external-MCP toolbox\n` +
    `// builders (records declaring providesExternalMcpToolbox that ship a\n` +
    `// first-party toolbox module). Literal specifiers only (Turbopack-safe).\n` +
    `// Consumed by src/lib/external-mcp-toolbox-loader.server.ts.\n` +
    `export const GENERATED_EXTERNAL_MCP_TOOLBOXES: Record<string, GeneratedConnectorFactoryEntry> = {\n` +
    `${mcpToolboxes}\n};\n\n` +
    `// agentSlug → widget-stream agent entry (declared via cinatra.widgetStream).\n` +
    `// Literal specifiers only (Turbopack-safe). Consumed by\n` +
    `// src/lib/widget-stream-agents.server.ts — the host stream route resolves\n` +
    `// widget agents from this map; it never names a connector package.\n` +
    `export type GeneratedWidgetStreamContextField = { key: string; maxLength: number };\n` +
    `export type GeneratedWidgetStreamAuth = {\n` +
    `  tokenConfigKey: string;\n` +
    `  instancesConfigKey: string;\n` +
    `  requiredInstanceFields: string[];\n` +
    `  // cinatra#408 — the stream route REQUIRES a per-user cwu_ token BY DEFAULT\n` +
    `  // (a missing token is a fail-closed 401 re-login). This is the security\n` +
    `  // default for the interactive public_site_widget surface: an absent flag\n` +
    `  // (undefined) ENFORCES. Only an EXPLICIT \`false\` opts out (audited).\n` +
    `  requireUserToken?: boolean;\n` +
    `};\n` +
    `export type GeneratedWidgetStreamAgentEntry = {\n` +
    `  resolution: ExtensionResolution;\n` +
    `  load: () => Promise<unknown>;\n` +
    `  packageName: string;\n` +
    `  factory: string;\n` +
    `  label: string;\n` +
    `  subjectNoun: string;\n` +
    `  skillCapability: string;\n` +
    `  relayAgentPackage?: string;\n` +
    `  contextFields: GeneratedWidgetStreamContextField[];\n` +
    `  auth: GeneratedWidgetStreamAuth;\n` +
    `};\n\n` +
    `export const GENERATED_WIDGET_STREAM_AGENTS: Record<string, GeneratedWidgetStreamAgentEntry> = {\n` +
    `${widgetAgents}\n};\n` +
    `\n` +
    `// packageName → { resolution, loader } of the chat-widget COMPONENT module\n` +
    `// (src/widgets/index.ts). Literal specifiers only (Turbopack-safe). RSC\n` +
    `// consumers only (the chat mount) — the module graph includes "use client"\n` +
    `// components. Consumed by src/lib/chat-widget-catalog.server.ts.\n` +
    `export const GENERATED_CHAT_WIDGET_MODULES: Record<string, GeneratedExtensionLoaderEntry> = {\n` +
    `${chatWidgets}\n};\n\n` +
    `// packageName → { resolution, loader } of the chat-widget MANIFEST module\n` +
    `// (src/widgets/manifest.ts — pure data, no React). Safe in ANY server\n` +
    `// bundle, including route handlers (the chat runner's wizard-manifest\n` +
    `// registry). Consumed by src/lib/chat-widget-catalog.server.ts.\n` +
    `export const GENERATED_CHAT_WIDGET_MANIFEST_MODULES: Record<string, GeneratedExtensionLoaderEntry> = {\n` +
    `${chatWidgetManifests}\n};\n`
  );
}

// Slug-only public-path list for the widget-stream route. SEPARATE generated
// file with ZERO imports and no package identifiers: it is consumed by
// src/lib/auth-route-guard.ts, which runs in the proxy bundle (src/proxy.ts) —
// importing extensions.server.ts there would drag `server-only` + every
// connector loader into the proxy.
function emitWidgetStreamPublicPaths(widgetStreamAgents) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const list = (suffix) =>
    widgetStreamAgents
      .map((w) => `  ${JSON.stringify(`/api/agents/${w.agentSlug}/${suffix}`)},`)
      .join("\n");
  const streamBody = list("stream");
  const tokenBody = list("token");
  const capabilityBody = list("capabilities");
  return (
    `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
    `// Regenerate: node ${script}\n` +
    `// Widget-public agent paths (one per cinatra.widgetStream declaration).\n` +
    `// Slug-only data — NO imports, NO package identifiers (proxy-bundle safe).\n` +
    `// Consumed by src/lib/auth-route-guard.ts: these paths skip the sign-in\n` +
    `// redirect; each route itself enforces its own auth:\n` +
    `//   - stream: Origin allowlist + Bearer token (short-lived cit_ or legacy);\n` +
    `//   - token:  server-to-server long-lived-key auth (token exchange);\n` +
    `//   - capabilities: AUTH-FREE static contract metadata only.\n` +
    `// Each list is the EXACT slug paths (never an /api/agents prefix).\n` +
    `export const GENERATED_WIDGET_STREAM_PUBLIC_PATHS: readonly string[] = [\n` +
    `${streamBody}\n];\n` +
    `\n` +
    `export const GENERATED_WIDGET_STREAM_TOKEN_PATHS: readonly string[] = [\n` +
    `${tokenBody}\n];\n` +
    `\n` +
    `export const GENERATED_WIDGET_STREAM_CAPABILITY_PATHS: readonly string[] = [\n` +
    `${capabilityBody}\n];\n`  );
}

// Inbound-webhook handler dispatch map (cinatra#340): "<vendor>/<slug>/<hook>"
// → { resolution, literal dynamic-import loader of the connector's handler
// module, factory export name, declared metadata }. SEPARATE server-only file
// (mirrors the rest of the generated server maps) consumed by
// src/lib/webhook-registry.server.ts — the host's generic /webhook route
// resolves a hook from this map; it never names a connector package or branches
// on vendor/slug. INERT until #343 (no extension declares cinatra.webhooks yet,
// so the map is {} and every /webhook request 404s safely). Same literal-
// specifier rule the other loader maps use (Turbopack only bundles literal
// dynamic imports), with the same per-entry resolution classification (pinned
// by the generated guarded-optional-loaders test).
function emitWebhooksServer(webhookHooks) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const body = webhookHooks
    .map((h) => {
      const meta = {
        packageName: h.packageName,
        factory: h.factory,
        vendor: h.vendor,
        slug: h.slug,
        hook: h.hook,
        label: h.label,
        ...(Number.isInteger(h.rejectStatus) ? { rejectStatus: h.rejectStatus } : {}),
        ...(Number.isInteger(h.schemaVersion) ? { schemaVersion: h.schemaVersion } : {}),
      };
      const metaJson = JSON.stringify(meta).slice(1, -1);
      const spec = h.specifier;
      const load =
        h.resolution === "guardedOptional"
          ? `guardedExtensionImport(${JSON.stringify(spec)}, () => import(${JSON.stringify(spec)}))`
          : `() => import(${JSON.stringify(spec)})`;
      return `  ${JSON.stringify(h.scope)}: { resolution: ${JSON.stringify(h.resolution)}, load: ${load}, ${metaJson} },`;
    })
    .join("\n");
  return (
    `${HEADER(script)}import "server-only";\n` +
    guardImportFor(body) +
    `import type { ExtensionResolution } from "@cinatra-ai/sdk-extensions";\n\n` +
    `// "<vendor>/<slug>/<hook>" → inbound-webhook handler entry. The route\n` +
    `// resolves the hook generically (it never names a connector package);\n` +
    `// rejectStatus (when declared) overrides the default 204 for a \`rejected\`\n` +
    `// handler outcome.\n` +
    `export type GeneratedWebhookHandlerEntry = {\n` +
    `  resolution: ExtensionResolution;\n` +
    `  load: () => Promise<unknown>;\n` +
    `  packageName: string;\n` +
    `  factory: string;\n` +
    `  vendor: string;\n` +
    `  slug: string;\n` +
    `  hook: string;\n` +
    `  label: string;\n` +
    `  rejectStatus?: number;\n` +
    `  schemaVersion?: number;\n` +
    `};\n\n` +
    `export const GENERATED_WEBHOOK_HANDLERS: Record<string, GeneratedWebhookHandlerEntry> = {\n` +
    `${body}\n};\n`
  );
}

// Slug-only public-path PREFIX list for the generic webhook route (cinatra#340).
// SEPARATE generated file with ZERO imports and no package identifiers — it is
// the registry/UI source of truth for the declared "/webhook/<vendor>/<slug>/
// <hook>" prefixes (one per hook). NOTE: this is NOT the auth-exemption list —
// the auth-route-guard exempts the whole "/webhook" namespace by a single
// static prefix (the route owns the declared/undeclared 404 verdict). Inert
// until #343 (empty array until an extension declares cinatra.webhooks).
function emitWebhookPublicPaths(webhookHooks) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const body = webhookHooks
    .map((h) => `  ${JSON.stringify(`/webhook/${h.vendor}/${h.slug}/${h.hook}`)},`)
    .join("\n");
  return (
    `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
    `// Regenerate: node ${script}\n` +
    `// Declared inbound-webhook path prefixes (one per cinatra.webhooks hook,\n` +
    `// cinatra#340). Slug-only data — NO imports, NO package identifiers.\n` +
    `// This is the registry/UI source of truth + the route's DISPATCH allowlist,\n` +
    `// NOT the auth-exemption list (auth-route-guard exempts the whole /webhook\n` +
    `// namespace; the route owns the declared/undeclared 404 verdict). Inert\n` +
    `// until #343 (empty until an extension declares cinatra.webhooks).\n` +
    `export const GENERATED_WEBHOOK_PUBLIC_PREFIXES: readonly string[] = [\n` +
    `${body}\n];\n`
  );
}

// Import-free hook metadata for the #342 registry/nav UI (cinatra#340): no
// loaders (server loaders stay in webhooks.server.ts), just the declared
// vendor/slug/hook/label per hook. Safe in any bundle (pure data).
function emitWebhookRegistryMeta(webhookHooks) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const body = webhookHooks
    .map((h) =>
      `  ${JSON.stringify(
        {
          scope: h.scope,
          vendor: h.vendor,
          slug: h.slug,
          hook: h.hook,
          label: h.label,
          ...(Number.isInteger(h.rejectStatus) ? { rejectStatus: h.rejectStatus } : {}),
          ...(Number.isInteger(h.schemaVersion) ? { schemaVersion: h.schemaVersion } : {}),
        },
      )},`,
    )
    .join("\n");
  return (
    `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
    `// Regenerate: node ${script}\n` +
    `// Inbound-webhook registry metadata (one per cinatra.webhooks hook,\n` +
    `// cinatra#340). Import-free pure data for the #342 registry/nav UI — NO\n` +
    `// loaders (server loaders live in webhooks.server.ts). Inert until #343.\n` +
    `export type GeneratedWebhookRegistryMeta = {\n` +
    `  scope: string;\n` +
    `  vendor: string;\n` +
    `  slug: string;\n` +
    `  hook: string;\n` +
    `  label: string;\n` +
    `  rejectStatus?: number;\n` +
    `  schemaVersion?: number;\n` +
    `};\n\n` +
    `export const GENERATED_WEBHOOK_REGISTRY_META: readonly GeneratedWebhookRegistryMeta[] = [\n` +
    `${body}\n];\n`
  );
}

function emitConnectorSetupPages(setupPages, settingsPages, skillsSettingsTabs = []) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const setupBody = setupPages
    .map((p) => `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/setup-page`)},`)
    .join("\n");
  const settingsBody = settingsPages
    .map((p) => `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/settings-page`)},`)
    .join("\n");
  const skillsTabsBody = skillsSettingsTabs
    .map((p) => `  ${JSON.stringify(p.slug)}: ${emitLoaderEntry(p.resolution, `${p.packageName}/skills-settings-page`)},`)
    .join("\n");
  return (
    `${HEADER(script)}import "server-only";\n` +
    guardImportFor(`${setupBody}\n${settingsBody}\n${skillsTabsBody}`) +
    `import type { ExtensionResolution } from "@cinatra-ai/sdk-extensions";\n\n` +
    `// Literal dynamic-import maps (Turbopack rejects computed import templates).\n` +
    `// Consumed by src/lib/connector-setup-pages.ts as the loader source of truth.\n` +
    `// Each entry carries the generator-owned presence classification\n` +
    `// (resolution; see src/lib/extension-load-guard.ts) — guardedOptional page\n` +
    `// loaders resolve a standardized degraded result on post-build absence,\n` +
    `// which the dispatch surface renders as its "requires rebuild" state.\n` +
    `export type GeneratedPageLoader = () => Promise<unknown>;\n\n` +
    `export type GeneratedPageEntry = {\n` +
    `  resolution: ExtensionResolution;\n` +
    `  load: GeneratedPageLoader;\n` +
    `};\n\n` +
    `export const GENERATED_CONNECTOR_SETUP_PAGES: Record<string, GeneratedPageEntry> = {\n` +
    `${setupBody}\n};\n\n` +
    `export const GENERATED_CONNECTOR_SETTINGS_PAGES: Record<string, GeneratedPageEntry> = {\n` +
    `${settingsBody}\n};\n\n` +
    `// Conventional skills-settings tab modules (a connector contributing a tab\n` +
    `// to /configuration/skills ships src/skills-settings-page.tsx exporting\n` +
    `// SkillsSettingsTabContent). Consumed generically by the host skills page;\n` +
    `// an absent/degraded entry renders its "extension unavailable" note.\n` +
    `export const GENERATED_CONNECTOR_SKILLS_SETTINGS_TABS: Record<string, GeneratedPageEntry> = {\n` +
    `${skillsTabsBody}\n};\n`
  );
}

// The GENERATED guarded-optional-loaders test (cinatra#7). Emitted
// alongside the maps so the concrete entry list below can never drift from
// the emitted set (`--check` pins this file byte-exact with the maps; the
// completeness assertion inside additionally fails if any map gains an entry
// the list does not cover). It proves, per emitted entry, that the
// generator-owned classification holds at RUNTIME shape level:
//   - every `guardedOptional` loader routes through the standardized
//     degraded-result guard (brand check — guard-owned marking, never
//     source-shape inference);
//   - every `required` loader is UNGUARDED (absence must stay a loud failure).
// The guard's degradation behavior itself (absent → degraded result; broken
// present module → rethrow) is pinned by the hand-written unit test
// src/lib/__tests__/extension-load-guard.test.ts.
function emitGuardedOptionalLoadersTest({
  records,
  connectorEntryModules,
  connectorMcpModules,
  connectorPrimitiveHandlers,
  externalMcpToolboxes,
  widgetStreamAgents,
  webhookHooks,
  chatWidgetModules,
  connectorSetupPages,
  connectorSettingsPages,
  connectorSkillsSettingsTabs,
}) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const expected = [];
  for (const r of records) {
    if (typeof r.serverEntry === "string" && r.serverEntry.length > 0) {
      expected.push(["GENERATED_EXTENSION_SERVER_ENTRIES", r.packageName, r.resolution]);
    }
  }
  for (const p of connectorEntryModules) expected.push(["GENERATED_CONNECTOR_ENTRY_MODULES", p.slug, p.resolution]);
  for (const p of connectorMcpModules) expected.push(["GENERATED_CONNECTOR_MCP_MODULES", p.slug, p.resolution]);
  for (const p of connectorPrimitiveHandlers) expected.push(["GENERATED_CONNECTOR_PRIMITIVE_HANDLERS", p.slug, p.resolution]);
  for (const p of externalMcpToolboxes) expected.push(["GENERATED_EXTERNAL_MCP_TOOLBOXES", p.slug, p.resolution]);
  for (const w of widgetStreamAgents) expected.push(["GENERATED_WIDGET_STREAM_AGENTS", w.agentSlug, w.resolution]);
  for (const h of webhookHooks) expected.push(["GENERATED_WEBHOOK_HANDLERS", h.scope, h.resolution]);
  for (const p of chatWidgetModules) {
    expected.push(["GENERATED_CHAT_WIDGET_MODULES", p.packageName, p.resolution]);
    expected.push(["GENERATED_CHAT_WIDGET_MANIFEST_MODULES", p.packageName, p.resolution]);
  }
  for (const p of connectorSetupPages) expected.push(["GENERATED_CONNECTOR_SETUP_PAGES", p.slug, p.resolution]);
  for (const p of connectorSettingsPages) expected.push(["GENERATED_CONNECTOR_SETTINGS_PAGES", p.slug, p.resolution]);
  for (const p of connectorSkillsSettingsTabs) expected.push(["GENERATED_CONNECTOR_SKILLS_SETTINGS_TABS", p.slug, p.resolution]);
  const expectedBody = expected
    .map(([map, key, resolution]) => `  { map: ${JSON.stringify(map)}, key: ${JSON.stringify(key)}, resolution: ${JSON.stringify(resolution)} },`)
    .join("\n");
  return (
    `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
    `// Regenerate: node ${script}\n` +
    `// Generated TEST: pins the generator-owned per-entry resolution\n` +
    `// classification of every loader map entry. guardedOptional loaders MUST\n` +
    `// route through the standardized degraded-result guard\n` +
    `// (src/lib/extension-load-guard.ts brand); required loaders MUST stay\n` +
    `// unguarded. Downstream gates trust ONLY this generator-owned\n` +
    `// classification (missing/unknown ⇒ required, fail-closed).\n` +
    `import { describe, expect, it } from "vitest";\n\n` +
    `import { isGuardedExtensionLoader } from "../../extension-load-guard";\n` +
    `import {\n` +
    `  GENERATED_EXTENSION_SERVER_ENTRIES,\n` +
    `  GENERATED_CONNECTOR_ENTRY_MODULES,\n` +
    `  GENERATED_CONNECTOR_MCP_MODULES,\n` +
    `  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS,\n` +
    `  GENERATED_EXTERNAL_MCP_TOOLBOXES,\n` +
    `  GENERATED_WIDGET_STREAM_AGENTS,\n` +
    `  GENERATED_CHAT_WIDGET_MODULES,\n` +
    `  GENERATED_CHAT_WIDGET_MANIFEST_MODULES,\n` +
    `} from "../extensions.server";\n` +
    `import { GENERATED_WEBHOOK_HANDLERS } from "../webhooks.server";\n` +
    `import {\n` +
    `  GENERATED_CONNECTOR_SETUP_PAGES,\n` +
    `  GENERATED_CONNECTOR_SETTINGS_PAGES,\n` +
    `  GENERATED_CONNECTOR_SKILLS_SETTINGS_TABS,\n` +
    `} from "../connector-setup-pages";\n\n` +
    `const MAPS: Record<string, Record<string, { resolution: string; load: unknown }>> = {\n` +
    `  GENERATED_EXTENSION_SERVER_ENTRIES,\n` +
    `  GENERATED_CONNECTOR_ENTRY_MODULES,\n` +
    `  GENERATED_CONNECTOR_MCP_MODULES,\n` +
    `  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS,\n` +
    `  GENERATED_EXTERNAL_MCP_TOOLBOXES,\n` +
    `  GENERATED_WIDGET_STREAM_AGENTS,\n` +
    `  GENERATED_WEBHOOK_HANDLERS,\n` +
    `  GENERATED_CHAT_WIDGET_MODULES,\n` +
    `  GENERATED_CHAT_WIDGET_MANIFEST_MODULES,\n` +
    `  GENERATED_CONNECTOR_SETUP_PAGES,\n` +
    `  GENERATED_CONNECTOR_SETTINGS_PAGES,\n` +
    `  GENERATED_CONNECTOR_SKILLS_SETTINGS_TABS,\n` +
    `};\n\n` +
    `const EXPECTED: ReadonlyArray<{ map: string; key: string; resolution: "required" | "guardedOptional" }> = [\n` +
    `${expectedBody}\n];\n\n` +
    `describe("generated guarded-optional loaders", () => {\n` +
    `  it("is non-vacuous — the presence universe yields at least one pinned loader entry", () => {\n` +
    `    // Anti-vacuity (fail-closed): an emission with ZERO loader entries can\n` +
    `    // never satisfy this suite. Every supported presence universe ships at\n` +
    `    // least the system (required) connector surface, so an empty EXPECTED\n` +
    `    // list means a gutted emission, not a legitimate universe.\n` +
    `    expect(EXPECTED.length).toBeGreaterThan(0);\n` +
    `  });\n\n` +
    `  it("covers every emitted loader entry (completeness)", () => {\n` +
    `    for (const [name, map] of Object.entries(MAPS)) {\n` +
    `      const expectedKeys = EXPECTED.filter((e) => e.map === name).map((e) => e.key).sort();\n` +
    `      expect(Object.keys(map).sort(), name).toEqual(expectedKeys);\n` +
    `    }\n` +
    `  });\n\n` +
    `  it("routes every guardedOptional loader through the standardized guard and leaves required loaders unguarded", () => {\n` +
    `    for (const e of EXPECTED) {\n` +
    `      const entry = MAPS[e.map][e.key];\n` +
    `      const at = \`\${e.map}[\"\${e.key}\"]\`;\n` +
    `      expect(entry, at).toBeTruthy();\n` +
    `      expect(entry.resolution, at).toBe(e.resolution);\n` +
    `      expect(isGuardedExtensionLoader(entry.load), at).toBe(e.resolution === "guardedOptional");\n` +
    `    }\n` +
    `  });\n` +
    `});\n`
  );
}

function emitClient() {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  return (
    `${HEADER(script)}"use client";\n\n` +
    `import type { ComponentType } from "react";\n\n` +
    `// TRUE client widgets only (no server-only). Connector setup/settings pages\n` +
    `// are server components loaded via connector-setup-pages.ts, NOT here.\n` +
    `// Populated as extensions expose genuine client widgets (currently none).\n` +
    `export const GENERATED_CLIENT_WIDGETS: Record<string, ComponentType<unknown>> = {};\n`
  );
}

// Agent UI bindings + agent role bindings (cinatra#151 Stage 5). Pure DATA,
// no imports — consumable from BOTH the client renderer registry path
// (packages/agents/src/register-default-renderers.ts via field-renderer-init)
// and server code (role resolution, a2ui translator wiring). Validated
// fail-closed at generation by the shared validator
// (scripts/extensions/agent-binding-kinds.mjs).
function emitAgentBindings(fieldRendererBindings, roleBindings) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const entryLines = fieldRendererBindings
    .map((b) => {
      const parts = [
        `id: ${JSON.stringify(b.id)}`,
        `kind: ${JSON.stringify(b.kind)}`,
        `priority: ${b.priority}`,
      ];
      if (b.midRunHitl === true) parts.push("midRunHitl: true");
      if (b.a2uiTranslator !== undefined) parts.push(`a2uiTranslator: ${JSON.stringify(b.a2uiTranslator)}`);
      if (b.params !== undefined) parts.push(`params: ${JSON.stringify(b.params)}`);
      parts.push(`declaredBy: ${JSON.stringify(b.declaredBy)}`);
      return `  { ${parts.join(", ")} },`;
    })
    .join("\n");
  const roleLines = Object.entries(roleBindings)
    .map(([role, pkg]) => `  ${JSON.stringify(role)}: ${JSON.stringify(pkg)},`)
    .join("\n");
  return (
    `${HEADER(script)}\n` +
    `// Agent UI bindings (cinatra#151 Stage 5): which x-renderer ID activates\n` +
    `// which host-neutral renderer KIND (component table:\n` +
    `// packages/agents/src/register-default-renderers.ts), plus the mid-run\n` +
    `// HITL classification, the A2UI mid-run translator kind, and optional\n` +
    `// extension-owned params. Derived from each PRESENT extension's\n` +
    `// \`cinatra.fieldRenderers\` manifest declaration (validated fail-closed —\n` +
    `// see scripts/extensions/agent-binding-kinds.mjs). Packages installed at\n` +
    `// RUNTIME (after build) contribute through the installed-package\n` +
    `// collector (packages/agents/src/field-renderer-bindings.server.ts), not\n` +
    `// this file.\n` +
    `export type GeneratedFieldRendererBinding = {\n` +
    `  readonly id: string;\n` +
    `  readonly kind: string;\n` +
    `  readonly priority: number;\n` +
    `  readonly midRunHitl?: true;\n` +
    `  readonly a2uiTranslator?: string;\n` +
    `  readonly params?: Readonly<Record<string, unknown>>;\n` +
    `  readonly declaredBy: string;\n` +
    `};\n\n` +
    `export const GENERATED_FIELD_RENDERER_BINDINGS: ReadonlyArray<GeneratedFieldRendererBinding> = [\n` +
    `${entryLines}\n` +
    `];\n\n` +
    `// Extension ROLE bindings: role name -> the single claimant package\n` +
    `// (global uniqueness enforced at generation; kind-agnostic — agents,\n` +
    `// artifacts, and workflow extensions all claim roles the same way).\n` +
    `// Roles are how host code selects an extension for a duty (the\n` +
    `// creation-review lanes, the semantic-floor artifact type, the blog\n` +
    `// artifact surfaces, the blog operator dashboard) WITHOUT naming a\n` +
    `// package: packages/agents/src/agent-roles.ts resolves fail-loud for\n` +
    `// the systemExtension-backed agent roles; src/lib/extension-roles.ts\n` +
    `// resolves the optional-surface roles (absence = a normal degraded\n` +
    `// state in reduced universes).\n` +
    `export const GENERATED_AGENT_ROLE_BINDINGS: Readonly<Record<string, string>> = {\n` +
    `${roleLines}\n` +
    `};\n`
  );
}

// Semantic-floor artifact binding (cinatra#151 Stage 6). A dedicated
// PURE-DATA file emitted INTO packages/objects (the one generated path
// outside src/lib/generated/ — see generated-manifest-files.mjs) so the
// objects package and the leaf artifact libs consume the floor constant
// without the host `@/` alias: packages/objects is reachable from
// sdk-extensions / extension-repo typecheck graphs where that alias does
// not resolve. The claimant is validated at generation: exactly one, and
// a cinatra.systemExtensions member.
function emitArtifactFloor(artifactFloorClaimant) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  // Dedicated header: the shared HEADER() text describes the connector
  // surface maps and would be misleading on this pure-data binding file.
  return (
    `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
    `// Regenerate: node ${script}\n` +
    `// The semantic FLOOR artifact type — the single manifest claimant of the\n` +
    `// "${ARTIFACT_DEFAULT_FLOOR_ROLE}" extension role (cinatra.roles), validated at\n` +
    `// generation (exactly one claimant; must be a cinatra.systemExtensions\n` +
    `// member, so it is present in EVERY universe). Pure data: importable from\n` +
    `// leaf unit-test graphs and package-internal modules alike. Consumers:\n` +
    `// packages/objects/src/semantic-manifest.ts (re-export) and the\n` +
    `// src/lib/artifacts/* floor writers via @cinatra-ai/objects/artifact-floor.\n` +
    `export const DEFAULT_ARTIFACT_EXTENSION = ${JSON.stringify(artifactFloorClaimant)};\n`
  );
}

// ---------------------------------------------------------------------------
// Parity (the catalog safety net)
// ---------------------------------------------------------------------------

/** Package names with an on-disk extension directory (any scope/kind). The
 * presence probe for presence-aware parity — independent of the inventory so
 * it stays a pure disk fact. */
export function readPresentExtensionNames(repoRoot = REPO_ROOT) {
  const present = new Set();
  const extRoot = join(repoRoot, "extensions");
  if (!existsSync(extRoot)) return present;
  for (const scope of readdirSync(extRoot)) {
    const scopeDir = join(extRoot, scope);
    let entries;
    try { entries = readdirSync(scopeDir); } catch { continue; }
    for (const dir of entries) {
      try {
        const name = JSON.parse(readFileSync(join(scopeDir, dir, "package.json"), "utf8")).name;
        if (typeof name === "string" && name.length > 0) present.add(name);
      } catch { /* not a package dir */ }
    }
  }
  return present;
}

export async function checkParity({ presenceAware = false } = {}) {
  const { records, connectorSetupPages } = await buildManifest();
  const problems = [];

  // 1) catalog ↔ manifest parity: every catalog descriptor must resolve to a
  //    manifest record, and every descriptor that needs a React setup page
  //    (anything but a declared schema-config surface) must have a generated
  //    setup-page loader entry. The host loader map is the generated map, so a
  //    missing entry here is a runtime 404 waiting to happen.
  //
  //    presenceAware (self mode ONLY — non-canonical universes, cinatra#7):
  //    the catalog legitimately describes the FULL acquirable universe, but a
  //    partial presence universe (prod image = the lock-acquired required
  //    set; a fresh public clone) carries records only for the packages on
  //    disk. A descriptor whose package is ABSENT from disk is presence
  //    filtering, not drift — skipped with a note. A descriptor whose package
  //    IS present but has no record stays a hard parity break in every mode.
  const presentNames = presenceAware ? readPresentExtensionNames() : null;
  const generated = new Set(connectorSetupPages.map((p) => p.slug));
  const recordByPackage = new Map(records.map((r) => [r.packageName, r]));
  for (const d of CONNECTOR_DESCRIPTORS) {
    const rec = recordByPackage.get(d.packageId);
    if (!rec) {
      if (presentNames !== null && !presentNames.has(d.packageId)) {
        console.log(
          `[extension-manifest] note (self mode): catalog descriptor "${d.slug}" (${d.packageId}) is absent from this presence universe — parity skipped (acquirable-on-demand).`,
        );
        continue;
      }
      problems.push(`catalog descriptor "${d.slug}" (${d.packageId}) has no manifest record`);
      continue;
    }
    if (rec.uiSurface === "schema-config") continue; // no React page by design
    if (!generated.has(d.slug)) {
      problems.push(`catalog descriptor "${d.slug}" requires a React setup page but has no generated loader entry`);
    }
  }

  // 2) manifest must cover every inventoried extension exactly once
  const names = new Set(records.map((r) => r.packageName));
  if (names.size !== records.length) problems.push("duplicate package in manifest");

  // 3) every declared requestedHostPort must be a real host-port name (catch typos
  //    at generation rather than silently granting nothing at runtime). A declared
  //    RESERVED-tier port (the ABI-evolution port-tiering policy) is WARNED, not failed:
  //    the port is real but unwired, so it fail-louds ("not-implemented") at runtime
  //    — pre-declaring it for a future wiring is allowed, never build-blocked.
  for (const r of records) {
    for (const port of r.requestedHostPorts) {
      if (!VALID_HOST_PORTS.has(port)) {
        problems.push(`${r.packageName} declares unknown requestedHostPort "${port}" (not a HOST_PORT_NAMES value)`);
      } else if (RESERVED_HOST_PORTS.has(port)) {
        console.warn(
          `[extension-manifest] WARN ${r.packageName} declares RESERVED requestedHostPort "${port}" — it is not wired and will fail-loud ("not-implemented") if accessed at runtime (HOST_PORT_TIER."${port}" = reserved).`,
        );
      }
    }
  }

  // 4) a schema-config record MUST carry a parseable configSchema (FAIL-CLOSED).
  //    `buildManifest` already throws on a malformed declaration; this is the
  //    belt-and-suspenders parity assertion (no schema-config record without
  //    config data, and the config data must validate).
  for (const r of records) {
    if (r.uiSurface !== "schema-config") continue;
    if (!isObj(r.configSchema)) {
      problems.push(`${r.packageName} uiSurface:"schema-config" but configSchema is absent`);
      continue;
    }
    for (const e of validateConfigSchema(r.configSchema)) {
      problems.push(`${r.packageName} configSchema ${e}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Generated output file names — resolved from the SHARED GENERATED_MANIFEST_FILES
// list (generated-manifest-files.mjs), the same list the extension-coupling
// gates permanently exempt. Resolving (not re-declaring) the paths here keeps
// the emitted set and the exempt set structurally identical; a gate test pins
// the equality. (No collision with the hand-maintained
// src/lib/connector-setup-pages.ts — different dir.)
function generatedOutPath(basename) {
  const rel = GENERATED_MANIFEST_FILES.find((p) => p.endsWith(`/${basename}`));
  if (!rel) throw new Error(`generated-manifest-files.mjs does not list ${basename} — emitted set and exempt set would drift`);
  return join(REPO_ROOT, rel);
}
const OUT_SERVER = generatedOutPath("extensions.server.ts");
const OUT_SETUP = generatedOutPath("connector-setup-pages.ts");
const OUT_CLIENT = generatedOutPath("extensions.client.tsx");
const OUT_WIDGET_PATHS = generatedOutPath("widget-stream-public-paths.ts");
const OUT_WEBHOOKS_SERVER = generatedOutPath("webhooks.server.ts");
const OUT_WEBHOOK_PATHS = generatedOutPath("webhook-public-paths.ts");
const OUT_WEBHOOK_META = generatedOutPath("webhook-registry-meta.ts");
const OUT_GUARDED_TEST = generatedOutPath("guarded-optional-loaders.test.ts");
const OUT_AGENT_BINDINGS = generatedOutPath("agent-bindings.ts");
const OUT_ARTIFACT_FLOOR = generatedOutPath("artifact-floor.ts");

/**
 * Fail-closed verdict for `--check` (cinatra#36): any drift/missing
 * generated file or any catalog parity issue must fail CI — the generated
 * tree is the coupling gates' permanent-exempt class, so its integrity is
 * load-bearing. Pure + exported for unit testing. Returns the process exit
 * code (0 = clean, 1 = fail).
 */
export function checkExitCode({ driftOrMissing, parityIssueCount }) {
  return driftOrMissing || parityIssueCount > 0 ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const {
    records,
    connectorSetupPages,
    connectorSettingsPages,
    connectorSkillsSettingsTabs,
    connectorEntryModules,
    connectorMcpModules,
    connectorPrimitiveHandlers,
    externalMcpToolboxes,
    widgetStreamAgents,
    webhookHooks,
    chatWidgetModules,
    agentFieldRendererBindings,
    agentRoleBindings,
    artifactFloorClaimant,
  } = await buildManifest();
  const files = [
    [OUT_SERVER, emitServer(records, connectorEntryModules, connectorMcpModules, connectorPrimitiveHandlers, externalMcpToolboxes, widgetStreamAgents, chatWidgetModules)],    [OUT_SETUP, emitConnectorSetupPages(connectorSetupPages, connectorSettingsPages, connectorSkillsSettingsTabs)],
    [OUT_CLIENT, emitClient()],
    [OUT_AGENT_BINDINGS, emitAgentBindings(agentFieldRendererBindings, agentRoleBindings)],
    [OUT_ARTIFACT_FLOOR, emitArtifactFloor(artifactFloorClaimant)],
    [OUT_WIDGET_PATHS, emitWidgetStreamPublicPaths(widgetStreamAgents)],
    [OUT_WEBHOOKS_SERVER, emitWebhooksServer(webhookHooks)],
    [OUT_WEBHOOK_PATHS, emitWebhookPublicPaths(webhookHooks)],
    [OUT_WEBHOOK_META, emitWebhookRegistryMeta(webhookHooks)],
    [
      OUT_GUARDED_TEST,
      emitGuardedOptionalLoadersTest({
        records,
        connectorEntryModules,
        connectorMcpModules,
        connectorPrimitiveHandlers,
        externalMcpToolboxes,
        widgetStreamAgents,
        webhookHooks,
        chatWidgetModules,
        connectorSetupPages,
        connectorSettingsPages,
        connectorSkillsSettingsTabs,
      }),
    ],
  ];

  if (args.includes("--print")) {
    console.log(JSON.stringify({ count: records.length, connectorSetupPages: connectorSetupPages.length, connectorSettingsPages: connectorSettingsPages.length }, null, 2));
    return;
  }

  if (args.includes("--check")) {
    // --check MODES (cinatra#7):
    //   canonical (default) — for the full clone-back CI tree, where the
    //     on-disk generated files ARE the committed artifact: the byte-exact
    //     comparison pins the COMMITTED maps (fail-closed, cinatra#36).
    //   --self (non-canonical) — for presence universes that legitimately
    //     differ from the committed one (fresh public clone after
    //     regeneration, the prod image build after lock acquisition): verifies
    //     the regenerated on-disk tree against a fresh in-memory emission for
    //     THIS tree (catches partial regeneration / post-regen hand edits) +
    //     catalog parity. It NEVER binds the committed tree — its failure
    //     remedy is always "re-run the generator here", never "match the
    //     committed artifact".
    const self = args.includes("--self");
    const mode = self ? "self" : "canonical";
    let drift = false;
    for (const [path, content] of files) {
      if (!existsSync(path)) {
        console.error(
          self
            ? `[extension-manifest] SELF-CHECK MISSING ${relative(REPO_ROOT, path)} — the regeneration did not produce this file; re-run: node scripts/extensions/generate-extension-manifest.mjs`
            : `[extension-manifest] MISSING ${relative(REPO_ROOT, path)} — regenerate: node scripts/extensions/generate-extension-manifest.mjs`,
        );
        drift = true;
        continue;
      }
      if (readFileSync(path, "utf8") !== content) {
        console.error(
          self
            ? `[extension-manifest] SELF-CHECK DRIFT ${relative(REPO_ROOT, path)} — on-disk file differs from a fresh emission for THIS tree (partial regeneration or post-regen hand edit; re-run: node scripts/extensions/generate-extension-manifest.mjs)`
            : `[extension-manifest] DRIFT ${relative(REPO_ROOT, path)} — file differs from generator output (hand-edit or stale; regenerate, never hand-edit)`,
        );
        drift = true;
      }
    }
    const parity = await checkParity({ presenceAware: self });
    for (const p of parity) console.error(`[extension-manifest] PARITY ${p}`);
    const exit = checkExitCode({ driftOrMissing: drift, parityIssueCount: parity.length });
    if (exit === 0) {
      console.log(
        self
          ? "[extension-manifest] OK (self mode) — regenerated tree self-consistent + parity holds (non-canonical presence universe; committed tree deliberately NOT consulted)."
          : "[extension-manifest] OK — generated files current + parity holds.",
      );
    } else {
      // FAIL-CLOSED in BOTH modes (cinatra#36): the generated tree is the
      // coupling gates' permanent-exempt class — drift or parity break fails.
      console.error(`[extension-manifest] FAIL (${mode} mode) — generated-tree drift and/or catalog parity break (see lines above).`);
      process.exit(exit);
    }
    return;
  }

  if (!existsSync(GEN_DIR)) mkdirSync(GEN_DIR, { recursive: true });
  for (const [path, content] of files) {
    // Nested outputs (the generated __tests__ file) need their dir created.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const parity = await checkParity();
  console.log(`[extension-manifest] wrote ${files.length} files (${records.length} extensions, ${connectorSetupPages.length} setup-pages, ${connectorSettingsPages.length} settings-pages, ${widgetStreamAgents.length} widget-stream agents, ${chatWidgetModules.length} chat-widget modules)`);  if (parity.length) {
    console.log("[extension-manifest] PARITY ISSUES:");
    for (const p of parity) console.log("  - " + p);
  } else {
    console.log("[extension-manifest] parity OK (catalog descriptors covered by the generated maps)");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
