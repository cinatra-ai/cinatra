import "server-only";

// ---------------------------------------------------------------------------
// Boot wiring for the test-delivery send PORT (eng#548 #1625).
//
// Side-effect import: injects the host send implementation into the
// packages/agents LEAF port holder so the run-scoped
// `email_test_delivery_run_send` primitive can reach the app's
// email/auth/objects graph at invocation time. Same idiom as
// `register-run-wait-notifier.ts` — but FAIL-CLOSED (the primitive surfaces a
// clear error if this never loaded, never a silent no-op send).
//
// Imported from BOTH boot paths that reach the agents primitive handlers:
//   1. src/lib/mcp-server.ts        — the native MCP transport chain, AND
//   2. src/lib/primitive-handlers.ts — the deterministic /api/agents/passthrough
//      path, which reaches agents handlers WITHOUT loading the native MCP server.
// Importing the LEAF subpath (not the agents barrel) keeps this off any init
// cycle.
// ---------------------------------------------------------------------------

import { setTestDeliverySendPort } from "@cinatra-ai/agents/test-delivery-send-port";
import { testDeliverySendPortImpl } from "@/lib/test-delivery-send-port-impl";

setTestDeliverySendPort(testDeliverySendPortImpl);
