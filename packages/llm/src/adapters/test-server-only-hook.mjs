// Node.js module-resolver hook used by test-setup.mjs. Rewrites any import of
// `server-only` to an empty stub so unit tests can run without Next.js's
// webpack alias. Has no effect in production builds.

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      shortCircuit: true,
      url: new URL("./server-only-stub.mjs", import.meta.url).href,
      format: "module",
    };
  }
  return nextResolve(specifier, context);
}
