# @cinatra-ai/agents

The core agent package for the Cinatra platform. It owns the full lifecycle of an agent: typed template/version/run records and their store, workflow compilation and execution, scheduled triggers and approval gates, multi-agent orchestration, package publish/install against the registry, and the React screens that drive the agent surfaces.

This package is server-side (`import "server-only"`) and exposes many named sub-entry points for narrower imports.

## Public API

- `createAgentTemplate`, `readAgentTemplates`, `createAgentRun`, `transitionRunStatus` — template, version, and run store helpers
- `AgentTemplateRecord`, `AgentRunRecord`, `AgentRunStatus`, `CompiledStep` — core record and status types
- `CinatraAgentSpec`, `CinatraHandoff`, `CinatraTool`, `CinatraAgentProvider` — runtime typed-agent contract
- `compileWorkflow`, `jsonSchemaToZod` — workflow compilation and schema conversion
- `runAgentBuilderExecutionJob`, `runAgentRunTriggerReleaseJob` — background-job execution entry points
- `triggerAgentRun`, `scheduleTrigger`, `cancelTriggerSchedule`, `isTriggerReleased` — run triggering, scheduling, and gate state
- `estimateRunDuration`, `inferStepSideEffects`, `deriveTriggerMode` — trigger inference and duration estimation
- `cancelOrchestratorRun`, `buildLedgerFromChildren`, `OrchestratorLedgerSchema` — multi-agent orchestration
- `publishToRegistry`, `installRegistryPackage`, `installAgentFromPackage`, `installAgentPackageWithDependencies` — registry publish and install flows
- `publishAgentPackage`, `parseAgentPackageManifest`, `buildAgentPackageFiles` — agent package contract and file building
- `materializeAgentPackageToDisk`, `withInstallLock`, `triggerWayflowReload` — on-disk materialization and runtime reload
- `enforceRunAccess`, `AgentAuthPolicySchema`, `checkConnectorAccess` — run-access auth policy
- `scanOasForLiteralSecrets`, `mergeReviewLanes`, `handleAgentCreationReview` — agent JSON validation and creation review
- `fieldRendererRegistry`, `agentUIOverrideRegistry`, `OrchestratorRunPanel`, `agentPluginScreens` — UI renderers and screens
- `createAgentsModule`, `registerAgentBuilderPrimitives`, `createAgentsPrimitiveHandlers` — host integration and MCP registration

### Sub-entry points

`./store`, `./module`, `./mcp-handlers`, `./schema`, `./auth-policy`, `./screens`, `./pages`, `./cli`, `./db`, `./wayflow-url`, `./extension-handler`, `./package-contract`, `./verdaccio/client`, and others (see `package.json#exports`).

## Usage

```ts
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "@cinatra-ai/agents/wayflow-url";

const url = resolveWayflowUrl(packageName);
const fetchImpl = createWayflowFetch();
```

## Docs

See https://docs.cinatra.ai
