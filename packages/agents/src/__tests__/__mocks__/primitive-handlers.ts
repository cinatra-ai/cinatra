// Vitest stub for `@/lib/primitive-handlers`.
//
// The real module aggregates the platform handler packages plus the
// manifest-discovered connector handlers, each pulling in their server-side
// dependency graphs. Tests in @cinatra-ai/agents don't need the actual handler
// aggregation; they only need the import to resolve. Async to mirror the real
// module's signature (callers `await` it).

export async function collectAllPrimitiveHandlers() {
  return {} as Record<string, unknown>;
}
