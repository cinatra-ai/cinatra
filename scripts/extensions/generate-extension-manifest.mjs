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
//   node scripts/extensions/generate-extension-manifest.mjs           # (re)write generated files
//   node scripts/extensions/generate-extension-manifest.mjs --check   # drift + parity check (exit 1 on either)
//   node scripts/extensions/generate-extension-manifest.mjs --print   # print the manifest, write nothing

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInventory } from "./inventory.mjs";
import { GENERATED_MANIFEST_FILES } from "./generated-manifest-files.mjs";
import { CONNECTOR_DESCRIPTORS } from "../../packages/connectors-catalog/src/descriptors.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const GEN_DIR = join(REPO_ROOT, "src/lib/generated");

// anthropic-connector stays in-tree (owner directive) but is still a real
// loadable extension, so it remains in the manifest. The private vendor scope is in-tree.
const fileExists = (p) => existsSync(join(REPO_ROOT, p));

// Canonical host-port names — MUST mirror HOST_PORT_NAMES in
// @cinatra-ai/sdk-extensions (host-context.ts). Kept as a literal here because
// this is a plain .mjs build script that can't import the TS SDK; a manifest
// declaring an unknown requestedHostPort is flagged by checkParity() so typos
// are caught at generation, not silently treated as an ungranted (no-op) port.
const VALID_HOST_PORTS = new Set([
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
  }
  return errors;
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
    };
  });
  records.sort((a, b) => a.packageName.localeCompare(b.packageName));

  const connectorSetupPages = records
    .filter((r) => r.kind === "connector" && r.hasSetupPage)
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const connectorSettingsPages = records
    .filter((r) => r.kind === "connector" && r.hasSettingsPage)
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // Connector entry modules: the package root (src/index.ts) of every workspace
  // connector, keyed by slug. The host resolves a connector's server module
  // (status/config/action exports) through this map instead of importing the
  // package by name.
  const connectorEntryModules = records
    .filter((r) => r.kind === "connector" && fileExists(join(r.sourceDir, "src/index.ts")))
    .map((r) => ({ slug: r.packageName.split("/")[1], packageName: r.packageName }))
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
      return { slug: r.packageName.split("/")[1], packageName: r.packageName, factory };
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
        ? { slug: r.packageName.split("/")[1], packageName: r.packageName, factory }
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
      return { slug: r.packageName.split("/")[1], packageName: r.packageName, factory };
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
        label: ws.label,
        subjectNoun: ws.subjectNoun,
        skillCapability: ws.skillCapability,
        contextFields: ws.contextFields.map((f) => ({ key: f.key, maxLength: f.maxLength })),
        auth: {
          tokenConfigKey: ws.auth.tokenConfigKey,
          instancesConfigKey: ws.auth.instancesConfigKey,
          requiredInstanceFields: [...ws.auth.requiredInstanceFields],
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
      return { packageName: r.packageName };
    })
    .sort((a, b) => a.packageName.localeCompare(b.packageName));

  // FAIL-CLOSED system-extension coverage (cinatra#35 / IOC-43): the
  // host-owned `cinatra.systemExtensions` declaration (root package.json) is
  // the data source for the locked system set
  // (packages/extensions/src/system-extension-inventory.ts). Every declared
  // entry must resolve to a generated-manifest record — a typo'd or removed
  // package would otherwise silently never boot-lock. The declaration itself
  // is required (the lock set must never be implicitly empty).
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const declaredSystem = rootPkg?.cinatra?.systemExtensions;
  if (!Array.isArray(declaredSystem) || declaredSystem.length === 0) {
    throw new Error(
      "[extension-manifest] root package.json must declare a non-empty cinatra.systemExtensions array (host-owned locked system set)",
    );
  }
  const recordNames = new Set(records.map((r) => r.packageName));
  const unknownSystem = declaredSystem.filter((name) => !recordNames.has(name));
  if (unknownSystem.length > 0) {
    throw new Error(
      `[extension-manifest] cinatra.systemExtensions entries missing from the generated manifest: ${unknownSystem.join(", ")}`,
    );
  }

  return {
    records,
    connectorSetupPages,
    connectorSettingsPages,
    connectorEntryModules,
    connectorMcpModules,
    connectorPrimitiveHandlers,
    externalMcpToolboxes,
    widgetStreamAgents,
    chatWidgetModules,  };
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
      return `  ${JSON.stringify(r.packageName)}: () => import(${JSON.stringify(spec)}),`;
    })
    .join("\n");
  // Connector entry-module loader map: slug → dynamic import of the connector
  // package root. Same literal-specifier rule as the server-entry map. The host
  // resolves bundled-connector server modules (status/config/action exports)
  // through this map, keyed by slug, instead of naming connector packages.
  const entryModules = connectorEntryModules
    .map((p) => `  ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(p.packageName)}),`)
    .join("\n");
  // Connector MCP capability-module loader map: slug → { literal dynamic import
  // of <pkg>/mcp-module, factory export name }. Consumed by
  // src/lib/connector-mcp-registration.server.ts — the host registers connector
  // MCP modules from this map instead of importing them by package name.
  const mcpModules = connectorMcpModules
    .map(
      (p) =>
        `  ${JSON.stringify(p.slug)}: { load: () => import(${JSON.stringify(`${p.packageName}/mcp-module`)}), factory: ${JSON.stringify(p.factory)} },`,
    )
    .join("\n");
  // Connector primitive-handler loader map: slug → { literal dynamic import of
  // <pkg>/mcp-handlers, factory export name }. Consumed by
  // src/lib/connector-mcp-registration.server.ts for the in-process
  // primitive-handler capture.
  const primitiveHandlers = connectorPrimitiveHandlers
    .map(
      (p) =>
        `  ${JSON.stringify(p.slug)}: { load: () => import(${JSON.stringify(`${p.packageName}/mcp-handlers`)}), factory: ${JSON.stringify(p.factory)} },`,
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
        `  ${JSON.stringify(p.slug)}: { load: () => import(${JSON.stringify(`${p.packageName}/mcp-toolbox`)}), factory: ${JSON.stringify(p.factory)} },`,
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
        contextFields: w.contextFields,
        auth: w.auth,
      };
      const metaJson = JSON.stringify(meta).slice(1, -1); // splice load into the object literal
      return `  ${JSON.stringify(w.agentSlug)}: { load: () => import(${JSON.stringify(`${w.packageName}/widget-chat-tool`)}), ${metaJson} },`;
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
    .map((p) => `  ${JSON.stringify(p.packageName)}: () => import(${JSON.stringify(`${p.packageName}/widgets`)}),`)
    .join("\n");
  const chatWidgetManifests = chatWidgetModules
    .map((p) => `  ${JSON.stringify(p.packageName)}: () => import(${JSON.stringify(`${p.packageName}/widgets/manifest`)}),`)    .join("\n");
  return (
    `${HEADER(script)}import "server-only";\n` +
    `import type { NormalizedExtensionRecord } from "@cinatra-ai/sdk-extensions";\n\n` +
    `export const STATIC_EXTENSION_MANIFEST: Record<string, NormalizedExtensionRecord> = {\n` +
    `${body}\n};\n\n` +
    `export const STATIC_EXTENSION_RECORDS: NormalizedExtensionRecord[] =\n` +
    `  Object.values(STATIC_EXTENSION_MANIFEST);\n\n` +
    `// package → dynamic import of its server entry (register(ctx) module).\n` +
    `// Literal specifiers only (Turbopack-safe). Populated for extensions that\n` +
    `// declare cinatra.serverEntry.\n` +
    `export const GENERATED_EXTENSION_SERVER_ENTRIES: Record<string, () => Promise<unknown>> = {\n` +
    `${serverEntries}\n};\n\n` +
    `// connector slug → dynamic import of the connector package root module.\n` +
    `// Literal specifiers only (Turbopack-safe). Consumed by\n` +
    `// src/lib/connector-modules.server.ts.\n` +
    `export const GENERATED_CONNECTOR_ENTRY_MODULES: Record<string, () => Promise<unknown>> = {\n` +
    `${entryModules}\n};\n\n` +
    `// slug → { loader, factory export name } for connector MCP surfaces.\n` +
    `// Literal specifiers only (Turbopack-safe). Consumed by\n` +
    `// src/lib/connector-mcp-registration.server.ts.\n` +
    `export type GeneratedConnectorFactoryEntry = { load: () => Promise<unknown>; factory: string };\n\n` +
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
    `};\n` +
    `export type GeneratedWidgetStreamAgentEntry = {\n` +
    `  load: () => Promise<unknown>;\n` +
    `  packageName: string;\n` +
    `  factory: string;\n` +
    `  label: string;\n` +
    `  subjectNoun: string;\n` +
    `  skillCapability: string;\n` +
    `  contextFields: GeneratedWidgetStreamContextField[];\n` +
    `  auth: GeneratedWidgetStreamAuth;\n` +
    `};\n\n` +
    `export const GENERATED_WIDGET_STREAM_AGENTS: Record<string, GeneratedWidgetStreamAgentEntry> = {\n` +
    `${widgetAgents}\n};\n` +
    `\n` +
    `// packageName → dynamic import of the chat-widget COMPONENT module\n` +
    `// (src/widgets/index.ts). Literal specifiers only (Turbopack-safe). RSC\n` +
    `// consumers only (the chat mount) — the module graph includes "use client"\n` +
    `// components. Consumed by src/lib/chat-widget-catalog.server.ts.\n` +
    `export const GENERATED_CHAT_WIDGET_MODULES: Record<string, () => Promise<unknown>> = {\n` +
    `${chatWidgets}\n};\n\n` +
    `// packageName → dynamic import of the chat-widget MANIFEST module\n` +
    `// (src/widgets/manifest.ts — pure data, no React). Safe in ANY server\n` +
    `// bundle, including route handlers (the chat runner's wizard-manifest\n` +
    `// registry). Consumed by src/lib/chat-widget-catalog.server.ts.\n` +
    `export const GENERATED_CHAT_WIDGET_MANIFEST_MODULES: Record<string, () => Promise<unknown>> = {\n` +
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
  const body = widgetStreamAgents
    .map((w) => `  ${JSON.stringify(`/api/agents/${w.agentSlug}/stream`)},`)
    .join("\n");
  return (
    `// @generated by ${script} — DO NOT EDIT BY HAND.\n` +
    `// Regenerate: node ${script}\n` +
    `// Widget-public agent stream paths (one per cinatra.widgetStream declaration).\n` +
    `// Slug-only data — NO imports, NO package identifiers (proxy-bundle safe).\n` +
    `// Consumed by src/lib/auth-route-guard.ts: these paths skip the sign-in\n` +
    `// redirect; the route itself enforces Origin allowlist + Bearer token.\n` +
    `export const GENERATED_WIDGET_STREAM_PUBLIC_PATHS: readonly string[] = [\n` +
    `${body}\n];\n`  );
}

