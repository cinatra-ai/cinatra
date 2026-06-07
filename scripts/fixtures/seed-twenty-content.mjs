// Generic dev-content seeder for the local Twenty CRM dev instance.
//
// Layered ON TOP of Twenty's built-in "Apple" dev seed (workspace:seed:dev),
// which is baked into the Twenty image and kept as-is. Seeds the generic,
// fictional companies / people / views from
// scripts/fixtures/external-instances.dev-content.json via the Twenty MCP
// catalog tools (create_company / create_person / create_view), using the
// bootstrap-minted API key.
//
// Invoked as a step of scripts/twenty-bootstrap/twenty-bootstrap-proof.mjs (the operator
// entry point that already seeds Apple, mints the API key, and creates the
// required `cinatraObjectId` custom field). Idempotency marker: each
// company/person carries `cinatraObjectId = fixtureId`; views are matched by
// name. Create-if-absent; never duplicates.
//
// Pure ESM, Node built-ins only. The orchestrator does I/O; the small helpers
// are exported for unit testing without a live Twenty.

import { checksumOf } from "./lib/dev-content-manifest.mjs";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Parse the JSON payload out of a Twenty tools/call result. */
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

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** Pull a record id out of a create/find result (tolerant to tool-version shape). */
export function extractRecordId(result) {
  const json = parseToolJson(result);
  if (json && typeof json === "object") {
    for (const key of ["id"]) {
      if (typeof json[key] === "string" && UUID_RE.test(json[key])) return json[key];
    }
    for (const wrap of ["record", "data", "company", "person", "view"]) {
      const v = json[wrap];
      if (v && typeof v === "object" && typeof v.id === "string") return v.id;
    }
  }
  // Last resort: first UUID in the serialized result.
  const m = JSON.stringify(result ?? "").match(UUID_RE);
  return m ? m[1] : null;
}

/** Normalize a find-result payload into a flat array of records. */
export function extractRecordsArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of ["companies", "people", "persons", "records", "views", "data", "items"]) {
    if (Array.isArray(json[key])) return json[key];
  }
  // Some tools wrap as { records: { edges: [{ node }] } } or similar.
  for (const v of Object.values(json)) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray(v.edges)) {
      return v.edges.map((e) => e?.node).filter(Boolean);
    }
  }
  return [];
}

/** Find a previously-seeded record by its cinatraObjectId marker (fixtureId). */
export function findByCinatraObjectId(records, fixtureId) {
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (r.cinatraObjectId === fixtureId) return r;
    // Tolerate nested shapes by checking the serialized record for the marker.
    if (JSON.stringify(r).includes(`"${fixtureId}"`)) return r;
  }
  return null;
}

/** Find an existing view by name (case-insensitive). */
export function findViewByName(views, name) {
  const lowered = String(name).toLowerCase();
  return views.find((v) => v && typeof v.name === "string" && v.name.toLowerCase() === lowered) ?? null;
}

/**
 * Checksum over the IDENTIFYING fields a Twenty list API returns verbatim, for
 * user-edit detection on a manifest-version replace. Works on BOTH a manifest
 * item (flat `firstName`/`lastName`) and a live record (`name.{firstName,...}`)
 * so the same content yields the same checksum on either side. We only cover
 * plain-text fields Twenty echoes unchanged (company/view `name`, person
 * `firstName`/`lastName`/`jobTitle`) — composite fields whose stored shape
 * differs from the create args are deliberately excluded.
 */
export function comparableChecksum(entityKind, src) {
  if (entityKind === "company") {
    return checksumOf({ name: src.name ?? "" });
  }
  if (entityKind === "person") {
    const name = src.name && typeof src.name === "object" ? src.name : src;
    return checksumOf({
      firstName: name.firstName ?? "",
      lastName: name.lastName ?? "",
      jobTitle: src.jobTitle ?? "",
    });
  }
  // view
  return checksumOf({ name: src.name ?? "" });
}

