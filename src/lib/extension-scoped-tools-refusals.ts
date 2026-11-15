// THE EXTENSION-SCOPED ROAD'S FIXED SENTENCES (cinatra#4154).
//
// A module of constants only. The passthrough route answers an unproven
// `extension_tool` call with the sentence below before it loads any package
// module and before any dispatch.

/**
 * The 403 body of an `extension_tool` call whose calling step is not proven:
 * the runtime's signed step pair is absent, malformed, signed under another key
 * or context, or expired. Which package's tool a call reaches is decided from
 * that step, so an unproven call reaches no tool.
 */
export const EXTENSION_TOOL_STEP_UNPROVEN =
  "extension_tool: the calling step is not proven, so no tool is reached";
