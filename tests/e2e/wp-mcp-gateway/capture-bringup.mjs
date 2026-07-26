#!/usr/bin/env node
/**
 * Bring-up resolver for the WP MCP gateway pinned fixture (issue #2016, S1, C0).
 *
 * Resolves — on a GitHub runner, WITHOUT booting the (not-yet-built) 6.9
 * fixture — every pin value the downstream S1 commits (Dockerfile,
 * docker-compose.yml, scripts/wordpress-entrypoint.sh, docker/wordpress/pins.lock,
 * the capture producer) must consume DETERMINISTICALLY:
 *
 *   - sha256 + size of the mcp-adapter 0.5.0 release ZIP
 *   - whether that ZIP bundles vendor/autoload.php  (bundlesVendor — picks the
 *     single Dockerfile/entrypoint vendor path, design §1.1)
 *   - sha256 of the enable-abilities-for-mcp 2.0.20 release ZIP
 *   - resolved version + sha256 of the latest wp-cli phar (design §1.1 pins it)
 *   - the wordpress:6.9-php8.3-apache base-image digest (registry query)
 *   - the mcp-adapter gateway triad tool ids + input-schema shapes (static grep
 *     of the unzipped release — candidates discover / get-info / execute)
 *   - the Abilities-API annotation-carrier field (static grep — §2.2 VERIFY)
 *   - the default MCP server id + REST route (static grep)
 *
 * Every value records HOW it was resolved (`resolvedVia`). This is the STAGE-1
 * adaptation of design §0.1: at C0 the pinned image does not exist yet, so the
 * bring-up resolves pins statically rather than booting (recorded boot:false;
 * deterministic). The definitive live tools/list confirmation happens at C3+.
 *
 * RUNNER-ONLY: shells `docker buildx imagetools inspect`, `curl`, `unzip`.
 * Guarded so it never runs on the operator box (which never runs docker).
 *
 * Output (env BRINGUP_OUT, default ./bringup-out):
 *   adapter-0.5.0-api-map.json         — the committed API map
 *   adapter-0.5.0-api-map.summary.md   — human summary for the job step summary
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The S1 target stack (design §1.1). Bare versions (no leading "v") mirror the
// existing Dockerfile pin convention that keeps the source-leak-gate quiet.
const PINS = {
  baseImage: { ref: "wordpress:6.9-php8.3-apache" },
  mcpAdapter: {
    version: "0.5.0",
    tag: "v0.5.0",
    commit: "7bfc49f46b3ea7544dded49d5a606089f825a80b",
    url: "https://github.com/WordPress/mcp-adapter/releases/download/v0.5.0/mcp-adapter.zip",
  },
  enableAbilitiesForMcp: {
    version: "2.0.20",
    url: "https://downloads.wordpress.org/plugin/enable-abilities-for-mcp.2.0.20.zip",
  },
};

const OUT_DIR = process.env.BRINGUP_OUT || join(process.cwd(), "bringup-out");
const RUN_URL = process.env.BRINGUP_RUN_URL || "";
const COMMIT = process.env.BRINGUP_COMMIT || "";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function download(url, dest) {
  sh("curl", [
    "-fsSL",
    "--retry",
    "4",
    "--retry-delay",
    "3",
    "--retry-all-errors",
    "-o",
    dest,
    url,
  ]);
}

// Recursively list every file under `dir`.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Return { line, text } for every line of `file` matching `re`.
function grepFile(file, re) {
  const hits = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
  }
  return hits;
}

// Best-effort excerpt of the PHP 'input_schema' block for shape evidence.
function inputSchemaExcerpt(fileText) {
  const idx = fileText.indexOf("'input_schema'");
  if (idx < 0) return null;
  return fileText
    .slice(idx, idx + 1400)
    .split("\n")
    .slice(0, 40)
    .join("\n");
}

function resolveBaseDigest(ref) {
  // Primary: parse the `Digest:` line of the human inspect output (robust across
  // buildx versions). The tag is a multi-arch index; its digest is what you pin
  // with @sha256: (mirrors docker/plane-mcp/Dockerfile).
  const raw = sh("docker", ["buildx", "imagetools", "inspect", ref]);
  const m = raw.match(/Digest:\s+(sha256:[0-9a-f]{64})/);
  if (!m) {
    throw new Error(
      `could not parse a Digest: line from 'docker buildx imagetools inspect ${ref}'. ` +
        `Does the tag exist on Docker Hub? Output head:\n${raw.slice(0, 400)}`,
    );
  }
  return {
    digest: m[1],
    resolvedVia: `docker buildx imagetools inspect ${ref} → 'Digest:' line`,
  };
}

async function resolveWpCli(workDir) {
  const headers = { "User-Agent": "cinatra-wp-mcp-bringup" };
  if (process.env.GH_TOKEN)
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(
    "https://api.github.com/repos/wp-cli/wp-cli/releases/latest",
    { headers },
  );
  if (!res.ok)
    throw new Error(`wp-cli releases/latest → HTTP ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => a.name.endsWith(".phar"));
  if (!asset)
    throw new Error(
      `no .phar asset on wp-cli release ${rel.tag_name} (assets: ${(rel.assets || []).map((a) => a.name).join(", ")})`,
    );
  const dest = join(workDir, asset.name);
  download(asset.browser_download_url, dest);
  return {
    version: String(rel.tag_name).replace(/^v/, ""),
    tag: rel.tag_name,
    url: asset.browser_download_url,
    sha256: sha256File(dest),
    resolvedVia:
      "GET api.github.com/repos/wp-cli/wp-cli/releases/latest → .phar asset; curl + sha256",
  };
}

export function resolveAdapterApi(unzipRoot) {
  const files = walk(unzipRoot);
  const php = files.filter((f) => f.endsWith(".php"));

  // bundlesVendor: does the release ZIP ship a composer autoloader?
  const bundlesVendor = files.some((f) =>
    f.replace(/\\/g, "/").endsWith("vendor/autoload.php"),
  );

  // Gateway triad: every ability registered under the mcp-adapter/ namespace.
  const ROLE = {
    "mcp-adapter/discover-abilities": "discover",
    "mcp-adapter/get-ability-info": "get-info",
    "mcp-adapter/execute-ability": "execute",
  };
  const triad = [];
  // The id argument sits on its OWN line after `wp_register_ability(`, so this
  // must span newlines — a per-line grep misses it. Match against full text.
  const reRegister = /wp_register_ability\(\s*['"](mcp-adapter\/[^'"]+)['"]/g;
  for (const f of php.filter((p) =>
    p.replace(/\\/g, "/").includes("/includes/Abilities/"),
  )) {
    const text = readFileSync(f, "utf8");
    const rel = f.slice(unzipRoot.length + 1);
    for (const m of text.matchAll(reRegister)) {
      const id = m[1];
      const line = text.slice(0, m.index).split("\n").length;
      const after = text.slice(m.index, m.index + 600);
      const label = (after.match(/'label'\s*=>\s*'([^']+)'/) || [])[1] || null;
      triad.push({
        toolAbilityId: id,
        role: ROLE[id] || "unknown",
        label,
        registeredIn: `${rel}:${line}`,
        inputSchemaSource: inputSchemaExcerpt(text),
      });
    }
  }
  triad.sort((a, b) => a.toolAbilityId.localeCompare(b.toolAbilityId));

  // Annotation carrier: how the Abilities API transports readOnlyHint /
  // destructiveHint through to the MCP tool DTO.
  const registerFile = php.find((p) =>
    p.replace(/\\/g, "/").endsWith("Domain/Tools/RegisterAbilityAsMcpTool.php"),
  );
  let annotationCarrier = {
    field: null,
    resolved: false,
    resolvedVia: "static grep of RegisterAbilityAsMcpTool.php (not found)",
    evidence: [],
  };
  if (registerFile) {
    const rel = registerFile.slice(unzipRoot.length + 1);
    const ev = grepFile(
      registerFile,
      /get_meta\(\)|\['annotations'\]|McpAnnotationMapper|tool_data\['annotations'\]|meta\['mcp'\]/,
    ).map((h) => `${rel}:${h.line}  ${h.text}`);
    const carries =
      ev.some((e) => e.includes("['annotations']")) &&
      ev.some((e) => e.toLowerCase().includes("annotationmapper"));
    annotationCarrier = {
      // The WP ability declares annotations under meta.annotations; the adapter
      // maps them (McpAnnotationMapper) onto the MCP tool DTO's top-level
      // `annotations`. Icons/_meta ride meta.mcp.* — a distinct channel.
      field: carries ? "ability.meta.annotations" : null,
      mapsToToolField: carries ? "tool.annotations" : null,
      mapper: carries ? "McpAnnotationMapper::map(meta.annotations,'tool')" : null,
      resolved: carries,
      resolvedVia: `static grep of ${rel} for get_meta()/['annotations']/McpAnnotationMapper`,
      evidence: ev,
    };
  }

  // Default server id + REST route.
  const factory = php.find((p) =>
    p.replace(/\\/g, "/").endsWith("Servers/DefaultServerFactory.php"),
  );
  let defaultServer = { resolved: false };
  if (factory) {
    const rel = factory.slice(unzipRoot.length + 1);
    const t = readFileSync(factory, "utf8");
    const g = (k) => (t.match(new RegExp(`'${k}'\\s*=>\\s*'([^']+)'`)) || [])[1] || null;
    const ns = g("server_route_namespace");
    const route = g("server_route");
    defaultServer = {
      serverId: g("server_id"),
      routeNamespace: ns,
      route,
      restRoute: ns && route ? `/wp-json/${ns}/${route}` : null,
      resolved: Boolean(ns && route),
      resolvedVia: `static grep of ${rel}`,
    };
  }

  return {
    bundlesVendor,
    bundlesVendorResolvedVia:
      "unzip mcp-adapter.zip; search for a path ending vendor/autoload.php",
    gatewayTriad: {
      triadResolved: triad.length >= 3,
      note:
        "Ability ids registered under the mcp-adapter/ namespace; the MCP tool " +
        "wire-name mapping (RegisterAbilityAsMcpTool) and the exact tools/list " +
        "shape are confirmed at boot (C3). Statically resolved here — no boot.",
      tools: triad,
    },
    annotationCarrier,
    defaultServer,
  };
}

function guard() {
  if (process.env.CI !== "true" && process.env.BRINGUP_ALLOW_LOCAL !== "1") {
    throw new Error(
      "capture-bringup.mjs is runner-only (needs docker buildx + network). " +
        "It must never run on the operator box. Set BRINGUP_ALLOW_LOCAL=1 to override.",
    );
  }
}

async function main() {
  guard();
  mkdirSync(OUT_DIR, { recursive: true });
  const work = join(tmpdir(), `wp-mcp-bringup-${process.pid}`);
  mkdirSync(work, { recursive: true });

  // --- base image digest ---
  const base = resolveBaseDigest(PINS.baseImage.ref);

  // --- mcp-adapter ZIP ---
  const adapterZip = join(work, "mcp-adapter.zip");
  download(PINS.mcpAdapter.url, adapterZip);
  const adapterSha = sha256File(adapterZip);
  const adapterSize = statSync(adapterZip).size;
  const adapterDir = join(work, "mcp-adapter");
  mkdirSync(adapterDir, { recursive: true });
  sh("unzip", ["-q", "-o", adapterZip, "-d", adapterDir]);
  const adapterApi = resolveAdapterApi(adapterDir);

  // --- enable-abilities-for-mcp ZIP ---
  const eafmZip = join(work, "eafm.zip");
  download(PINS.enableAbilitiesForMcp.url, eafmZip);
  const eafmSha = sha256File(eafmZip);
  const eafmSize = statSync(eafmZip).size;

  // --- wp-cli phar ---
  const wpCli = await resolveWpCli(work);

  const apiMap = {
    schemaVersion: 1,
    purpose:
      "Bring-up-resolved pins + adapter API map for the WP MCP gateway pinned " +
      "fixture (issue #2016, S1). Downstream commits (Dockerfile, compose, " +
      "entrypoint, pins.lock, capture producer) consume ONLY these resolved " +
      "values. No placeholder tokens (design §0.1 hard rule).",
    pinnedTuple: {
      wp: "6.9",
      mcpAdapter: PINS.mcpAdapter.version,
      eafm: PINS.enableAbilitiesForMcp.version,
    },
    resolvedBy: {
      mode: "bringup",
      boot: false,
      note:
        "STAGE-1 static resolution (design §0.1 adapted): the 6.9 image does " +
        "not exist yet at C0, so pins are resolved by download+sha256, registry " +
        "digest query, and static grep of the unzipped adapter — not by booting.",
      runUrl: RUN_URL,
      commit: COMMIT,
      resolvedAt: new Date().toISOString(),
    },
    baseImage: {
      ref: PINS.baseImage.ref,
      digest: base.digest,
      resolvedVia: base.resolvedVia,
    },
    mcpAdapter: {
      version: PINS.mcpAdapter.version,
      tag: PINS.mcpAdapter.tag,
      commit: PINS.mcpAdapter.commit,
      url: PINS.mcpAdapter.url,
      sha256: adapterSha,
      sizeBytes: adapterSize,
      bundlesVendor: adapterApi.bundlesVendor,
      bundlesVendorResolvedVia: adapterApi.bundlesVendorResolvedVia,
      resolvedVia: "curl release asset; sha256 of the downloaded ZIP",
    },
    enableAbilitiesForMcp: {
      version: PINS.enableAbilitiesForMcp.version,
      url: PINS.enableAbilitiesForMcp.url,
      sha256: eafmSha,
      sizeBytes: eafmSize,
      resolvedVia: "curl downloads.wordpress.org ZIP; sha256",
    },
    wpCli,
    gatewayTriad: adapterApi.gatewayTriad,
    annotationCarrier: adapterApi.annotationCarrier,
    defaultServer: adapterApi.defaultServer,
  };

  const jsonPath = join(OUT_DIR, "adapter-0.5.0-api-map.json");
  writeFileSync(jsonPath, JSON.stringify(apiMap, null, 2) + "\n");

  const summary = [
    "## WP MCP gateway bring-up (static — no boot)",
    "",
    `- base image \`${apiMap.baseImage.ref}\` → \`${apiMap.baseImage.digest}\``,
    `- mcp-adapter ${apiMap.mcpAdapter.version} sha256 \`${apiMap.mcpAdapter.sha256}\` (${apiMap.mcpAdapter.sizeBytes} B), bundlesVendor=\`${apiMap.mcpAdapter.bundlesVendor}\``,
    `- enable-abilities-for-mcp ${apiMap.enableAbilitiesForMcp.version} sha256 \`${apiMap.enableAbilitiesForMcp.sha256}\``,
    `- wp-cli ${apiMap.wpCli.version} sha256 \`${apiMap.wpCli.sha256}\``,
    `- gateway triad: ${apiMap.gatewayTriad.tools.map((t) => t.toolAbilityId).join(", ") || "(none found)"}`,
    `- annotation carrier: \`${apiMap.annotationCarrier.field || "UNRESOLVED"}\` → \`${apiMap.annotationCarrier.mapsToToolField || "?"}\``,
    `- default server route: \`${apiMap.defaultServer.restRoute || "UNRESOLVED"}\``,
    "",
  ].join("\n");
  writeFileSync(join(OUT_DIR, "adapter-0.5.0-api-map.summary.md"), summary);

  console.log(summary);
  console.log(`wrote ${jsonPath}`);
}

// Run unless imported for unit testing (a harness sets BRINGUP_NO_MAIN=1 to
// exercise resolveAdapterApi against a locally-unzipped ZIP without shelling
// docker/curl).
if (process.env.BRINGUP_NO_MAIN !== "1") {
  main().catch((err) => {
    console.error(`bring-up failed: ${err.message}`);
    process.exit(1);
  });
}
