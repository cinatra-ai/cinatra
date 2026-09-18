// ---------------------------------------------------------------------------
// Planted values for the Upload Extension conformance mounts (cinatra#3546;
// design spec Extensions §VIII, shipped by cinatra#3204).
//
// The three mounts beside this file render the REAL Upload components; these
// are the only things the harness supplies — the resolved package the drawing's
// own example shows, and the latency that makes the two `loading` state
// variants observable rather than a race. The install-scope rows are the §I.1
// fixture's own (fixture-data.ts), because the drawing says the resolved panel
// mounts "the same install panel §I.1 already fixes".
//
// The package is FICTIONAL, exactly as the sibling conformance fixtures are: a
// core file never names a real extension instance, and the drawing's §VIII
// example names this one.
// ---------------------------------------------------------------------------

import type { UploadGitHubFormHarness } from "@cinatra-ai/agents/import-skill-from-github-form";
import type { UploadInstallScopeContext } from "@cinatra-ai/agents/upload-install-scope-panel";
import { resolveInstallPanelAvailability } from "@cinatra-ai/extensions/screens/install-panel-availability";

import {
  CONFORMANCE_INSTALL_PANEL_ACTIVE_ORG_ID,
  CONFORMANCE_INSTALL_PANEL_ENTITY_NAMES,
  CONFORMANCE_INSTALL_PANEL_TARGETS,
} from "./fixture-data";

type PlantedPreview = NonNullable<UploadGitHubFormHarness["initialPreview"]>;

/** The resolved package the §VIII example draws. */
export const UPLOAD_CONFORMANCE_PREVIEW: PlantedPreview = {
  kind: "agent",
  packageName: "@acme-labs/research-assistant",
  version: "0.4.2",
  contentDigest: "e".repeat(64),
  resolvedSha: "7c1f9ab3d0e54b2f8a6d41c9e2b70f5a3d8c6e12",
  repo: "acme-labs/research-assistant",
  ref: "main",
  archiveUrl:
    "https://codeload.github.com/acme-labs/research-assistant/zip/refs/heads/main",
};

/**
 * Long enough for the suite to read an in-flight label, short enough that the
 * resolve and the install still settle inside one assertion's timeout.
 */
export const UPLOAD_CONFORMANCE_LATENCY_MS = 700;

/** The link the resolve action is driven with. */
export const UPLOAD_CONFORMANCE_REPO_URL =
  "https://github.com/acme-labs/research-assistant";

/**
 * The card-invariant install context the Upload screen resolves on the server.
 * The REAL availability resolver over the SAME server-computed-shaped rows the
 * §I.1 mount uses, so the picker opens preselected to `Workspace: All`.
 */
export const UPLOAD_CONFORMANCE_INSTALL_SCOPE: UploadInstallScopeContext = {
  installTargets: CONFORMANCE_INSTALL_PANEL_TARGETS,
  ownerEntityNames: CONFORMANCE_INSTALL_PANEL_ENTITY_NAMES,
  activeOrgId: CONFORMANCE_INSTALL_PANEL_ACTIVE_ORG_ID,
  availability: resolveInstallPanelAvailability({
    activeOrgId: CONFORMANCE_INSTALL_PANEL_ACTIVE_ORG_ID,
    installTargets: CONFORMANCE_INSTALL_PANEL_TARGETS,
    fallbackDefaultValue: null,
  }),
};