// Args are split into three tiers so a rejected GUESSED field never costs us a
// PROVEN one:
//   required — must be present (proven by the bootstrap smoke).
//   safe     — proven top-level scalar fields (employees / jobTitle / companyId).
//   risky    — composite fields whose exact MCP shape varies by Twenty version
//              (domainName / emails / address). Dropped first on a create error.
export function buildCompanyArgs(company) {
  const required = { name: company.name, cinatraObjectId: company.fixtureId };
  const safe = {};
  if (Number.isFinite(company.employees)) safe.employees = company.employees;
  const risky = {};
  if (company.domainName) risky.domainName = { primaryLinkUrl: `https://${company.domainName}` };
  if (company.addressCity) risky.address = { addressCity: company.addressCity };
  return { required, safe, risky };
}

export function buildPersonArgs(person, companyId) {
  const required = {
    name: { firstName: person.firstName ?? "", lastName: person.lastName ?? "" },
    cinatraObjectId: person.fixtureId,
  };
  const safe = {};
  if (person.jobTitle) safe.jobTitle = person.jobTitle;
  if (companyId) safe.companyId = companyId;
  const risky = {};
  if (person.email) risky.emails = { primaryEmail: person.email };
  return { required, safe, risky };
}

// ---------------------------------------------------------------------------
// I/O orchestrator
// ---------------------------------------------------------------------------

function resolveTool(catalogToolNames, re, fallback) {
  return (catalogToolNames ?? []).find((n) => re.test(n)) || fallback;
}

async function callTool(client, toolName, args) {
  const result = await client.mcpToolsCall("execute_tool", { toolName, arguments: args });
  if (result && result.isError) {
    const text = (result.content ?? []).map((c) => c?.text).filter(Boolean).join(" ").slice(0, 300);
    throw new Error(`${toolName} returned isError: ${text}`);
  }
  return result;
}

/**
 * Create/update a record, retrying without the risky (version-sensitive
 * composite) fields if the tool rejects them, so we never lose a proven field
 * over a guessed shape.
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
 * List existing records of one kind. FAIL-CLOSED: on any error we return
 * { ok: false } so the caller skips creation (assuming absence would duplicate
 * rows on the next run). `args` is per-tool — get_views takes `{}` (the proven
 * connector shape), find_* take a paging limit.
 */
async function listExisting(client, tool, args, log) {
  try {
    const res = await callTool(client, tool, args);
    return { ok: true, records: extractRecordsArray(parseToolJson(res)) };
  } catch (err) {
    log("warn", `${tool} failed (${String(err.message).slice(0, 160)}) — skipping creates in this surface to avoid duplicates`);
    return { ok: false, records: [] };
  }
}

/** Load nameSingular -> objectMetadataId via Twenty's Metadata GraphQL. */
async function loadObjectMetadataIds(client, log) {
  const queries = [
    `query { objects(paging: { first: 200 }) { edges { node { id nameSingular } } } }`,
    `query { objects { edges { node { id nameSingular } } } }`,
  ];
  for (const q of queries) {
    try {
      const data = await client.graphqlMetadata(q, {});
      const objs = (data?.objects?.edges || []).map((e) => e.node).filter(Boolean);
      if (objs.length > 0) return new Map(objs.map((o) => [o.nameSingular, o.id]));
    } catch (err) {
      log("warn", `metadata probe failed: ${String(err.message).slice(0, 160)}`);
    }
  }
  return new Map();
}

/**
 * Upsert one company/person against the provenance sidecar.
 *   - provenance has the id + still present  → rev-gated REPLACE (else skip).
 *   - provenance has the id + record gone    → user deleted → SKIP (never recreate).
 *   - no provenance + list ok                → match by cinatraObjectId, else CREATE.
 *   - no provenance + list failed            → fail-closed SKIP.
 * Returns the record id (for company→person linking) when known.
 */
