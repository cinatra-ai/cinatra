// COMPILE-PROOF — a connector can now build an `LlmProviderAdapter` from the
// sdk-extensions ABI leaf ALONE (llm-providers S4.0, cinatra#1715 PR-0).
//
// The whole point of the S4.0 carve-out: an LLM connector extension may import
// ONLY `@cinatra-ai/sdk-extensions` (+ `@cinatra-ai/sdk-ui`). Before this slice
// the concrete `LlmProviderAdapter` type + its request-assembly/delivery floor
// lived in `@cinatra-ai/llm` (core, connector-unreachable), so a connector
// COULD NOT type an adapter. This file proves the type + its full transitive
// closure now resolve from the neutral leaf via the PUBLIC subpath specifier
// `@cinatra-ai/sdk-extensions/llm-provider-adapter-contract` — NOT a relative
// path, NOT anything from `@cinatra-ai/llm` — so the import mirrors exactly what
// a connector build sees. It participates in the wholesale `tsgo --noEmit`
// typecheck (this is a real `.ts` under src, only `__tests__/fixtures/**` is
// excluded), so the assignment below is a genuine COMPILE proof, not merely
// vitest transpilation (which erases types).
import { describe, expect, it } from "vitest";
import type {
  LlmProviderAdapter,
  GenerateInput,
  LlmResponse,
  StreamInput,
  UploadFileInput,
  LlmFileReference,
  LlmBatchSubmitInput,
  LlmBatchSubmitResult,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

// A connector-shaped, provider-agnostic adapter typed SOLELY against the leaf.
// If the closure were incomplete (a referenced type still stranded in core),
// this declaration would not compile.
const fixtureAdapter: LlmProviderAdapter = {
  provider: "openai",
  defaultModel: "test-model",
  async generate(input: GenerateInput): Promise<LlmResponse> {
    return {
      text: `echo:${input.prompt}`,
      status: "completed",
      incompleteReason: null,
      rawBody: "{}",
    };
  },
  async stream(input: StreamInput): Promise<void> {
    input.onTextDelta("ok");
    input.onStepEnd(0);
  },
  // Optional members are part of the same closure — exercise a couple so their
  // input/output types are proven leaf-resolvable too.
  async uploadFile(input: UploadFileInput): Promise<LlmFileReference> {
    return { id: `file_${input.filename}`, provider: "openai" };
  },
  async submitBatch(input: LlmBatchSubmitInput): Promise<LlmBatchSubmitResult> {
    return {
      batchId: "batch_1",
      inputFileId: "in_1",
      status: input.requests.length > 0 ? "validating" : "completed",
    };
  },
};

describe("llm-provider-adapter-contract (S4.0 carve-out)", () => {
  it("a connector-importable adapter type resolves from the sdk-extensions leaf", async () => {
    expect(fixtureAdapter.provider).toBe("openai");
    expect(fixtureAdapter.defaultModel).toBe("test-model");

    const res = await fixtureAdapter.generate({
      system: "s",
      prompt: "hello",
    });
    expect(res.text).toBe("echo:hello");
    expect(res.status).toBe("completed");

    const ref = await fixtureAdapter.uploadFile?.({
      content: new Uint8Array([1, 2, 3]),
      filename: "t.txt",
      mimeType: "text/plain",
    });
    expect(ref?.provider).toBe("openai");
  });
});
