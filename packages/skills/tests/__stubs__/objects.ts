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