async function upsertRecord(opts) {
  const { client, kind, entityKind, item, version, provenance, existing, listOk, createTool, updateTool, buildArgs, log, summary } = opts;
  const fx = item.fixtureId;
  try {
    const prov = provenance[fx];
    if (prov && prov.id) {
      const live = existing.find((r) => r && r.id === prov.id);
      if (!live) {
        summary[kind].skipped++; // deleted (or unverifiable) → respect, never recreate
        return prov.id;
      }
      if (version > (prov.rev ?? 0)) {
        // Reclaim ONLY a verifiably fixture-owned row: there must be a stored
        // checksum (legacy entries without one are unverifiable → fail closed)
        // AND the live row must still match it. Otherwise the user edited it
        // (or we can't prove ownership) → preserve, never clobber.
        if (!prov.checksum || comparableChecksum(entityKind, live) !== prov.checksum) {
          summary[kind].skipped++;
          return prov.id;
        }
        const nextChecksum = comparableChecksum(entityKind, item);
        if (nextChecksum === prov.checksum) {
          prov.rev = version; // content unchanged in the manifest → advance rev, no write
          summary[kind].skipped++;
          return prov.id;
        }
        const { required, safe, risky } = buildArgs();
        await upsertWithFallback(client, updateTool, { id: prov.id, ...required, ...safe }, risky, log);
        prov.rev = version;
        prov.checksum = nextChecksum;
        summary[kind].replaced++;
      } else {
        summary[kind].skipped++;
      }
      return prov.id;
    }
    if (!listOk) {
      summary[kind].skipped++; // can't confirm absence → don't risk a duplicate
      return null;
    }
    const hit = findByCinatraObjectId(existing, fx);
    if (hit) {
      const id = hit.id ?? extractRecordId({ structuredContent: hit });
      provenance[fx] = { id, rev: version, checksum: comparableChecksum(entityKind, item) };
      summary[kind].skipped++;
      return id;
    }
    const { required, safe, risky } = buildArgs();
    const res = await upsertWithFallback(client, createTool, { ...required, ...safe }, risky, log);
    const id = extractRecordId(res);
    provenance[fx] = { id, rev: version, checksum: comparableChecksum(entityKind, item) };
    summary[kind].created++;
    return id;
  } catch (err) {
    summary[kind].error++;
    log("warn", `${kind} "${fx}" failed: ${String(err.message).slice(0, 200)}`);
    return provenance[fx]?.id ?? null;
  }
}

/** Upsert one view. Matched by stored id (rename-safe) then by name. */
async function upsertView(opts) {
  const { client, view, version, provenance, existing, listOk, metaIds, createTool, updateTool, log, summary } = opts;
  const fx = view.fixtureId;
  try {
    const prov = provenance[fx];
    if (prov && prov.id) {
      const live = existing.find((r) => r && r.id === prov.id);
      if (!live) {
        summary.views.skipped++; // deleted (or unverifiable) → respect
        return;
      }
      if (version > (prov.rev ?? 0)) {
        // Same fail-closed guard as records: no stored checksum (legacy) or a
        // diverged one (user renamed the view) → preserve, never clobber.
        if (!prov.checksum || comparableChecksum("view", live) !== prov.checksum) {
          summary.views.skipped++;
          return;
        }
        const nextChecksum = comparableChecksum("view", view);
        if (nextChecksum === prov.checksum) {
          prov.rev = version; // unchanged in the manifest → advance rev, no write
          summary.views.skipped++;
          return;
        }
        await callTool(client, updateTool, { id: prov.id, name: view.name });
        prov.rev = version;
        prov.checksum = nextChecksum;
        summary.views.replaced++;
      } else {
        summary.views.skipped++;
      }
      return;
    }
    if (!listOk) {
      summary.views.skipped++;
      return;
    }
    const byName = findViewByName(existing, view.name);
    if (byName) {
      provenance[fx] = { id: byName.id, rev: version, checksum: comparableChecksum("view", view) };
      summary.views.skipped++;
      return;
    }
    const objectMetadataId = metaIds.get(view.objectType);
    if (!objectMetadataId) {
      summary.views.error++;
      log("warn", `view "${fx}" skipped — no object metadata id for "${view.objectType}"`);
      return;
    }
    const res = await callTool(client, createTool, {
      name: view.name,
      objectMetadataId,
      type: view.type ?? "table",
    });
    provenance[fx] = { id: extractRecordId(res), rev: version, checksum: comparableChecksum("view", view) };
    summary.views.created++;
  } catch (err) {
    summary.views.error++;
    log("warn", `view "${fx}" failed: ${String(err.message).slice(0, 200)}`);
  }
}

