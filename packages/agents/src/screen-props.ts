// THE PLUGIN-REGISTRY PROP BOUNDARY (cinatra#2809, per-scope surfaces S3).
//
// The registry hands a route's props to an instance screen, and the ONE thing
// it has to do on the way is await the search params: a route passes them as a
// promise, a screen reads them resolved.
//
// It does that by SPREAD, and its prop type is the screen's own type, because
// the first proof round measured what a hand-copied list costs. The boundary
// used to name three props and rebuild the object from them, so the two the
// scoped launch routes added — the scope base and the vantage itself — were
// dropped in transit: the launcher minted no anchor, the fresh run's home was
// the bare global route, and no scoped page could name the scope it was under.
// Nothing typechecked the loss, because the route casts the screen to its own
// signature at the mount.
//
// Deriving the type from `ScreenProps` makes a dropped prop a type error rather
// than a silent hole, and the spread means a prop added to a screen tomorrow
// arrives without an edit here.
import type { ScreenProps } from "./instance-screens";

/** What a route hands the registry: the screen's props, search params unresolved. */
export type AgentScreenProps = Omit<ScreenProps, "searchParams"> & {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** The screen's props, with the search params awaited and everything else
 *  passed through untouched. */
export async function resolveAgentScreenProps(
  props: AgentScreenProps,
): Promise<ScreenProps> {
  const { searchParams, ...rest } = props;
  if (!searchParams) return { ...rest };
  return { ...rest, searchParams: await searchParams };
}
