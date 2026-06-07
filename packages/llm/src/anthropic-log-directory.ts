import path from "node:path";

// Dependency-free leaf module — see
// extensions/cinatra-ai/openai-connector/src/log-directory.ts for the ESM
// init-order cycle this breaks (src/lib/logging.ts reads this at module-init;
// importing it via the @cinatra-ai/llm barrel evaluated telemetry.ts
// → openai/gemini barrels, re-entering logging.ts before the const initialized).
export const ANTHROPIC_API_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "anthropic-api");
