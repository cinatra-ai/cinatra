"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

type UseBackgroundProcessModalVisibilityOptions = {
  visible: boolean;
  resetOn?: readonly unknown[];
  dismissalKey?: string | null;
};

const DISMISSAL_STORAGE_PREFIX = "cinatra:background-process-modal:dismissed:";

function getDismissalStorageKey(dismissalKey?: string | null) {
  return dismissalKey ? `${DISMISSAL_STORAGE_PREFIX}${dismissalKey}` : null;
}

function serializeResetValue(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readDismissed(storageKey: string | null, visible: boolean) {
  if (!visible) {
    return true;
  }
  if (!storageKey || typeof window === "undefined") {
    return false;
  }
  return window.sessionStorage.getItem(storageKey) === "1";
}

export function useBackgroundProcessModalVisibility({
  visible,
  resetOn = [],
  dismissalKey = null,
}: UseBackgroundProcessModalVisibilityOptions) {
  const storageKey = getDismissalStorageKey(dismissalKey);
  const stateSignature = useMemo(
    () => `${visible ? "visible" : "hidden"}::${storageKey ?? "none"}::${resetOn.map(serializeResetValue).join("||")}`,
    [resetOn, storageKey, visible],
  );
  const [dismissedState, setDismissedState] = useState(() => ({
    signature: stateSignature,
    dismissed: false,
  }));
  const persistedDismissed = useSyncExternalStore(
    () => () => {},
    () => readDismissed(storageKey, visible),
    () => false,
  );
  const dismissed = (dismissedState.signature === stateSignature ? dismissedState.dismissed : false) || persistedDismissed;

  const dismiss = useCallback(() => {
    if (storageKey && typeof window !== "undefined") {
      window.sessionStorage.setItem(storageKey, "1");
    }
    setDismissedState({ signature: stateSignature, dismissed: true });
  }, [stateSignature, storageKey]);

  const show = useCallback(() => {
    if (storageKey && typeof window !== "undefined") {
      window.sessionStorage.removeItem(storageKey);
    }
    setDismissedState({ signature: stateSignature, dismissed: false });
  }, [stateSignature, storageKey]);

  return {
    open: visible && !dismissed,
    dismissed,
    dismiss,
    show,
  };
}
