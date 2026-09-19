"use client";

// ---------------------------------------------------------------------------
// The Upload Extension conformance mounts (cinatra#3546; design spec Extensions
// §VIII, shipped by cinatra#3204).
//
// Three mounts, one per manifest surface of the published `app-extensions`
// body: `upload-extension-screen`, `upload-github-form` and
// `upload-resolved-install-panel`. Each renders the REAL component — the
// screen's own extracted JSX body and the shipped GitHub tab — with planted
// props. The ONLY substitutions are the two bound SERVER actions the harness
// has no session or database for, and the resolved state of the panel mount,
// exactly as the §I.1 install-panel mount substitutes the store's own bound
// action (card-fixtures.tsx).
//
// Kept OFF the pixel-diffed /design-fixtures index page (the convention the
// sibling conformance fixtures state): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import { useState } from "react";

import {
  ImportPackageFromGitHubForm,
  type UploadGitHubFormHarness,
} from "@cinatra-ai/agents/upload-repository-link-form";
import { UploadExtensionScreenBody } from "@cinatra-ai/agents/upload-extension-screen-body";

import {
  UPLOAD_CONFORMANCE_INSTALL_SCOPE,
  UPLOAD_CONFORMANCE_LATENCY_MS,
  UPLOAD_CONFORMANCE_PREVIEW,
} from "./upload-extension-fixture-data";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lookup the harness serves in place of the bound server action. */
const previewPackage: NonNullable<UploadGitHubFormHarness["previewPackage"]> = async () => {
  await wait(UPLOAD_CONFORMANCE_LATENCY_MS);
  return { ok: true, preview: UPLOAD_CONFORMANCE_PREVIEW };
};

/**
 * The install the harness serves in place of the bound server action.
 *
 * `observable.href` is deliberately EMPTY: the shipped form navigates only on a
 * truthy destination, so the mount stays where the suite left it and the
 * outcome is read off the mount's own instrumentation instead of off a route
 * change the harness has nowhere to go to.
 */
function harnessInstall(
  onInstalled: () => void,
): NonNullable<UploadGitHubFormHarness["installPackage"]> {
  return async (input) => {
    await wait(UPLOAD_CONFORMANCE_LATENCY_MS);
    // The substitution stands in for the bound server call, so it holds the
    // submit to the same bar the server holds it to: the install re-reads at
    // exactly the commit the resolve step pinned, and installs for the target
    // the picker resolved. A submit that carried something else is REFUSED
    // here, so `submit-install -> installed` cannot read green off a click the
    // product did not carry through — the marker below is reached only when the
    // shipped panel forwarded the planted pin.
    if (
      input.pin?.resolvedSha !== UPLOAD_CONFORMANCE_PREVIEW.resolvedSha ||
      input.pin?.contentDigest !== UPLOAD_CONFORMANCE_PREVIEW.contentDigest ||
      !input.accessTarget
    ) {
      return { ok: false, error: "the submit did not carry the resolved pin" };
    }
    onInstalled();
    return {
      ok: true,
      kind: UPLOAD_CONFORMANCE_PREVIEW.kind,
      packageName: UPLOAD_CONFORMANCE_PREVIEW.packageName,
      version: UPLOAD_CONFORMANCE_PREVIEW.version,
      observable: { label: "See it in the agents list", href: "" },
      warnings: [],
    };
  };
}

/**
 * `upload-extension-screen` — the screen's own JSX body, the component the
 * route renders, asked for in its BARE form and bounded the way every sibling
 * fixture on this page bounds its component: the harness page already draws the
 * one page shell, and a second one nested in its card re-flows the page the
 * other mounts are measured in. The shipped route keeps the page shell. The GitHub tab is planted resolved so the screen's single
 * `name` reading (the drawing annotates the whole §VIII example, whose only
 * name reading is the resolved package's) is reachable through the real tab
 * strip.
 */
function UploadScreenMount() {
  return (
    <div data-surface-id="upload-extension-screen" data-variant="populated">
      <div className="w-full max-w-3xl">
        <UploadExtensionScreenBody
          outerElement="bare"
          installScope={UPLOAD_CONFORMANCE_INSTALL_SCOPE}
          githubHarness={{ initialPreview: UPLOAD_CONFORMANCE_PREVIEW, previewPackage }}
        />
      </div>
    </div>
  );
}

/**
 * `upload-github-form` — the repository road at rest, so the `resolve-reference`
 * action and the in-flight `loading` state are driven through the shipped
 * lookup transition rather than planted.
 */
function UploadGitHubFormMount() {
  return (
    <div data-surface-id="upload-github-form" data-variant="populated">
      <div className="soft-panel rounded-card px-6 py-5 max-w-2xl">
        <ImportPackageFromGitHubForm
          installScope={UPLOAD_CONFORMANCE_INSTALL_SCOPE}
          harness={{ previewPackage }}
        />
      </div>
    </div>
  );
}

/**
 * `upload-resolved-install-panel` — the same shipped form, opened on the
 * resolved package, so the panel the drawing fixes is the one under assertion.
 * `data-outcome` is the mount's own instrumentation for the install the harness
 * serves; the panel, its readings and its three controls are the product's.
 */
function UploadResolvedPanelMount() {
  const [outcome, setOutcome] = useState("");
  return (
    <div
      data-surface-id="upload-resolved-install-panel"
      data-variant="populated"
      data-outcome={outcome}
    >
      <div className="soft-panel rounded-card px-6 py-5 max-w-2xl">
        <ImportPackageFromGitHubForm
          installScope={UPLOAD_CONFORMANCE_INSTALL_SCOPE}
          harness={{
            initialPreview: UPLOAD_CONFORMANCE_PREVIEW,
            previewPackage,
            installPackage: harnessInstall(() => setOutcome("installed")),
          }}
        />
      </div>
    </div>
  );
}

export function UploadExtensionConformanceFixtures() {
  return (
    <div className="flex flex-col gap-10">
      <UploadScreenMount />
      <UploadGitHubFormMount />
      <UploadResolvedPanelMount />
    </div>
  );
}
