// The host mirror of the public field-renderer props contract (cinatra#1625,
// epic #1620 S8 — M3). @cinatra-ai/agents RE-EXPORTS the props types + the ABI
// version from @cinatra-ai/sdk-ui (the single source of truth), so the ~34
// in-core importers keep resolving from @cinatra-ai/agents unchanged. This pins:
//   1. the version is a SINGLE authority (agents value === sdk-ui value === 1);
//   2. the re-exported types are type-identical to the sdk-ui leaf.

import { describe, it, expect, expectTypeOf } from "vitest";
import { FIELD_RENDERER_PROPS_API_VERSION as VERSION_FROM_SDK } from "@cinatra-ai/sdk-ui/field-renderer-props";
import type {
  FieldRendererProps as SdkProps,
  FieldRendererContext as SdkContext,
  RendererMode as SdkMode,
  GmailSendAsAliasOption as SdkAlias,
} from "@cinatra-ai/sdk-ui/field-renderer-props";
// The host mirror surface (field-renderer-components re-exports the version;
// field-renderer-registry re-exports the types).
import { FIELD_RENDERER_PROPS_API_VERSION as VERSION_FROM_AGENTS } from "../field-renderer-components";
import type {
  FieldRendererProps as AgentsProps,
  FieldRendererContext as AgentsContext,
  RendererMode as AgentsMode,
  GmailSendAsAliasOption as AgentsAlias,
} from "../field-renderer-registry";

describe("field-renderer props — host mirror of @cinatra-ai/sdk-ui", () => {
  it("has a single version authority: agents re-export === sdk-ui leaf === 1", () => {
    expect(VERSION_FROM_AGENTS).toBe(1);
    expect(VERSION_FROM_AGENTS).toBe(VERSION_FROM_SDK);
  });

  it("re-exports type-identical props/context/mode/alias from the SDK leaf", () => {
    expectTypeOf<AgentsProps>().toEqualTypeOf<SdkProps>();
    expectTypeOf<AgentsContext>().toEqualTypeOf<SdkContext>();
    expectTypeOf<AgentsMode>().toEqualTypeOf<SdkMode>();
    expectTypeOf<AgentsAlias>().toEqualTypeOf<SdkAlias>();
  });
});
