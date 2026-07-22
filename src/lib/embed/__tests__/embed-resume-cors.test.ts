// S5 (cinatra#1221) Lane B §9.3(A) — the resume-GET CORS builder. Proves the
// deferred cross-origin half (#1881) exposes the run-bound resume seam a
// cross-origin browser needs (GET + Authorization + Last-Event-ID) and does NOT
// widen the turn's per-user `cwu_` header onto the resume audience.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildAssistantResumeCorsHeaders } from "@/lib/widget-stream-auth";

const ORIGIN = "https://cms.example.com";

describe("buildAssistantResumeCorsHeaders", () => {
  const h = buildAssistantResumeCorsHeaders(ORIGIN);

  it("reflects the validated origin (never a wildcard) and Vary: Origin", () => {
    expect(h["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(h["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(h["Vary"]).toBe("Origin");
    expect(h["Access-Control-Allow-Credentials"]).toBe("false");
  });

  it("allows the resume GET method + preflight", () => {
    expect(h["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
  });

  it("allows Authorization (the run-bound resume token) AND Last-Event-ID (the SSE cursor)", () => {
    const allowed = h["Access-Control-Allow-Headers"];
    expect(allowed).toContain("Authorization");
    expect(allowed).toContain("Last-Event-ID");
    // §9.3(A): the resume presents its OWN audience token ONLY — never the
    // per-user cwu_ proof; that header must NOT be widened onto this route.
    expect(allowed).not.toContain("X-Cinatra-Widget-User-Token");
  });
});

describe("runs-stream route wiring (source pin)", () => {
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "app", "api", "assistants", "runs", "[runId]", "stream", "route.ts"),
    "utf-8",
  );
  it("exports an OPTIONS preflight and reflects CORS via the resume builder", () => {
    expect(routeSrc).toMatch(/export async function OPTIONS/);
    expect(routeSrc).toMatch(/buildAssistantResumeCorsHeaders/);
  });
  it("attaches the reflected headers to the MODE-2 401 and the stream response", () => {
    expect(routeSrc).toMatch(/status:\s*401,\s*headers:\s*corsHeaders/);
    expect(routeSrc).toMatch(/\.\.\.corsHeaders/);
  });
});
