#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const policy = {
  image: "skip_runtime", test: "skip_feedback", "skills-unit": "skip",
  "a2a-unit": "skip", "execution-plane-unit": "skip", "package-unit-suites": "skip",
  "hosted-mcp-wire-gate": "skip", "chat-hitl-held-turn-e2e": "skip_runtime",
};
export function prerequisiteFailures(needs) {
  if (needs?.detect?.result !== "success") return ["impact detection did not succeed"];
  const failures = [];
  for (const [job, output] of Object.entries(policy)) {
    const decision = needs.detect.outputs?.[output];
    if (decision !== "true" && decision !== "false") { failures.push(`${job}: missing or invalid ${output}`); continue; }
    const result = needs[job]?.result;
    if (result === "success" || (decision === "true" && result === "skipped")) continue;
    failures.push(`${job}: ${result ?? "missing"}; ${decision === "true" ? "only success or an intentional skip is allowed" : "selected work must succeed"}`);
  }
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let needs;
  try { needs = JSON.parse(process.env.CI_NEEDS ?? "null"); } catch { /* missing is refused */ }
  const failures = prerequisiteFailures(needs);
  for (const failure of failures) console.error(`::error::${failure}`);
  if (failures.length) process.exit(1);
  console.log("Every selected prerequisite passed; every skip was explicitly selected.");
}
