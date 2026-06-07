"use client";

import { useEffect, useRef } from "react";

type UseBackgroundProcessEventStreamOptions<TPayload extends { status?: string }> = {
  endpoint: string;
  enabled: boolean;
  onMessage: (payload: TPayload) => void;
  eventName?: string;
};

function isTerminalStatus(status: string | undefined) {
  return status === "idle" || status === "saved" || status === "error" || status === "stopped";
}

export function useBackgroundProcessEventStream<TPayload extends { status?: string }>({
  endpoint,
  enabled,
  onMessage,
  eventName = "status",
}: UseBackgroundProcessEventStreamOptions<TPayload>) {
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const eventSource = new EventSource(endpoint);

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as TPayload;
        onMessageRef.current(payload);

        if (isTerminalStatus(payload?.status)) {
          eventSource.close();
        }
      } catch {
        // ignore malformed event payloads
      }
    };

    eventSource.addEventListener(eventName, handleMessage as EventListener);

    return () => {
      eventSource.removeEventListener(eventName, handleMessage as EventListener);
      eventSource.close();
    };
  }, [enabled, endpoint, eventName]);
}
