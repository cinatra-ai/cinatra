// ---------------------------------------------------------------------------
// supplied-install-access.ts — the SUPPLIED road's install-scope decision
// (cinatra#3204 criterion 12).
//
// PURE module (no IO, no server-only) so the decision is directly unit-testable
// and can be read by a client component without pulling a server graph.
//
// THE DECISION, recorded here because a decision that lives only in a pull
// request body is a decision nobody can read from the code:
//
//   On the SUPPLIED road (a package the operator hands over as a file or points
//   at in a repository) the install scope is configured for ALL FOUR live kinds
//   — agent, skill, connector and artifact — through the store's own picker
//   primitives, and an ABSENT target is refused fail-closed for every one of
//   them. The store's own `INSTALL_ACCESS_TARGET_KINDS` set is left EXACTLY as
//   it is: extending the storefront's picker to agent and skill is a separate
//   change with its own blast radius across the store road, and this issue does
//   not make it silently.
//
// So there are two sets, and they are deliberately not the same set:
//
//   INSTALL_ACCESS_TARGET_KINDS          — the STORE road (connector, artifact,
//                                          workflow). Unchanged by this issue.
//   SUPPLIED_INSTALL_ACCESS_TARGET_KINDS — the SUPPLIED road (all four live
//                                          kinds). Introduced by this issue.
//
// The second is not a widening of the first: it governs a different road, whose
// whole premise is that the operator was asked which scope to install at before
// anything was written. A road that asks the question must honour the answer for
// every kind, or the question was theatre for two of the four.
// ---------------------------------------------------------------------------

import {
  SUPPLIED_PACKAGE_KINDS,
  type SuppliedPackageKind,
} from "@cinatra-ai/extension-types";

import type { InstallAccessTarget } from "./install-access-target";

/**
 * The kinds whose SUPPLIED install requires an explicit access target. All four
 * live kinds — see the decision above.
 */
export const SUPPLIED_INSTALL_ACCESS_TARGET_KINDS = SUPPLIED_PACKAGE_KINDS;

export type SuppliedInstallAccessTargetKind = SuppliedPackageKind;

export function isSuppliedInstallAccessTargetKind(
  value: unknown,
): value is SuppliedInstallAccessTargetKind {
  return (SUPPLIED_INSTALL_ACCESS_TARGET_KINDS as readonly string[]).includes(
    String(value),
  );
}

/**
 * WHICH resource the persisted access policy hangs off, per kind.
 *
 * The connector and artifact kinds carry their access on the CANONICAL
 * `installed_extension` row — that is what the store road already does, and this
 * road does the identical thing rather than inventing a second placement.
 *
 * The agent and skill kinds carry theirs on their NATIVE row (the agent template
 * / the skill package), because that is the resource their own permission
 * surfaces already read; writing an agent's audience onto the canonical row
 * would put it somewhere no agent reader looks.
 *
 * `accessKind` is the `ExtensionKind` the sanctioned writer
 * (`setExtensionInstallAccess`) is called with, so there is exactly one write
 * path for all four kinds.
 */
export type SuppliedInstallAccessResource = {
  accessKind: "agent_template" | "skill_package" | "connector" | "artifact";
  /** Where the resource id comes from. */
  carrier: "native-row" | "canonical-row";
};

const SUPPLIED_INSTALL_ACCESS_RESOURCE: Record<
  SuppliedInstallAccessTargetKind,
  SuppliedInstallAccessResource
> = {
  agent: { accessKind: "agent_template", carrier: "native-row" },
  skill: { accessKind: "skill_package", carrier: "native-row" },
  connector: { accessKind: "connector", carrier: "canonical-row" },
  artifact: { accessKind: "artifact", carrier: "canonical-row" },
};

export function resolveSuppliedInstallAccessResource(
  kind: SuppliedInstallAccessTargetKind,
): SuppliedInstallAccessResource {
  const resource = SUPPLIED_INSTALL_ACCESS_RESOURCE[kind];
  if (!resource) {
    // Fail closed: a kind with no declared access placement has no sanctioned
    // place to record the operator's answer, and installing it anyway would
    // leave the package at whatever default the kind happens to have.
    throw new Error(
      `[supplied-install-access] no install-access placement is declared for the kind "${kind}" — ` +
        `refusing a supplied install whose chosen scope could not be recorded anywhere.`,
    );
  }
  return resource;
}

/**
 * The fail-closed precondition every supplied install runs BEFORE it writes
 * anything: the operator's chosen scope must be present, for every kind.
 *
 * The store road refuses an absent target only for the kinds in
 * `INSTALL_ACCESS_TARGET_KINDS` and otherwise falls through to a per-kind
 * default. On this road there is no such fall-through: the screen asked the
 * question, so an install arriving without the answer is a caller that skipped
 * the screen, and it is refused rather than defaulted.
 */
export function assertSuppliedInstallAccessTarget(
  kind: string,
  target: InstallAccessTarget | undefined | null,
): asserts target is InstallAccessTarget {
  if (!isSuppliedInstallAccessTargetKind(kind)) {
    throw new Error(
      `[supplied-install-access] "${kind}" is not a kind this product installs from a supplied package ` +
        `(accepted: ${SUPPLIED_INSTALL_ACCESS_TARGET_KINDS.join(", ")}).`,
    );
  }
  if (!target) {
    throw new Error(
      `[supplied-install-access] a supplied install of kind "${kind}" requires an explicit install scope — ` +
        `refusing before any write rather than falling back to the kind's default audience.`,
    );
  }
}
