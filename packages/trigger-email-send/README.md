# @cinatra-ai/trigger-email-send

This package defines the email-outreach send primitives for Cinatra. It exposes MCP handlers and
metadata for triggering test sends, starting and tracking initial campaign sends, and running the
backing send/follow-up jobs. The handlers are thin: they validate input with Zod and delegate to a
caller-supplied use-case implementation, so the host app owns delivery, persistence, and scheduling.

## Public API

- `createTriggerEmailSendHandlers` — builds the MCP primitive handler map from a use-case object.
- `TriggerEmailSendUseCases` — the use-case contract the host must implement.
- `AsyncOperationState` — shape returned by long-running send operations.
- `triggerEmailSendPrimitiveMetadata` — per-primitive metadata (visibility, mutation, approval policy).
- `TriggerEmailSendPrimitiveMetadata` — type for a single metadata entry.
- `testSendSchema` — Zod schema validating test-send input.

The handler map covers: `email_outreach_send_test_start`, `email_outreach_send_initial_start`,
`email_outreach_send_initial_status`, `email_outreach_send_initial_cancel`, and the internal
`email_outreach_system_jobs_initial_send_run` and `email_outreach_system_process_due_follow_ups`.

## Usage

```ts
import {
  createTriggerEmailSendHandlers,
  triggerEmailSendPrimitiveMetadata,
  type TriggerEmailSendUseCases,
} from "@cinatra-ai/trigger-email-send";

const useCases: TriggerEmailSendUseCases = /* host implementation */;
const handlers = createTriggerEmailSendHandlers(useCases);

// Register `handlers` and `triggerEmailSendPrimitiveMetadata` with the MCP server.
```

## Docs

See https://docs.cinatra.ai
