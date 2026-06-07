# @cinatra-ai/llm

Unified LLM orchestration layer for the application. All LLM API calls flow through this package: provider adapters (OpenAI, Anthropic, Gemini) translate one common interface into each SDK's native format, and the orchestration entry points centralize MCP tool injection, skill delivery, attachment resolution, and usage telemetry.

## Public API

### Orchestration entry points
- `generate` / `stream` — provider-transparent generate and streaming calls
- `runDeterministicLlmTask` / `runResolvedDeterministicLlmTask` — single-shot deterministic tasks
- `runSkillAwareDeterministicLlmTask` / `runResolvedSkillAwareDeterministicLlmTask` — tasks with skill delivery
- `generateWithFileInput` / `uploadFile` / `deleteFile` — file-input and provider file management
- `orchestrateSubmitBatch` / `orchestrateRetrieveBatch` / `orchestrateDownloadBatchResults` / `orchestrateCancelBatch` — Batch API dispatch
- `injectMcpTools` — single MCP tool injection site
- `resolveConfiguredLlmRuntime` — resolve the configured default runtime

### Adapter registry and connections
- `resolveProviderAdapter` / `resolveDefaultAdapter` / `resolveFirstAvailableAdapter` — adapter resolution
- `createOpenAIProviderAdapter` / `createAnthropicProviderAdapter` / `createGeminiProviderAdapter` — adapter factories
- `hasConfiguredLlmRuntime`, `getConfiguredOpenAIConnection`, `getConfiguredGeminiConnection` — connection helpers

### Tools, skills, and attachments
- `createShellTool` / `createWebSearchTool` / `createMcpServerTool` / `buildMcpTools` — tool factories
- `selectSkillDeliveryAdapter`, `buildSkillTools`, `resolveSkillSummaries` — provider-specific skill delivery
- `resolveAttachments`, `resolveAttachmentCapability` — attachment resolution and capability rules

### MCP access, telemetry, and actor context
- `buildLlmMcpServerTool`, `getLlmMcpCredentials`, `getPublicMcpServerUrl` — self-MCP access
- `writeLlmLogFile`, `setAnthropicLoggingEnabled` — request logging
- `withActorContext` / `getActorContext` / `getActorContextOrThrow` — ambient actor propagation
- `createStreamUsageEmitter` — streaming usage emission callback
- Types: `LlmProviderAdapter`, `LlmResponse`, `LlmMessage`, `LlmTool`, `LlmUsageData`, and related shapes

### Sub-entry points
- `@cinatra-ai/llm/actor-context` — `AsyncLocalStorage` carrier for the triggering actor
- `@cinatra-ai/llm/anthropic-log-directory` — Anthropic request-log directory constant
- `@cinatra-ai/llm/anthropic-logging-state` — leaf flag module for Anthropic logging

## Usage

```typescript
import { generate } from "@cinatra-ai/llm";

const response = await generate({
  system: "You are a helpful assistant.",
  prompt: "Summarize the latest release notes.",
  actorContext,
});
```

## Docs

See https://docs.cinatra.ai
