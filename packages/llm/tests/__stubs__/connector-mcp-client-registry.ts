// stub — @cinatra-ai/mcp-client-registry-connector functions aren't exercised in unit tests
// that mock the orchestration modules. Provide minimal shapes so imports
// resolve.
export type AnthropicConnectionConfig = {
  apiKey: string;
};

export async function getConfiguredAnthropicConnection(): Promise<AnthropicConnectionConfig | null> {
  return null;
}
