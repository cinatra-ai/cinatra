// Positive control for the arbitrary color/type bans (cinatra#803): named
// tokens, standard utilities, `text-[length:inherit]`, and non-color dark:
// variants must all pass in every enforced zone.
export const namedTypeTokens = "text-page-title-lg tracking-kicker";
export const badgeTokens = "text-badge-xs tracking-page-label";
export const semanticColors = "text-foreground bg-surface text-muted-foreground";
export const inheritedSize = "text-[length:inherit] md:text-[length:inherit]";
export const nonColorDarkVariant = "dark:opacity-50";
// Non-color dark: utilities on the color-utility PREFIXES must NOT fire — the
// dark ban only gates a dark: prefix followed by an actual color value, so
// alignment/size/width/style keywords under dark: are legitimate.
export const nonColorDarkText = "dark:text-center dark:text-lg";
export const nonColorDarkBorder = "dark:border-2 dark:border-dashed dark:border-b-2";
export const nonColorDarkMisc =
  "dark:ring-0 dark:outline-none dark:divide-x dark:decoration-2 dark:stroke-2";
// Approved semantic design tokens under dark: (the #801 tokenization path) —
// they adapt through the cascade and are NOT palette colors, so they stay
// allowed.
export const semanticDarkTokens =
  "dark:bg-surface dark:text-foreground dark:border-line dark:text-muted-foreground";
export const standardScale = "text-sm tracking-tight";
