// Empty stub for the `server-only` package. Aliased via vitest config so
// tests that transitively import `mcp-instructions.ts` (which calls
// `import "server-only"`) do not throw outside Next's server condition.
export {};
