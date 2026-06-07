"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ---------------------------------------------------------------------------
// LicenseWarningDialog
//
// Renders an AlertDialog when a copyleft license is detected during an import
// or publish flow. The user must explicitly click the verbatim acknowledge
// button to proceed; Cancel closes the dialog without publishing.
//
// This is an AlertDialog (not Dialog) to ensure correct focus-trap semantics
// for blocking decisions.
// ---------------------------------------------------------------------------

export type LicenseWarningDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** SPDX ID of the detected copyleft license, e.g. "GPL-3.0". */
  spdxId: string;
  /** Called when the user clicks the verbatim acknowledge button. */
  onAcknowledge: () => void;
  /** Called when the user clicks Cancel. */
  onCancel?: () => void;
};

// Locked copy strings; exact wording is part of the user-facing warning contract.
const ACKNOWLEDGE_LABEL = "I acknowledge this is copyleft and I want to proceed";
const CANCEL_LABEL = "Cancel";

function formatTitle(spdxId: string): string {
  return `${spdxId} license detected`;
}

function formatBody(spdxId: string): string {
  return (
    `This package uses the ${spdxId} license, which is copyleft. ` +
    `By installing it, your modifications and dependent code may be required ` +
    `to be released under the same license. ` +
    `Review the license terms before proceeding.`
  );
}

export function LicenseWarningDialog({
  open,
  onOpenChange,
  spdxId,
  onAcknowledge,
  onCancel,
}: LicenseWarningDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{formatTitle(spdxId)}</AlertDialogTitle>
          <AlertDialogDescription>{formatBody(spdxId)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{CANCEL_LABEL}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="license-acknowledge-btn"
            onClick={onAcknowledge}
          >
            {ACKNOWLEDGE_LABEL}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
