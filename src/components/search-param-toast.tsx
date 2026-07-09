"use client";

// One-shot URL flash-message island — the implementation moved to
// `@cinatra-ai/sdk-ui/search-param-toast` so extension packages can mount the
// same codes-only flash island with no `@/` host edge. This host path stays
// the stable in-app import: `import { SearchParamToast } from "@/components/search-param-toast";`.
export { SearchParamToast } from "@cinatra-ai/sdk-ui/search-param-toast";
export type { SearchParamToastConfig } from "@cinatra-ai/sdk-ui/search-param-toast";