function emitConnectorSetupPages(setupPages, settingsPages) {
  const script = "scripts/extensions/generate-extension-manifest.mjs";
  const setupBody = setupPages
    .map((p) => `  ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(`${p.packageName}/setup-page`)}),`)
    .join("\n");
  const settingsBody = settingsPages
    .map((p) => `  ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(`${p.packageName}/settings-page`)}),`)
    .join("\n");
  return (
    `${HEADER(script)}import "server-only";\n\n` +
    `// Literal dynamic-import maps (Turbopack rejects computed import templates).\n` +
    `// Consumed by src/lib/connector-setup-pages.ts as the loader source of truth.\n` +
    `export type GeneratedPageLoader = () => Promise<unknown>;\n\n` +
    `export const GENERATED_CONNECTOR_SETUP_PAGES: Record<string, GeneratedPageLoader> = {\n` +
    `${setupBody}\n};\n\n` +
    `export const GENERATED_CONNECTOR_SETTINGS_PAGES: Record<string, GeneratedPageLoader> = {\n` +
    `${settingsBody}\n};\n`
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

// ---------------------------------------------------------------------------
// Parity (the catalog safety net)
// ---------------------------------------------------------------------------
export async function checkParity() {
  const { records, connectorSetupPages } = await buildManifest();
  const problems = [];

  // 1) catalog ↔ manifest parity: every catalog descriptor must resolve to a
  //    manifest record, and every descriptor that needs a React setup page
  //    (anything but a declared schema-config surface) must have a generated
  //    setup-page loader entry. The host loader map is the generated map, so a
  //    missing entry here is a runtime 404 waiting to happen.
  const generated = new Set(connectorSetupPages.map((p) => p.slug));
  const recordByPackage = new Map(records.map((r) => [r.packageName, r]));
  for (const d of CONNECTOR_DESCRIPTORS) {
    const rec = recordByPackage.get(d.packageId);
    if (!rec) {
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
  //    at generation rather than silently granting nothing at runtime).
  for (const r of records) {
    for (const port of r.requestedHostPorts) {
      if (!VALID_HOST_PORTS.has(port)) {
        problems.push(`${r.packageName} declares unknown requestedHostPort "${port}" (not a HOST_PORT_NAMES value)`);
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
    connectorEntryModules,
    connectorMcpModules,
    connectorPrimitiveHandlers,
    externalMcpToolboxes,
    widgetStreamAgents,
    chatWidgetModules,
  } = await buildManifest();
  const files = [
    [OUT_SERVER, emitServer(records, connectorEntryModules, connectorMcpModules, connectorPrimitiveHandlers, externalMcpToolboxes, widgetStreamAgents, chatWidgetModules)],    [OUT_SETUP, emitConnectorSetupPages(connectorSetupPages, connectorSettingsPages)],
    [OUT_CLIENT, emitClient()],
    [OUT_WIDGET_PATHS, emitWidgetStreamPublicPaths(widgetStreamAgents)],
  ];

  if (args.includes("--print")) {
    console.log(JSON.stringify({ count: records.length, connectorSetupPages: connectorSetupPages.length, connectorSettingsPages: connectorSettingsPages.length }, null, 2));
    return;
  }

  if (args.includes("--check")) {
    let drift = false;
    for (const [path, content] of files) {
      if (!existsSync(path)) {
        console.error(`[extension-manifest] MISSING ${relative(REPO_ROOT, path)} — regenerate: node scripts/extensions/generate-extension-manifest.mjs`);
        drift = true;
        continue;
      }
      if (readFileSync(path, "utf8") !== content) {
        console.error(`[extension-manifest] DRIFT ${relative(REPO_ROOT, path)} — file differs from generator output (hand-edit or stale; regenerate, never hand-edit)`);
        drift = true;
      }
    }
    const parity = await checkParity();
    for (const p of parity) console.error(`[extension-manifest] PARITY ${p}`);
    const exit = checkExitCode({ driftOrMissing: drift, parityIssueCount: parity.length });
    if (exit === 0) {
      console.log("[extension-manifest] OK — generated files current + parity holds.");
    } else {
      // FAIL-CLOSED (cinatra#36): the generated tree is the coupling
      // gates' permanent-exempt class — drift or parity break fails CI.
      console.error("[extension-manifest] FAIL — generated-tree drift and/or catalog parity break (see lines above).");
      process.exit(exit);
    }
    return;
  }

  if (!existsSync(GEN_DIR)) mkdirSync(GEN_DIR, { recursive: true });
  for (const [path, content] of files) writeFileSync(path, content);
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
