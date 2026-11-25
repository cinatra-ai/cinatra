// THE READ-ONLY COMPOSITIONS LOAD THEIR PORTLETS AT ONCE (cinatra#3092), as a
// pure leaf beside the composition (which no node unit tier renders).
//
// drizzle-cube defers each portlet until an IntersectionObserver reports it
// visible, unless the configuration says `eagerLoad: true` — the library's own
// documented option ("Force immediate loading for all portlets"). A read-only
// display draws a handful of portlets and has nothing to gain from deferring
// them. And the deferred road is the one road found that can leave a portlet in
// its loading state with no request made: the query debounce
// (`useDebounceQuery`) records the query while the portlet is not yet visible,
// starts its timer when the portlet becomes visible, and an effect rerun that
// clears that timer before it fires finds the query unchanged and returns
// without starting it again. With `eagerLoad` the portlet is never "not yet
// visible", so that state cannot arise.

/**
 * The configuration with drizzle-cube's `eagerLoad` set. Every other key is
 * kept as given; an absent configuration stays absent (the library's own
 * empty-dashboard reading is unchanged).
 */
export function withEagerLoad<T extends object>(
  config: T | null | undefined,
): (T & { eagerLoad: true }) | null | undefined {
  if (config === null || config === undefined) return config;
  return { ...config, eagerLoad: true };
}
