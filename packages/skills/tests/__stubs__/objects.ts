// Lightweight `@cinatra-ai/objects` stub for skills unit tests.
//
// The real package barrel (packages/objects/src/index.ts) eagerly re-exports
// React screens (objects-browser / object-detail / object-types-screen) plus
// the object-type registration bridge, which transitively pull
// @cinatra-ai/workflows, src/lib/background-jobs.ts and
// src/lib/notifications-host.ts — the whole host-app boot graph, none of which
// is reachable from (or relevant to) a skills unit test. The only symbol the
// skills-reachable app code (the blog `register-object-types` bridge) consumes
// is the object-type registry, so re-export just that from the light registry
// module (its only deps are the `./types` type-alias and `./namespace`
// constant). Individual tests vi.mock() the specifier with their own factory
// when they need a different shape.
export { objectTypeRegistry } from "../../../objects/src/registry";
// The app registry-init module (src/lib/register-all-object-types.ts, pulled in
// transitively via artifact-read → ensure-artifact-registry) also reads the
// family→type-id taxonomy from the barrel. Re-export it from the light taxonomy
// module (deps: a type-only authz alias, erased at runtime, plus the `./namespace`
// constants) so the barrel stub stays boot-graph-free.
export { objectTypeIdsForFamily } from "../../../objects/src/taxonomy";
