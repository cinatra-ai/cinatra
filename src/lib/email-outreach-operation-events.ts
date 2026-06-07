import "server-only";

import { EventEmitter } from "node:events";

export type EmailOutreachAsyncOperationKind =
  | "recipient_generation"
  | "initial_generation"
  | "follow_up_generation"
  | "initial_rewrite"
  | "follow_up_rewrite"
  | "initial_send";

export type EmailOutreachAsyncOperationEvent = {
  campaignId: string;
  kind: EmailOutreachAsyncOperationKind;
  jobId: string;
  operationId: string;
  status: string;
  phase?: string;
  message: string;
  updatedAt: string;
};

type CampaignLike = {
  id: string;
  customProperties: Record<string, unknown>;
};

declare global {
  var __cinatraEmailOutreachOperationEventEmitter: EventEmitter | undefined;
}

function getEmitter() {
  if (!globalThis.__cinatraEmailOutreachOperationEventEmitter) {
    globalThis.__cinatraEmailOutreachOperationEventEmitter = new EventEmitter();
    globalThis.__cinatraEmailOutreachOperationEventEmitter.setMaxListeners(0);
  }

  return globalThis.__cinatraEmailOutreachOperationEventEmitter;
}

function toStringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function toOptionalStringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function operationChannel(campaignId: string, kind: EmailOutreachAsyncOperationKind) {
  return `email-outreach:${campaignId}:${kind}`;
}

function isTerminalStatus(status: string) {
  return status === "idle" || status === "saved" || status === "error" || status === "stopped";
}

function encodeStatusEvent(event: EmailOutreachAsyncOperationEvent) {
  return `event: status\ndata: ${JSON.stringify(event)}\n\n`;
}

export function isEmailOutreachAsyncOperationKind(value: string): value is EmailOutreachAsyncOperationKind {
  return (
    value === "recipient_generation" ||
    value === "initial_generation" ||
    value === "follow_up_generation" ||
    value === "initial_rewrite" ||
    value === "follow_up_rewrite" ||
    value === "initial_send"
  );
}

export function coerceEmailOutreachAsyncOperationEvent(input: {
  campaignId: string;
  kind: EmailOutreachAsyncOperationKind;
  payload: Record<string, unknown>;
}): EmailOutreachAsyncOperationEvent {
  const jobId = toStringValue(input.payload.jobId ?? input.payload.operationId);
  const operationId = toStringValue(input.payload.operationId ?? input.payload.jobId);

  return {
    campaignId: input.campaignId,
    kind: input.kind,
    jobId,
    operationId,
    status: toStringValue(input.payload.status, "idle"),
    phase: toOptionalStringValue(input.payload.phase),
    message: toStringValue(input.payload.message),
    updatedAt: toStringValue(input.payload.updatedAt, new Date().toISOString()),
  };
}

export function readEmailOutreachAsyncOperationEventFromCampaign(
  campaign: CampaignLike,
  kind: EmailOutreachAsyncOperationKind,
): EmailOutreachAsyncOperationEvent {
  const props = campaign.customProperties;

  switch (kind) {
    case "recipient_generation":
      return coerceEmailOutreachAsyncOperationEvent({
        campaignId: campaign.id,
        kind,
        payload: {
          jobId: props.cinatra_recipient_generation_job_id,
          status: props.cinatra_recipient_generation_status,
          phase: props.cinatra_recipient_generation_phase,
          message: props.cinatra_recipient_generation_message,
          updatedAt: props.cinatra_recipient_generation_updated_at,
        },
      });
    case "initial_generation":
      return coerceEmailOutreachAsyncOperationEvent({
        campaignId: campaign.id,
        kind,
        payload: {
          jobId: props.cinatra_initial_generation_job_id,
          status: props.cinatra_initial_generation_status,
          phase: props.cinatra_initial_generation_phase,
          message: props.cinatra_initial_generation_message,
          updatedAt: props.cinatra_initial_generation_updated_at,
        },
      });
    case "follow_up_generation":
      return coerceEmailOutreachAsyncOperationEvent({
        campaignId: campaign.id,
        kind,
        payload: {
          jobId: props.cinatra_follow_up_generation_job_id,
          status: props.cinatra_follow_up_generation_status,
          message: props.cinatra_follow_up_generation_message,
          updatedAt: props.cinatra_follow_up_generation_updated_at,
        },
      });
    case "initial_rewrite":
      return coerceEmailOutreachAsyncOperationEvent({
        campaignId: campaign.id,
        kind,
        payload: {
          jobId: props.cinatra_draft_rewrite_job_id,
          status: props.cinatra_draft_rewrite_status,
          message: props.cinatra_draft_rewrite_message,
          updatedAt: props.cinatra_draft_rewrite_updated_at,
        },
      });
    case "follow_up_rewrite":
      return coerceEmailOutreachAsyncOperationEvent({
        campaignId: campaign.id,
        kind,
        payload: {
          jobId: props.cinatra_follow_up_rewrite_job_id,
          status: props.cinatra_follow_up_rewrite_status,
          message: props.cinatra_follow_up_rewrite_message,
          updatedAt: props.cinatra_follow_up_rewrite_updated_at,
        },
      });
    case "initial_send":
      return coerceEmailOutreachAsyncOperationEvent({
        campaignId: campaign.id,
        kind,
        payload: {
          jobId: props.cinatra_send_job_id,
          status: props.cinatra_send_status,
          phase: props.cinatra_send_phase,
          message: props.cinatra_send_message,
          updatedAt: props.cinatra_send_updated_at,
        },
      });
  }
}

export function publishEmailOutreachAsyncOperationEvent(event: EmailOutreachAsyncOperationEvent) {
  getEmitter().emit(operationChannel(event.campaignId, event.kind), event);
}

export function publishEmailOutreachAsyncOperationEventFromCampaign(
  campaign: CampaignLike,
  kind: EmailOutreachAsyncOperationKind,
) {
  publishEmailOutreachAsyncOperationEvent(readEmailOutreachAsyncOperationEventFromCampaign(campaign, kind));
}

export function subscribeToEmailOutreachAsyncOperationEvent(input: {
  campaignId: string;
  kind: EmailOutreachAsyncOperationKind;
  listener: (event: EmailOutreachAsyncOperationEvent) => void;
}) {
  const emitter = getEmitter();
  const channel = operationChannel(input.campaignId, input.kind);
  emitter.on(channel, input.listener);

  return () => {
    emitter.off(channel, input.listener);
  };
}

export function createEmailOutreachAsyncOperationStreamResponse(input: {
  request: Request;
  campaignId: string;
  kind: EmailOutreachAsyncOperationKind;
  initialEvent?: EmailOutreachAsyncOperationEvent;
}) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        input.request.signal.removeEventListener("abort", handleAbort);
        try {
          controller.close();
        } catch {
          // noop
        }
      };

      const push = (event: EmailOutreachAsyncOperationEvent) => {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(encodeStatusEvent(event)));

        if (isTerminalStatus(event.status)) {
          close();
        }
      };

      const unsubscribe = subscribeToEmailOutreachAsyncOperationEvent({
        campaignId: input.campaignId,
        kind: input.kind,
        listener: push,
      });

      const heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }
      }, 15000);

      const handleAbort = () => {
        close();
      };

      input.request.signal.addEventListener("abort", handleAbort);
      controller.enqueue(encoder.encode("retry: 5000\n\n"));
      if (input.initialEvent) {
        push(input.initialEvent);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
