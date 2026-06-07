"use strict";

// Generic one-shot operator migration CORE — bind WordPress instances whose
// `siteUrl` host matches a host-suffix predicate to a named blog-connector id, for
// rows that PREDATE the `blogConnectorId` field (empty/undefined only).
//
// This replaces the former boot-time blog-connector self-heal host hook
// (removed when the host code became VENDOR-AGNOSTIC): the operator now
// passes the host-suffix + connector-id at run time
// (the live invocation lives in the runbook, never in source or tests). The core is
// PURE + idempotent + lossless: it only touches unset rows, preserves every other
// instance + settings field, and performs no network I/O.

/**
 * @param {{ instances?: Array<{ id: string, siteUrl?: string, blogConnectorId?: string }> }} settings
 * @param {{ hostSuffix: string, connectorId: string }} opts
 * @returns {{ settings: any, changedInstanceIds: string[] }}
 */
export function bindBlogConnectorByHostSuffix(settings, { hostSuffix, connectorId } = {}) {
  const suffix = String(hostSuffix ?? "").trim().toLowerCase();
  const id = String(connectorId ?? "").trim();
  if (!suffix) throw new Error("bindBlogConnectorByHostSuffix: hostSuffix is required");
  if (!id) throw new Error("bindBlogConnectorByHostSuffix: connectorId is required");

  // Normalize to a leading-dot form so ".example.com" matches a subdomain
  // ("blog.example.com") AND the apex ("example.com"); never a bare-suffix
  // false-positive ("notexample.com").
  const dotSuffix = suffix.startsWith(".") ? suffix : "." + suffix;
  const apex = dotSuffix.slice(1);

  const instances = Array.isArray(settings?.instances) ? settings.instances : [];
  const changedInstanceIds = [];
  const nextInstances = instances.map((instance) => {
    if (instance.blogConnectorId) return instance; // idempotent — only unset rows
    let host;
    try {
      // `.hostname` (NOT `.host`) — exclude any port so "blog.example.com:8443"
      // still matches ".example.com".
      host = new URL(instance.siteUrl).hostname.toLowerCase();
    } catch {
      return instance; // unparseable siteUrl — leave untouched
    }
    if (host !== apex && !host.endsWith(dotSuffix)) return instance;
    changedInstanceIds.push(instance.id);
    return { ...instance, blogConnectorId: id };
  });

  return { settings: { ...settings, instances: nextInstances }, changedInstanceIds };
}
