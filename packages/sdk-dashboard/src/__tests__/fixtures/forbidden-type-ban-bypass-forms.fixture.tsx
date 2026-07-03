// Intentionally exercises the BYPASS forms the type bans must still catch
// (cinatra#803): Tailwind's `color:` type hint, variant chains after
// `dark:`, and template-literal class strings (TemplateElement matching).
export const colorTypeHint = "bg-[color:#ff0000]";
export const colorTypeHintFunction = "border-[color:rgb(255,0,0)]";
export const colorTypeHintVar = "ring-[color:var(--brand)]";
export const darkVariantChain = "dark:hover:focus:text-red-500";
export const darkDataVariant = "dark:data-[state=open]:bg-red-500";
export const templateLiteralClasses = `flex items-center text-[13px] ${"gap-2"}`;
// Per-side/axis border colors — the base color ban must reach border-{x,y,t,
// r,b,l,s,e}-[…], not only bare `border-[…]`.
export const borderSideArbitraryColor = "border-l-[#ff0000]";
export const borderAxisArbitraryColor = "border-x-[rgb(0,0,0)]";
// dark: named-color overrides on caret/from/via/to (previously absent from the
// dark utility set) must fire.
export const darkNamedFrom = "dark:from-red-500";
export const darkNamedTo = "dark:to-slate-900";
export const darkNamedVia = "dark:via-blue-500";
export const darkNamedCaret = "dark:caret-red-500";
// dark: with a slash group/peer variant chain must fire (the `/` in the
// variant segment is not a bypass).
export const darkSlashGroupVariant = "dark:group-hover/item:text-red-500";
export const darkSlashPeerVariant = "dark:peer-checked/opt:bg-blue-500";
// Negative arbitrary tracking — the leading `-` must not defeat the boundary.
export const negativeTracking = "-tracking-[0.02em]";
