// Generic dev-content seeder for the local Plane dev instance.
//
// Seeds the generic, fictional work items from
// scripts/fixtures/external-instances.dev-content.json into an EXISTING Plane
// project via the Plane connector's MCP tools.
//
// WHY THIS DIFFERS FROM THE TWENTY SEEDER (scripts/fixtures/seed-twenty-content.mjs):
// Plane has NO headless API-key mint (unlike Twenty's `workspace:generate-api-key`)
// and NO `create_project` MCP tool — the connector exposes only the DIRECT-NAMED
// verbs `list_projects`, `list_work_items`, `create_work_item`,
// `update_work_item`, `retrieve_work_item`, `delete_work_item`,
// `search_work_items` (there is NO `execute_tool` envelope). So this seeder:
//   1. RESOLVES the target project by `identifier` (then `name`) from
//      list_projects — it NEVER creates the project. If the project is absent
//      (a fresh Plane needs a one-time interactive sign-up + PAT mint + project
//      create), the run FAILS CLOSED: it seeds nothing and reports the reason,
//      so it can never guess a project or duplicate work items.
//   2. Seeds each fixture work item into that project, matched by a provenance
//      sidecar (fixtureId -> {id,rev,checksum}) then by name (Plane work items
//      carry no custom marker field, so — like Twenty VIEWS — we match by
//      stored id first, name second). Create-if-absent; rev-gated REPLACE of a
//      still-fixture-owned row; SKIP anything a user edited or deleted.
//
// Invoked as a step of the Plane demo bring-up (the connector's dev-setup /
// bootstrap path passes a Plane MCP client bound to the minted PAT); this
// module owns the idempotent CONTENT logic and is transport-agnostic — the
// caller injects the client, so the pure helpers below are unit-testable
// without a live Plane. Pure ESM, Node built-ins only.

import { checksumOf } from "./lib/dev-content-manifest.mjs";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Parse the JSON payload out of a Plane tools/call result. */
export function parseToolJson(result) {
  if (!result || typeof result !== "object") return null;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  for (const c of result.content ?? []) {
    if (c && c.type === "json" && c.json !== undefined) return c.json;
    if (c && c.type === "text" && typeof c.text === "string") {
      try {
        return JSON.parse(c.text);
      } catch {
        /* not JSON — keep scanning */
      }
    }
  }
  return null;
}

// Plane uses opaque string ids (UUIDs on CE); tolerate any non-empty string id.
/** Pull a record id out of a create/find result (tolerant to tool-version shape). */
export function extractRecordId(result) {
  const json = parseToolJson(result);
  if (json && typeof json === "object") {
    if (typeof json.id === "string" && json.id) return json.id;
    for (const wrap of ["work_item", "workItem", "issue", "record", "data", "project"]) {
      const v = json[wrap];
      if (v && typeof v === "object" && typeof v.id === "string" && v.id) return v.id;
    }
  }
  return null;
}

/** Normalize a find-result payload into a flat array of records. */
export function extractRecordsArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of ["projects", "work_items", "workItems", "issues", "results", "records", "data", "items"]) {
    if (Array.isArray(json[key])) return json[key];
  }
  for (const v of Object.values(json)) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray(v.results)) return v.results;
  }
  return [];
}

/** Case-insensitive read of a record's project identifier (CE varies the key). */
function identifierOf(project) {
  return String(project?.identifier ?? project?.project_identifier ?? "").toUpperCase();
}

/**
 * Resolve the target project id from list_projects records: match the fixture
 * project by `identifier` (case-insensitive) first, then by `name`. Returns the
 * project id, or null when no match (the caller then fails closed).
 */
export function resolveProjectId(projects, project) {
  const wantId = String(project?.identifier ?? "").toUpperCase();
  const wantName = String(project?.name ?? "").toLowerCase();
  for (const p of projects) {
    if (!p || typeof p !== "object") continue;
    if (wantId && identifierOf(p) === wantId && p.id) return p.id;
  }
  for (const p of projects) {
    if (!p || typeof p !== "object") continue;
    if (wantName && typeof p.name === "string" && p.name.toLowerCase() === wantName && p.id) return p.id;
  }
  return null;
}

