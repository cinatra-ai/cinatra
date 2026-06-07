import "server-only";
import type {
  Actor,
  ExtensionTypeHandler,
  PackageRef,
  ValidationResult,
} from "@cinatra-ai/extension-types";
import { visibleManifestPackageNames } from "@cinatra-ai/extension-types";
import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog";

// ---------------------------------------------------------------------------
// ConnectorExtensionTypeHandler.
//
// Registers `kind:"connector"` as a first-class extension kind alongside
// `agent` and `skill`.
//
// MODEL-B: a connector that ships NO bundled React — it declares its
// setup/settings surface as DATA via `cinatra.configSchema` and sets
// `cinatra.uiSurface: "schema-config"` — IS runtime-installable. The host
// renderer (`@/lib/connector-ui-render`) draws its surface from the materialized
// `package.json` at request time, so the dispatcher's real-integrity pipeline
// (materialize → provenance → finalize → hot-activate) can pick it up WITHOUT a
// rebuild. So this handler's `install`/`update`/`uninstall` must NOT throw for a
// schema-config connector — they MUST let the dispatch proceed so the row is
// created + the pipeline materializes + activates it.
//
// A `bundled-react` connector (its React setup page is base-image-only — an App
// Router RSC limitation) CANNOT be hot-installed. For it, `install`/`update`
// raise the TYPED `ConnectorRequiresRebuildError` — a distinct, surfaced
// "requires rebuild" state (mirroring `WorkflowInstallRequiresRebuildError`),
// NEVER the old unrecoverable `kind:"connector" does not support runtime install`
// crash that aborted the dispatch before a row/pipeline could run.
//
// uiSurface is resolved via the injected `resolveUiSurface` dep (the host wires
// the manifest-reading default in `src/lib/extensions.ts`; tests inject a fake).
// When no resolver is wired (a worker that never wired it, or a unit test), the
// handler treats the connector as model-B (allow through) — fail-OPEN to the
// runtime path is correct here: a genuinely bundled-react connector still
// surfaces requires-rebuild downstream at render time (`connector-ui-render`),
// so the worst case is a materialized package whose React page is rebuild-only,
// never a crash or a silently-blocked schema-config install.
//
// What this handler DOES:
//   - validate(spec): confirms package.json declares `cinatra.kind ===
//     "connector"` + the generic-vendor kind-at-end name convention.
//   - install/update: model-B → clean audit no-op (the dispatcher pipeline owns
//     the real materialize/activate); bundled-react → ConnectorRequiresRebuildError.
//   - uninstall: clean audit no-op — the dispatcher owns canonical-row teardown +
//     in-memory capability teardown, so a hot-installed model-B connector IS
//     uninstallable. (Workspace-compiled connectors have no runtime row to drop;
//     the no-op is harmless for them.)
//   - archive/restore: audit-friendly no-op + log (rows preserved).
// ---------------------------------------------------------------------------

/** The "requires rebuild" surfaced state for a bundled-react connector — its
 *  React setup page is base-image-only, so it cannot be hot-installed at runtime.
 *  Typed (NOT a generic Error) so the dispatch / MCP layer surfaces it as a clear
 *  state rather than a 500. Mirrors `WorkflowInstallRequiresRebuildError`. */
export class ConnectorRequiresRebuildError extends Error {
  readonly code = "REQUIRES_REBUILD";
  constructor(
    public readonly packageName: string,
    operation: string,
  ) {
    super(
      `kind:"connector" extension "${packageName}" ships a bundled React setup page, ` +
        `which cannot be hot-${operation}ed at runtime (App Router RSC limitation). ` +
        `It becomes available after a base-image rebuild that includes this connector. ` +
        `A schema-config connector (cinatra.uiSurface: "schema-config" + cinatra.configSchema) ` +
        `installs at runtime with no rebuild.`,
    );
    this.name = "ConnectorRequiresRebuildError";
  }
}

/** Resolves a connector's declared `cinatra.uiSurface` (or null when absent).
 *  Injected so the handler stays self-contained + unit-testable without a
 *  registry round-trip. */
export type ConnectorUiSurfaceResolver = (
  ref: PackageRef,
) => Promise<"schema-config" | "bundled-react" | null>;

export type ConnectorExtensionHandlerDeps = {
  resolveUiSurface?: ConnectorUiSurfaceResolver;
};

