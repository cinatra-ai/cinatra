"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UseBackgroundProcessModalSessionOptions<TStatus extends string> = {
  status: TStatus;
  activeStatuses: readonly TStatus[];
  reopenStatuses?: readonly TStatus[];
  initialOpen?: boolean;
  resetOn?: readonly unknown[];
};

export function useBackgroundProcessModalSession<TStatus extends string>({
  status,
  activeStatuses,
  reopenStatuses = [],
  initialOpen = false,
  resetOn = [],
}: UseBackgroundProcessModalSessionOptions<TStatus>) {
  const [sessionOpen, setSessionOpen] = useState(initialOpen || reopenStatuses.includes(status));
  const previousStatusRef = useRef(status);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    if (reopenStatuses.includes(status) && (status !== previousStatus || !reopenStatuses.includes(previousStatus))) {
      setSessionOpen(true);
    }
    previousStatusRef.current = status;
  }, [reopenStatuses, status]);

  useEffect(() => {
    if (initialOpen) {
      setSessionOpen(true);
    }
  }, [initialOpen, ...resetOn]);

  const show = useCallback(() => {
    setSessionOpen(true);
  }, []);

  const hide = useCallback(() => {
    setSessionOpen(false);
  }, []);

  return {
    open: sessionOpen && activeStatuses.includes(status),
    show,
    hide,
  };
}