/** Find an existing work item by name (case-insensitive) within the project. */
export function findWorkItemByName(items, name) {
  const lowered = String(name).toLowerCase();
  return items.find((w) => w && typeof w.name === "string" && w.name.toLowerCase() === lowered) ?? null;
}

/**
 * Checksum over the IDENTIFYING fields Plane echoes verbatim, for user-edit
 * detection on a manifest-version replace. Works on BOTH a manifest item and a
 * live record (both carry flat `name`/`description`/`priority`). Only the
 * plain-text fields Plane returns unchanged are covered.
 */
export function comparableChecksum(src) {
  return checksumOf({
    name: src?.name ?? "",
    description: src?.description ?? src?.description_stripped ?? "",
    priority: src?.priority ?? "",
  });
}

// Required must be present; safe are proven top-level scalars; risky are fields
// whose exact CE shape varies (long-form description) and are dropped first on a
// create error — so a rejected guessed field never costs us a proven one.
export function buildWorkItemArgs(item, projectId) {
  const required = { project_id: projectId, name: item.name };
  const safe = {};
  if (item.priority) safe.priority = item.priority;
  const risky = {};
  if (item.description) risky.description = item.description;
  return { required, safe, risky };
}

// ---------------------------------------------------------------------------
// I/O orchestrator
// ---------------------------------------------------------------------------

async function callTool(client, toolName, args) {
  const result = await client.callTool(toolName, args);
  if (result && result.isError) {
    const text = (result.content ?? []).map((c) => c?.text).filter(Boolean).join(" ").slice(0, 300);
    throw new Error(`${toolName} returned isError: ${text}`);
  }
  return result;
}

/**
 * Create/update a work item, retrying without the risky (version-sensitive)
 * fields if the tool rejects them, so a guessed shape never loses a proven field.
 */
async function upsertWithFallback(client, toolName, baseArgs, riskyArgs, log) {
  const hasRisky = Object.keys(riskyArgs ?? {}).length > 0;
  try {
    return await callTool(client, toolName, { ...baseArgs, ...riskyArgs });
  } catch (err) {
    if (!hasRisky) throw err;
    log("warn", `${toolName} with composite fields failed (${String(err.message).slice(0, 160)}) — retrying without them`);
    return await callTool(client, toolName, baseArgs);
  }
}

/**
 * List existing records of one kind. FAIL-CLOSED: on any error return
 * { ok: false } so the caller skips creation (assuming absence would duplicate).
 */
async function listExisting(client, tool, args, log) {
  try {
    const res = await callTool(client, tool, args);
    return { ok: true, records: extractRecordsArray(parseToolJson(res)) };
  } catch (err) {
    log("warn", `${tool} failed (${String(err.message).slice(0, 160)}) — skipping creates to avoid duplicates`);
    return { ok: false, records: [] };
  }
}

/**
 * Upsert one work item against the provenance sidecar.
 *   - provenance has the id + still present → rev-gated REPLACE (else skip).
 *   - provenance has the id + record gone   → user deleted → SKIP (never recreate).
 *   - no provenance + list ok               → match by name, else CREATE.
 *   - no provenance + list failed           → fail-closed SKIP.
 */
