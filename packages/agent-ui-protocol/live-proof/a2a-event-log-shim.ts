// Live-proof shim: resolve `@cinatra-ai/a2a` to the REAL Redis-Streams event
// log ONLY (not the a2a index, which pulls DB deps). Lets the proof exercise
// the genuine durable transport against a real Redis without the package's
// unit-test a2a stub.
export * from "../../a2a/src/event-log";
