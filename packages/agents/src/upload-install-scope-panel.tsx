"use client";

// ---------------------------------------------------------------------------
// UploadInstallScopePanel (cinatra#3204 leg 3, criteria 11, 17).
//
// The install-scope step of the Upload Extension screen. It is NOT a second
// implementation of the store's picker: it mounts the store's own
// `ExtensionInstallScopePanel` over the store's own server-computed rows,
// availability states and `Workspace: All` preselection, inside the store's own
// panel-face context. What this file adds is the three things the store's card
// supplies and an upload screen has to supply itself:
//
//   - the CONTEXT the panel reads (installTargets / ownerEntityNames /
//     activeOrgId / availability), resolved once on the server and passed down;
//   - the INSTALL ACTION, which on this road carries the supplied package as
//     well as the chosen target — the panel calls it with the target, and the
//     road's own payload rides the closure;
//   - a Cancel that returns the screen to its "choose a package" state.
//
// CRITERION 17 — the pre-existing run-visibility pickers are GONE from both
// tabs, folded into this one question. An operator is asked once, here, and the
// answer means one thing: who this extension is installed for.
//
// The panel reports failures through the app's toast surface and keeps the
// selection (design spec Extensions §I.1); nothing about that changes here.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { StandaloneInstallPanelFace } from "@cinatra-ai/extensions/screens/card-face-switcher";
import {
  ExtensionInstallScopePanel,
  InstallPanelScopeProvider,
  type ExtensionScopedInstallAction,
  type InstallPanelScopeContextValue,
} from "@cinatra-ai/extensions/screens/extension-install-scope-panel";

/** The card-invariant half, resolved on the server by the Upload screen. */
export type UploadInstallScopeContext = Omit<
  InstallPanelScopeContextValue,
  "installAction"
>;

export function UploadInstallScopePanel({
  scope,
  installAction,
  packageName,
  packageVersion,
  displayName,
  onCancel,
  header,
}: {
  scope: UploadInstallScopeContext;
  installAction: ExtensionScopedInstallAction;
  packageName: string;
  packageVersion: string;
  displayName: string;
  onCancel: () => void;
  /** What was read from the supplied package — shown above the picker. */
  header?: ReactNode;
}) {
  return (
    <div
      data-testid="upload-install-scope"
      className="soft-panel flex flex-col gap-3 rounded-card p-4"
    >
      {header}
      <InstallPanelScopeProvider value={{ ...scope, installAction }}>
        <StandaloneInstallPanelFace onCancel={onCancel}>
          <ExtensionInstallScopePanel
            packageName={packageName}
            packageVersion={packageVersion}
            displayName={displayName}
          />
        </StandaloneInstallPanelFace>
      </InstallPanelScopeProvider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The upload-consent block (cinatra#2092, carried onto BOTH supplied roads by
// cinatra#3204's recorded decision).
//
// It lives beside the scope panel because it is the same moment: the operator is
// looking at what they supplied and deciding what happens to it. It renders ONLY
// when the workspace opt-in is on — with it off nothing can egress, so asking
// would be misleading — and it starts UNTICKED, every time. There is no state
// that survives a cancel, and no default that says yes.
//
// The tick carries the digest of the closure the operator was actually shown, so
// the server's own check can refuse a confirmation of something else.
// ---------------------------------------------------------------------------

export type UploadConsentPromptValue = {
  headline: string;
  advisory: string;
  closureLines: string[];
  closureDigest: string;
  consentApplies: boolean;
};

export function UploadConsentBlock({
  prompt,
  checked,
  onCheckedChange,
}: {
  prompt: UploadConsentPromptValue | null;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  if (!prompt || !prompt.consentApplies) return null;
  return (
    <Alert data-testid="supplied-upload-consent">
      <AlertTitle>{prompt.headline}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{prompt.advisory}</span>
        <ul className="flex flex-col gap-1">
          {prompt.closureLines.map((line) => (
            <li key={line} className="font-mono text-xs">
              {line}
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={checked}
            onCheckedChange={(next) => onCheckedChange(next === true)}
            data-testid="supplied-upload-consent-checkbox"
          />
          <span>
            Allow uploading these skills to the Anthropic Skills API. Leave unchecked to
            install without any upload — you can grant consent later.
          </span>
        </label>
      </AlertDescription>
    </Alert>
  );
}

/** The value the install call carries, or nothing at all when it was not ticked. */
export function consentPayload(
  prompt: UploadConsentPromptValue | null,
  checked: boolean,
): { granted: true; confirmedClosureDigest: string } | undefined {
  if (!prompt || !prompt.consentApplies || !checked) return undefined;
  return { granted: true, confirmedClosureDigest: prompt.closureDigest };
}