async function upsertWorkItem(opts) {
  const { client, item, projectId, version, provenance, existing, listOk, createTool, updateTool, log, summary } = opts;
  const fx = item.fixtureId;
  try {
    const prov = provenance[fx];
    if (prov && prov.id) {
      const live = existing.find((r) => r && r.id === prov.id);
      if (!live) {
        summary.workItems.skipped++; // deleted (or unverifiable) → respect, never recreate
        return;
      }
      if (version > (prov.rev ?? 0)) {
        // Reclaim ONLY a verifiably fixture-owned row: a stored checksum must
        // exist (legacy entries without one are unverifiable → fail closed) AND
        // the live row must still match it. Otherwise the user edited it →
        // preserve, never clobber.
        if (!prov.checksum || comparableChecksum(live) !== prov.checksum) {
          summary.workItems.skipped++;
          return;
        }
        const nextChecksum = comparableChecksum(item);
        if (nextChecksum === prov.checksum) {
          prov.rev = version; // content unchanged in the manifest → advance rev, no write
          summary.workItems.skipped++;
          return;
        }
        const { required, safe, risky } = buildWorkItemArgs(item, projectId);
        await upsertWithFallback(client, updateTool, { id: prov.id, ...required, ...safe }, risky, log);
        prov.rev = version;
        prov.checksum = nextChecksum;
        summary.workItems.replaced++;
      } else {
        summary.workItems.skipped++;
      }
      return;
    }
    if (!listOk) {
      summary.workItems.skipped++; // can't confirm absence → don't risk a duplicate
      return;
    }
    const hit = findWorkItemByName(existing, item.name);
    if (hit) {
      const id = hit.id ?? extractRecordId({ structuredContent: hit });
      provenance[fx] = { id, rev: version, checksum: comparableChecksum(item) };
      summary.workItems.skipped++;
      return;
    }
    const { required, safe, risky } = buildWorkItemArgs(item, projectId);
    const res = await upsertWithFallback(client, createTool, { ...required, ...safe }, risky, log);
    provenance[fx] = { id: extractRecordId(res), rev: version, checksum: comparableChecksum(item) };
    summary.workItems.created++;
  } catch (err) {
    summary.workItems.error++;
    log("warn", `work item "${fx}" failed: ${String(err.message).slice(0, 200)}`);
  }
}

/**
 * Seed the Plane section of the manifest. Mutates `provenance`
 * (fixtureId -> { id, rev, checksum }) in place so the caller can persist it.
 * Returns { project: { resolved, id, reason }, workItems: {created,replaced,skipped,error}, listOk }.
 *
 * `deps`: { client, manifest, log?, provenance? }
 */
export async function seedPlaneContent({ client, manifest, log = () => {}, provenance = {} }) {
  const plane = manifest?.plane ?? {};
  const version = Number.isInteger(manifest?.version) && manifest.version >= 1 ? manifest.version : 1;
  const summary = {
    project: { resolved: false, id: null, reason: null },
    workItems: { created: 0, replaced: 0, skipped: 0, error: 0 },
    listOk: false,
  };

  const project = plane.project;
  const items = plane.workItems ?? [];
  if (!project || items.length === 0) {
    summary.project.reason = "no plane project/work items in the manifest";
    return summary;
  }

  // 1. Resolve the EXISTING project (never create it).
  const projects = await listExisting(client, "list_projects", {}, log);
  if (!projects.ok) {
    summary.project.reason = "list_projects failed — cannot resolve the target project";
    return summary;
  }
  const projectId = resolveProjectId(projects.records, project);
  if (!projectId) {
    summary.project.reason =
      `target Plane project not found (identifier="${project.identifier}", name="${project.name}"). ` +
      "Plane has no headless project create — sign in to Plane once, create the project, then re-run the demo seed.";
    log("warn", summary.project.reason);
    return summary;
  }
  summary.project.resolved = true;
  summary.project.id = projectId;

  // 2. Seed work items into the resolved project.
  const existing = await listExisting(client, "list_work_items", { project_id: projectId }, log);
  summary.listOk = existing.ok;
  for (const item of items) {
    await upsertWorkItem({
      client,
      item,
      projectId,
      version,
      provenance,
      existing: existing.records,
      listOk: existing.ok,
      createTool: "create_work_item",
      updateTool: "update_work_item",
      log,
      summary,
    });
  }

  return summary;
}
