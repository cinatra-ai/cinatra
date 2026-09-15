/**
 * Vendor byline resolution for the Installed extensions page (cinatra#948
 * reopen, gap 3) — RE-EXPORTED from its home in `@cinatra-ai/registries`
 * (cinatra#3047).
 *
 * §VI renders "{Type} by {Vendor}" with the HUMAN vendor name in ink, and this
 * module path is what the marketplace card, the modal byline and the assigned-
 * skills display already import. The function itself moved one package down so
 * a third surface — the run page's Skills step, drawn by `@cinatra-ai/agents`,
 * which `@cinatra-ai/extensions` DEPENDS on — can print the same byline without
 * closing a dependency cycle. Nothing about the resolution changed: the module
 * that owns it states the chain, and this file is the path that keeps every
 * existing caller and its tests reading exactly as before.
 */
export { resolveInstalledVendorName } from "@cinatra-ai/registries";
