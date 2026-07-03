// Intentionally violates the arbitrary color/type className bans
// (TYPE_BANS in eslint.config.mjs, cinatra#803). Linted by
// eslint-boundary.test.ts via temp copies into the enforced zones — this
// source location (__tests__/fixtures) is globally ignored by default lint.
export const arbitraryHexColor = "bg-[#ff0000] p-2";
export const arbitraryColorFunction = "border-[rgb(255,0,0)]";
export const manualDarkOverride = "dark:text-red-500";
export const manualDarkVariantChain = "dark:focus-visible:ring-red-500";
export const arbitraryTextSize = "text-[13px] font-medium";
export const arbitraryTracking = "tracking-[0.2em] uppercase";
