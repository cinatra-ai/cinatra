// Shared loader + validator for the generic external-instance dev content
// fixtures (scripts/fixtures/external-instances.dev-content.json).
//
// This manifest is seeded INTO the local dev Drupal / WordPress / Twenty
// instances (NOT the cinatra-side `cinatra.devFixtures` contract). The Drupal
// and WordPress seeders are PHP (drush / wp-cli) and read the JSON directly;
// this module is the JavaScript side used by the Twenty seeder
// (scripts/fixtures/seed-twenty-content.mjs) and by the manifest unit test.
//
// Dependency-free (Node built-ins only) so it runs from a plain `node` /
// `tsx` context with no install step.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the canonical manifest file. */
export const DEV_CONTENT_MANIFEST_PATH = join(
  HERE,
  "..",
  "external-instances.dev-content.json",
);

// Reserved / non-routable TLDs (RFC 2606 + RFC 6761). Every domain and email
// host in the manifest MUST end in one of these so fixtures can never collide
// with — or appear to endorse — a real organisation.
const RESERVED_TLDS = [".example", ".test", ".invalid", ".localhost"];

const DRUPAL_NODE_TYPES = ["article", "page"];
const WORDPRESS_POST_TYPES = ["post", "page"];
const TWENTY_VIEW_OBJECT_TYPES = ["company", "person", "opportunity"];
const TWENTY_VIEW_TYPES = ["table", "kanban"];

/** Stable SHA-256 over a value with object keys sorted (order-independent). */
export function checksumOf(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Read + parse the manifest from disk (does NOT validate — call the validator). */
export function loadDevContentManifest(path = DEV_CONTENT_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hostOf(emailOrDomain) {
  const s = String(emailOrDomain);
  const at = s.lastIndexOf("@");
  return (at >= 0 ? s.slice(at + 1) : s).trim().toLowerCase();
}

function hasReservedTld(host) {
  return RESERVED_TLDS.some((tld) => host.endsWith(tld));
}

function pushUnique(seen, id, errors, where) {
  if (!id || typeof id !== "string") {
    errors.push(`${where}: missing/invalid fixtureId`);
    return;
  }
  if (seen.has(id)) errors.push(`duplicate fixtureId "${id}" (${where})`);
  seen.add(id);
}

function assertGeneric(text, errors, where) {
  if (typeof text === "string" && /open\s*cloud/i.test(text)) {
    errors.push(`${where}: forbidden non-generic token "OpenCloud" in "${text.slice(0, 60)}"`);
  }
}

/**
 * Validate the manifest structurally + enforce the "generic" guard. Throws an
 * Error listing every problem found (fail-loud, like the devFixtures gate).
 * Returns the manifest on success for chaining.
 */
export function validateDevContentManifest(manifest) {
  const errors = [];
  const ids = new Set();

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("dev-content manifest must be a JSON object");
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    errors.push("`version` must be a positive integer");
  }

  // ---- Drupal ----
  const drupal = manifest.drupal ?? {};
  for (const [i, node] of (drupal.nodes ?? []).entries()) {
    const where = `drupal.nodes[${i}]`;
    pushUnique(ids, node.fixtureId, errors, where);
    if (!DRUPAL_NODE_TYPES.includes(node.type)) {
      errors.push(`${where}: type must be one of ${DRUPAL_NODE_TYPES.join("|")}`);
    }
    if (!node.title || typeof node.title !== "string") errors.push(`${where}: missing title`);
    assertGeneric(node.title, errors, where);
    assertGeneric(node.body, errors, where);
  }
  const cleanup = drupal.legacyCleanup;
  if (cleanup) {
    if (!cleanup.sentinel || typeof cleanup.sentinel !== "string") {
      errors.push("drupal.legacyCleanup.sentinel must be a non-empty string");
    }
    if (!Array.isArray(cleanup.titlePrefixes) || cleanup.titlePrefixes.length === 0) {
      errors.push("drupal.legacyCleanup.titlePrefixes must be a non-empty array");
    }
  }

  // ---- WordPress ----
  const wordpress = manifest.wordpress ?? {};
  for (const [i, post] of (wordpress.posts ?? []).entries()) {
    const where = `wordpress.posts[${i}]`;
    pushUnique(ids, post.fixtureId, errors, where);
    if (!WORDPRESS_POST_TYPES.includes(post.postType)) {
      errors.push(`${where}: postType must be one of ${WORDPRESS_POST_TYPES.join("|")}`);
    }
    if (!post.title || typeof post.title !== "string") errors.push(`${where}: missing title`);
    assertGeneric(post.title, errors, where);
    assertGeneric(post.content, errors, where);
  }

  // ---- Twenty ----
  const twenty = manifest.twenty ?? {};
  for (const [i, c] of (twenty.companies ?? []).entries()) {
    const where = `twenty.companies[${i}]`;
    pushUnique(ids, c.fixtureId, errors, where);
    if (!c.name || typeof c.name !== "string") errors.push(`${where}: missing name`);
    assertGeneric(c.name, errors, where);
    if (c.domainName && !hasReservedTld(hostOf(c.domainName))) {
      errors.push(`${where}: domainName "${c.domainName}" must use a reserved TLD (${RESERVED_TLDS.join(", ")})`);
    }
  }
  const companyDomains = new Set(
    (twenty.companies ?? []).map((c) => (c.domainName ? hostOf(c.domainName) : null)).filter(Boolean),
  );
  for (const [i, p] of (twenty.people ?? []).entries()) {
    const where = `twenty.people[${i}]`;
    pushUnique(ids, p.fixtureId, errors, where);
    if (!p.firstName && !p.lastName) errors.push(`${where}: needs firstName or lastName`);
    assertGeneric(`${p.firstName ?? ""} ${p.lastName ?? ""}`, errors, where);
    if (p.email && !hasReservedTld(hostOf(p.email))) {
      errors.push(`${where}: email "${p.email}" must use a reserved TLD (${RESERVED_TLDS.join(", ")})`);
    }
    if (p.companyDomainName && !companyDomains.has(hostOf(p.companyDomainName))) {
      errors.push(`${where}: companyDomainName "${p.companyDomainName}" does not match any seeded company`);
    }
  }
  for (const [i, v] of (twenty.views ?? []).entries()) {
    const where = `twenty.views[${i}]`;
    pushUnique(ids, v.fixtureId, errors, where);
    if (!v.name || typeof v.name !== "string") errors.push(`${where}: missing name`);
    assertGeneric(v.name, errors, where);
    if (!TWENTY_VIEW_OBJECT_TYPES.includes(v.objectType)) {
      errors.push(`${where}: objectType must be one of ${TWENTY_VIEW_OBJECT_TYPES.join("|")}`);
    }
    if (v.type && !TWENTY_VIEW_TYPES.includes(v.type)) {
      errors.push(`${where}: type must be one of ${TWENTY_VIEW_TYPES.join("|")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid dev-content manifest:\n - ${errors.join("\n - ")}`);
  }
  return manifest;
}