export function createConnectorExtensionHandler(
  deps: ConnectorExtensionHandlerDeps = {},
): ExtensionTypeHandler {
  // Decide whether `operation` (install/update) must raise requires-rebuild. A
  // resolved `bundled-react` blocks; schema-config / null / no-resolver allow
  // through. A resolver THROW (registry unreachable) fails OPEN to the runtime
  // path — the downstream render-time guard still surfaces requires-rebuild for a
  // genuine bundled-react page, so we never block a model-B install on a transient
  // registry read failure.
  async function assertRuntimeInstallable(ref: PackageRef, operation: string): Promise<void> {
    if (!deps.resolveUiSurface) return;
    let uiSurface: "schema-config" | "bundled-react" | null;
    try {
      uiSurface = await deps.resolveUiSurface(ref);
    } catch (err) {
      console.warn(
        `[connectorExtensionHandler] uiSurface resolve failed for "${ref.packageName}" ` +
          `(treating as runtime-installable; render-time guard still gates bundled-react):`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    if (uiSurface === "bundled-react") {
      throw new ConnectorRequiresRebuildError(ref.packageName, operation);
    }
  }

  return {
    typeId: "connector",

    async install(ref: PackageRef, _actor: Actor): Promise<void> {
      // Model-B (schema-config / no declared surface): clean no-op — let the
      // dispatcher's real-integrity pipeline materialize + hot-activate it.
      // Bundled-react: raise the typed requires-rebuild state.
      await assertRuntimeInstallable(ref, "install");
      console.info(
        `[connectorExtensionHandler] runtime install permitted for "${ref.packageName}" ` +
          `(model-B / schema-config — dispatcher pipeline materializes + activates)`,
      );
    },

    async update(ref: PackageRef, _actor: Actor): Promise<void> {
      await assertRuntimeInstallable(ref, "update");
      console.info(
        `[connectorExtensionHandler] runtime update permitted for "${ref.packageName}" ` +
          `(model-B / schema-config — dispatcher pipeline re-materializes + re-activates)`,
      );
    },

    async uninstall(ref: PackageRef, _actor: Actor): Promise<void> {
      // Clean audit no-op: the dispatcher owns canonical-row teardown + the
      // in-memory capability teardown, so a hot-installed model-B connector is
      // uninstallable. Workspace-compiled connectors have no runtime row — the
      // no-op is harmless for them.
      console.info(
        `[connectorExtensionHandler] uninstall recorded for "${ref.packageName}" ` +
          `(dispatcher owns canonical-row + capability teardown)`,
      );
    },

    async archive(ref: PackageRef, _actor: Actor): Promise<void> {
      // Soft archive - workspace-compiled connectors keep working; the audit
      // entry records operator intent for archive-aware runtimes. No DB writes
      // today since there's no `connector_lifecycle` table; the extension
      // registry's own audit log captures the call.
      console.info(
        `[connectorExtensionHandler] archive recorded for "${ref.packageName}" (workspace-compiled - connector remains live)`,
      );
    },

    async restore(ref: PackageRef, _actor: Actor): Promise<void> {
      // Inverse of archive - same no-op semantics for workspace-compiled.
      console.info(
        `[connectorExtensionHandler] restore recorded for "${ref.packageName}" (workspace-compiled - already live)`,
      );
    },

    /**
     * Real validation for the connector spec. Confirms the package
     * conforms to the kind-at-end convention:
     *   - has `cinatra.kind === "connector"` in package.json
     *   - package name matches the generic-vendor pattern
     *     `@<vendor>/<slug>-connector`
     *   - `cinatra.visibility` (when set) is "admin" or "workspace"
     *
     * Vendor-agnosticism note: this handler, and the catalog-descriptor /
     * connector-policy-preflight / publish-purge validation surfaces it
     * backs, key exclusively on `cinatra.kind` + the generic-vendor name
     * regex. None hard-code the `@cinatra-ai` scope, so they admit any
     * `@<vendor>/<slug>-connector` package without further change. The
     * only `@cinatra-ai` token in this file is the
     * `@cinatra-ai/extension-types` type import, which is vendor-neutral
     * infrastructure.
     */
    async validate(spec: unknown): Promise<ValidationResult> {
      const errors: string[] = [];
      const s = spec as {
        name?: unknown;
        cinatra?: { kind?: unknown; visibility?: unknown };
      } | null;
      if (!s || typeof s !== "object") {
        return { valid: false, errors: ["spec is not an object"] };
      }
      if (typeof s.name !== "string") {
        errors.push("package.json is missing `name`");
      } else if (!GENERIC_VENDOR_CONNECTOR_NAME_RE.test(s.name)) {
        // Generic-vendor regex with a strict policy boundary: any
        // `@<vendor>/<slug>-connector` package is admissible, but the
        // boundary (kind:"connector" + package-name-to-realpath match under
        // extensions/<vendor>/<slug>-connector + default admin visibility
        // + static loader entries only) is enforced unchanged. Generic
        // vendor scopes widen the namespace, while this boundary prevents
        // the widening from becoming a permissive wildcard.
        errors.push(
          `package name "${s.name}" does not match the kind-at-end convention ` +
            `(expected @<vendor>/<slug>-connector generic-vendor rule)`,
        );
      }
      const kind = s.cinatra?.kind;
      if (kind !== "connector") {
        errors.push(
          `package.json must declare \`cinatra.kind: "connector"\` (got ${JSON.stringify(kind)})`,
        );
      }
      // `cinatra.visibility` is optional; when absent the policy default is
      // "admin" (applied at registration time, not a validate-time error).
      // When set, it must be a known value.
      const visibility = s.cinatra?.visibility;
      if (visibility !== undefined && visibility !== "admin" && visibility !== "workspace") {
        errors.push(
          `package.json \`cinatra.visibility\` (when set) must be "admin" or "workspace" (got ${JSON.stringify(visibility)})`,
        );
      }
      return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
    },

    // Reader facet. The connector catalog is the kind's native descriptor
    // source, but it carries NO per-owner visibility of its own — every
    // descriptor is a deployment-shipped capability. So the active-gate
    // `manifests` (intersected through the shared owner-scope helper) are the
    // sole authority for which packages this actor may discover: a descriptor
    // surfaces only when its `packageId` is BOTH lifecycle-live AND owner-visible.
    //
    // This is lifecycle discovery, not the read/use/manage gate. The
    // descriptor's `defaultVisibility` (admin | workspace) is deliberately NOT
    // enforced here — connector-policy owns that downstream decision.
    async listActive({ scope, manifests }) {
      const live = visibleManifestPackageNames(manifests, scope);
      return listConnectorDescriptors().filter((d) => live.has(d.packageId));
    },
  };
}

/**
 * Generic-vendor regex for `@<vendor>/<slug>-connector`.
 *
 * Vendor segment: `^@[a-z0-9][a-z0-9-]*` - npm namespace, must start with
 *   lowercase alphanumeric, hyphens allowed after.
 * Slug segment: `[a-z0-9][a-z0-9-]*-connector$` - kind-at-end convention.
 *
 * The kind:"connector" semantic gate enforces that non-connector packages
 * (-agent / -skill / -artifact) routed to this handler are rejected, even
 * when the suffix portion happens to match.
 */
export const GENERIC_VENDOR_CONNECTOR_NAME_RE =
  /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-connector$/;

/**
 * defaultConnectorVisibility resolves the policy default for
 * `cinatra.visibility` when the package.json omits the field.
 *
 * Used by registration-time policy enforcement (NOT by validate() - a
 * missing visibility is not a spec error; it's a defaulting decision).
 */
export function defaultConnectorVisibility(spec: {
  cinatra?: { visibility?: unknown };
}): "admin" | "workspace" {
  const v = spec.cinatra?.visibility;
  if (v === "workspace") return "workspace";
  return "admin";
}

/**
 * Package-name-to-realpath match.
 *
 * Confirms `@<vendor>/<slug>-connector` lives at
 * `<extensionsRoot>/<vendor>/<slug>-connector/` AFTER `realpath` resolution.
 * Rejects symlink escape: the resolved path MUST start with `realpath(extensionsRoot)`.
 *
 * Returns `{valid: true}` on match; otherwise `{valid: false, reason}`.
 *
 * Sync version: callers that already have `realpathSync` access (the boot
 * scanner / dev-watcher) call this directly. An async variant could wrap
 * `fs/promises.realpath` if a non-boot caller appears.
 */
export function checkConnectorRealpathMatch(input: {
  packageName: string;
  packageRealpath: string;
  extensionsRootRealpath: string;
}): { valid: true } | { valid: false; reason: string } {
  const match = input.packageName.match(GENERIC_VENDOR_CONNECTOR_NAME_RE);
  if (!match) {
    return {
      valid: false,
      reason: `package name "${input.packageName}" does not match the generic-vendor connector regex`,
    };
  }
  // Strip leading `@`, split on `/`.
  const [vendor, slug] = input.packageName.slice(1).split("/", 2);
  if (!vendor || !slug) {
    return { valid: false, reason: `package name "${input.packageName}" could not be split into vendor/slug` };
  }
  const expectedPathSuffix = `${vendor}/${slug}`;
  // Path equality after realpath: the package's realpath must end at
  // `<extensionsRootRealpath>/<vendor>/<slug>` (exactly, not a parent /
  // sibling / symlink to elsewhere).
  const expected = `${input.extensionsRootRealpath.replace(/\/+$/, "")}/${expectedPathSuffix}`;
  const actual = input.packageRealpath.replace(/\/+$/, "");
  if (actual !== expected) {
    return {
      valid: false,
      reason: `package "${input.packageName}" realpath ${actual} does not match expected ${expected} (rejects symlink escape)`,
    };
  }
  // Final guard: even if the suffix matches, ensure the resolved path
  // begins within the extensions tree.
  const rootRealpath = input.extensionsRootRealpath.replace(/\/+$/, "");
  if (!actual.startsWith(`${rootRealpath}/`)) {
    return {
      valid: false,
      reason: `package "${input.packageName}" realpath ${actual} escapes the extensions root ${rootRealpath}`,
    };
  }
  return { valid: true };
}