/**
 * Seed the Twenty section of the manifest. Mutates `provenance`
 * (fixtureId -> { id, rev }) in place so the caller can persist it. Returns a
 * per-surface summary { created, replaced, skipped, error }.
 *
 * `deps`: { client, manifest, catalogToolNames, log, objectMetadataIds?, provenance? }
 */
export async function seedTwentyContent({
  client,
  manifest,
  catalogToolNames = [],
  log = () => {},
  objectMetadataIds,
  provenance = {},
}) {
  const twenty = manifest?.twenty ?? {};
  const version = Number.isInteger(manifest?.version) && manifest.version >= 1 ? manifest.version : 1;
  const summary = {
    companies: { created: 0, replaced: 0, skipped: 0, error: 0 },
    people: { created: 0, replaced: 0, skipped: 0, error: 0 },
    views: { created: 0, replaced: 0, skipped: 0, error: 0 },
    // Whether the existing-records lookup SUCCEEDED per surface. When false the
    // surface was fail-closed (creates skipped) — the caller cannot treat the
    // run as "everything ensured", only "nothing duplicated".
    listOk: { companies: true, people: true, views: true },
  };

  const createCompany = resolveTool(catalogToolNames, /^create_company$/i, "create_company");
  const updateCompany = resolveTool(catalogToolNames, /^update_company$/i, "update_company");
  const createPerson = resolveTool(catalogToolNames, /^create_person$/i, "create_person");
  const updatePerson = resolveTool(catalogToolNames, /^update_person$/i, "update_person");
  const findCompanies = resolveTool(catalogToolNames, /^find_companies$/i, "find_companies");
  const findPeople = resolveTool(catalogToolNames, /^find_people$/i, "find_people");
  const getViews = resolveTool(catalogToolNames, /^get_views$/i, "get_views");
  const createView = resolveTool(catalogToolNames, /^create_view$/i, "create_view");
  const updateView = resolveTool(catalogToolNames, /^update_view$/i, "update_view");

  // ---- Companies ----
  const companies = await listExisting(client, findCompanies, { limit: 200 }, log);
  summary.listOk.companies = companies.ok;
  const companyIdByDomain = new Map();
  for (const company of twenty.companies ?? []) {
    const id = await upsertRecord({
      client,
      kind: "companies",
      entityKind: "company",
      item: company,
      version,
      provenance,
      existing: companies.records,
      listOk: companies.ok,
      createTool: createCompany,
      updateTool: updateCompany,
      buildArgs: () => buildCompanyArgs(company),
      log,
      summary,
    });
    if (id && company.domainName) companyIdByDomain.set(company.domainName, id);
  }

  // ---- People ----
  const people = await listExisting(client, findPeople, { limit: 200 }, log);
  summary.listOk.people = people.ok;
  for (const person of twenty.people ?? []) {
    const companyId = person.companyDomainName ? companyIdByDomain.get(person.companyDomainName) : null;
    await upsertRecord({
      client,
      kind: "people",
      entityKind: "person",
      item: person,
      version,
      provenance,
      existing: people.records,
      listOk: people.ok,
      createTool: createPerson,
      updateTool: updatePerson,
      buildArgs: () => buildPersonArgs(person, companyId),
      log,
      summary,
    });
  }

  // ---- Views ----
  const views = twenty.views ?? [];
  if (views.length > 0) {
    const metaIds = objectMetadataIds ?? (await loadObjectMetadataIds(client, log));
    const existingViews = await listExisting(client, getViews, {}, log);
    summary.listOk.views = existingViews.ok;
    for (const view of views) {
      await upsertView({
        client,
        view,
        version,
        provenance,
        existing: existingViews.records,
        listOk: existingViews.ok,
        metaIds,
        createTool: createView,
        updateTool: updateView,
        log,
        summary,
      });
    }
  }

  return summary;
}
