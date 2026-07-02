// Intentionally exercises the BYPASS forms the type bans must still catch
// (cinatra#803): Tailwind's `color:` type hint, variant chains after
// `dark:`, and template-literal class strings (TemplateElement matching).
export const colorTypeHint = "bg-[color:#ff0000]";
export const colorTypeHintFunction = "border-[color:rgb(255,0,0)]";
export const colorTypeHintVar = "ring-[color:var(--brand)]";
export const darkVariantChain = "dark:hover:focus:text-red-500";
export const darkDataVariant = "dark:data-[state=open]:bg-red-500";
export const templateLiteralClasses = `flex items-center text-[13px] ${"gap-2"}`;
