// Two destination-aware copy variants for the uninstall confirmation Dialog.
// The variant is chosen at modal-open time via extensionHasBeenUsed(extensionId).
// Copywriting Contract Variants A and B — do not rephrase without design sign-off.

export function archiveConfirmCopy(packageTitle: string): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  return {
    title: `Uninstall ${packageTitle}?`,
    description:
      "This extension has been used in agent runs. It will be archived — run history and provenance are preserved. You can restore it later from the Archived tab.",
    confirmLabel: "Archive extension",
  };
}

export function removeConfirmCopy(packageTitle: string): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  return {
    title: `Uninstall ${packageTitle}?`,
    description:
      "This extension has not been used. It will be permanently removed from this workspace. To add it again, reinstall from the marketplace.",
    confirmLabel: "Remove extension",
  };
}
