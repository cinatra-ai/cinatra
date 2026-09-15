/**
 * THE SCOPE-TAB CARD ROWS (cinatra#2808, per-scope surfaces S2).
 *
 * The eligibility loader decides WHAT a scope lists; this module decides what
 * each row's controls POINT AT. Both halves are pure, and the addresses are not
 * minted here: every href comes from #2809's href contract in `scope-surfaces`,
 * composed with the scope the reader is on, so a launch made from a team lands
 * inside that team and the two slices cannot disagree about an address.
 *
 * NO `/configuration` HREF IS MINTED HERE. The scope tabs are member-facing, and
 * the marketplace detail route is admin-only; a member's "More details" opens
 * the ratified §II modal in place instead of carrying a link that would bounce.
 * That is why `detailHref` is `null` on every row this module builds.
 */
import type { ScopeSurfaceEligibilityRow, ScopeSurfaceStatus } from "./scope-surface-eligibility";
import {
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
  type ScopeSurfaceRef,
} from "./scope-surfaces";

/** One remote connected site's two chat controls, scoped to the read scope. */
export type ScopeAssistantRemoteInstance = {
  readonly instanceId: string;
  readonly name: string;
  /** "Chat locally" — the site-scoped conversation INSIDE this scope. */
  readonly localChatHref: string;
  /** "Remote chat" — the jump-out to the connected site (never re-scoped). */
  readonly remoteHref: string;
};

/** One card on a scope's Agents tab. */
export type ScopeAgentCardRow = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly host: "local";
  readonly packageName: string;
  /** Admin-only full-page detail is never minted for a scope tab — see above. */
  readonly detailHref: null;
  /** The Run control's scoped target (#2809). */
  readonly runHref: string;
  /** The Settings control's scoped, package-specific target (#2809). */
  readonly settingsHref: string;
  readonly version: string | null;
  readonly status: ScopeSurfaceStatus;
};

/** One row on a scope's Assistants tab. */
export type ScopeAssistantCardRow = {
  readonly key: string;
  readonly packageName: string;
  readonly vendor: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  /** The single "Chat" control, scoped (#2809). */
  readonly chatHref: string;
  /** The Settings control's scoped, package-specific target (#2809). */
  readonly settingsHref: string;
  readonly remoteCapable: boolean;
  readonly remoteInstances: readonly ScopeAssistantRemoteInstance[];
  /** The installed-card fields the rows are extended with. */
  readonly version: string | null;
  readonly status: ScopeSurfaceStatus;
};

/** The status the built-in platform assistant is read at: it carries no install
 *  row to take one from, and it is never archived or locked out of a scope. */
const BUILTIN_ASSISTANT_STATUS: ScopeSurfaceStatus = "active";

/** The version as the installed card renders it: the stored version with a
 *  leading `v`, or nothing at all when the install carries none. */
export function formatScopeSurfaceVersion(version: string | null | undefined): string | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/**
 * The Agents tab's rows. Every control is addressed at `scope`: Run at the
 * scoped launcher, Settings at the scoped assignment page.
 */
export function buildScopeSurfaceAgentRows(
  scope: ScopeSurfaceRef,
  rows: readonly ScopeSurfaceEligibilityRow[],
): readonly ScopeAgentCardRow[] {
  return rows.map((row) => ({
    key: row.packageName,
    name: row.displayName,
    description: row.description ?? "",
    host: "local" as const,
    packageName: row.packageName,
    detailHref: null,
    runHref: scopeSurfaceAgentLaunchHref(scope, row.packageName),
    settingsHref: scopeSurfaceAgentSettingsHref(scope, row.packageName),
    version: formatScopeSurfaceVersion(row.version),
    status: row.status,
  }));
}

/** One directory row as the /assistants resolver returns it — the fields this
 *  builder re-scopes. Structurally a subset of `AssistantDirectoryRow`. */
export type ScopeAssistantDirectoryRow = {
  readonly packageName: string;
  readonly vendor: string;
  readonly slug: string;
  readonly displayName: string;
  /**
   * The built-in platform assistant, as the registry reader marks it. It has NO
   * `installed_extension` row by construction — the reader unions its descriptor
   * in unconditionally — so the eligibility join below must not read its absence
   * from the install map as "this scope does not reach it".
   */
  readonly isBuiltin?: boolean;
  readonly remoteCapable: boolean;
  readonly remoteInstances: readonly {
    readonly instanceId: string;
    readonly name: string;
    readonly remoteHref: string;
  }[];
};

/**
 * The Assistants tab's rows: the directory resolver's own rows, with every Chat
 * control re-addressed at `scope` and the installed-card fields joined on by
 * package name.
 *
 * An INSTALLED assistant package's directory row with NO eligible install is
 * dropped: the tab lists what this scope reaches, and the eligibility loader is
 * what decides that. The BUILT-IN platform assistant is the one row that join
 * never gates — it is never an `installed_extension` row, so an installation
 * carrying no assistant package still reaches it — and it is folded in with the
 * installed-card fields it genuinely has: no version, no install description,
 * and the live status every scope reads it at. The Chat
 * control(s) are PRESERVED — a remote-capable assistant keeps one pair per
 * connected site, and only the in-app half is re-scoped (the jump-out addresses
 * the site itself, which no scope owns).
 */
export function buildScopeSurfaceAssistantRows(
  scope: ScopeSurfaceRef,
  directoryRows: readonly ScopeAssistantDirectoryRow[],
  eligible: readonly ScopeSurfaceEligibilityRow[],
): readonly ScopeAssistantCardRow[] {
  const byPackage = new Map(eligible.map((row) => [row.packageName, row]));
  const out: ScopeAssistantCardRow[] = [];
  for (const row of directoryRows) {
    const install = byPackage.get(row.packageName);
    // The eligibility filter gates the INSTALLED assistant packages only. The
    // built-in platform assistant has no install to be eligible, and dropping it
    // here would empty the tab of every installation that has installed no
    // assistant package at all.
    if (!install && !row.isBuiltin) continue;
    const assistant = { vendor: row.vendor, slug: row.slug };
    out.push({
      key: row.packageName,
      packageName: row.packageName,
      vendor: row.vendor,
      slug: row.slug,
      displayName: row.displayName,
      description: install ? install.description : null,
      chatHref: scopeSurfaceAssistantLaunchHref(scope, assistant),
      settingsHref: scopeSurfaceAssistantSettingsHref(scope, assistant),
      remoteCapable: row.remoteCapable,
      remoteInstances: row.remoteInstances.map((instance) => ({
        instanceId: instance.instanceId,
        name: instance.name,
        localChatHref: scopeSurfaceAssistantLaunchHref(scope, {
          ...assistant,
          instance: instance.instanceId,
        }),
        remoteHref: instance.remoteHref,
      })),
      version: install ? formatScopeSurfaceVersion(install.version) : null,
      status: install ? install.status : BUILTIN_ASSISTANT_STATUS,
    });
  }
  return out;
}
