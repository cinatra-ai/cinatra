# @cinatra-ai/objects

The substrate for typed objects in Cinatra. It defines the object taxonomy and type
registries, classifies and identifies objects, exposes the `objects_*` MCP primitives for
storing and retrieving typed observations, and provides the admin screens that browse them.
Postgres is the authoritative store; a Graphiti-backed knowledge graph is a derived index
used for semantic and relationship retrieval.

## Public API

- `objectTypeRegistry` — static registry of known object types.
- `registerAllObjectTypes` — register the built-in static object types at startup.
- `OBJECT_CATEGORIES`, `UI_FAMILIES`, `ARTIFACT_STATUSES`, `OBJECT_TYPE_FAMILY` — the locked taxonomy.
- `OBJECT_TYPE_NAMESPACE_RE`, `isNamespacedObjectTypeId`, `isKnownObjectTypeId` — type-id validators.
- `classifyObject`, `ClassifierOutput` — LLM-based object type classification.
- `resolveIdentity`, `hashIdentity` — derive a stable identity hash from object data.
- `ensureDynamicObjectType`, `approveDynamicObjectType`, `archiveDynamicObjectType` — manage runtime-discovered types.
- `canCompose`, `findCompositionMatches` — agent input/output composability checks.
- `agentIOSpecSchema`, `AgentIOSpec`, `AgentIOPort` — agent I/O port schema and types.
- `semanticArtifactManifestSchema`, `parseSemanticArtifactManifest` — semantic artifact manifest parsing.
- `decideDispatch`, `DispatchDecision` — pure agent-output dispatch decision logic.
- `objectSyncAdapterRegistry`, `ObjectSyncAdapter`, `StoredObject` — outbound sync adapter interface and registry.
- `createObjectsPrimitiveHandlers`, `registerObjectsPrimitives` — MCP handler factory and registration.
- `createDeterministicObjectsClient`, `objectsClient`, `createSessionObjectsClient` — in-process clients.
- `createObjectsModule` — host integration entry point.
- `ObjectsBrowserScreen`, `ObjectDetailPage`, `ObjectTypesScreen` — admin screens.

Named sub-entry points (see `package.json` `exports`): `@cinatra-ai/objects/registry`,
`/auto-registrar`, `/namespace`, `/renderer-types`, `/module`, `/mcp-handlers`,
`/graphiti-client`, `/graphiti-projector`, `/sync-adapters/registry`,
`/classifier-signals`, `/register-artifact-extensions`.

Import registry and registrar helpers from their sub-paths, not the barrel, to avoid
host-only transitive dependencies:

```typescript
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { ensureDynamicObjectType } from "@cinatra-ai/objects/auto-registrar";
```

## Docs

See https://docs.cinatra.ai
