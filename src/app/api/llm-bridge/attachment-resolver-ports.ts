// Shared factory is consumed by both chat and bridge.
// Re-export for back-compat in case any caller imports from this path.
export { buildAttachmentResolverPorts as buildBridgeAttachmentResolverPorts } from "@/lib/artifacts/attachment-resolver-ports";
