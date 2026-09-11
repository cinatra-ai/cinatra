/**
 * The Dashboards tab's OWN empty reading (the ratified drawing, The Dashboards
 * tab section, "the tab across its load states").
 *
 * The drawing gives this state its own words rather than the shared Empty
 * pattern: a centred dashed panel reading "No dashboards in this scope yet" at
 * 12.5px/600 over one helper line at 11px/1.5. The helper names the recourse a
 * MANAGER has - "A manager can Add an existing dashboard, or create one that
 * homes here."
 *
 * That recourse does not exist everywhere. The same section rules that "a
 * personal user scope and the whole-workspace scope are not add-to-scope
 * targets - they carry no Add, so add-to-scope is the three shared scopes
 * only". A helper sentence whose whole subject is an Add that the scope does
 * not offer is the unavailable management action in prose, so the section's own
 * rule decides it: "Suppression, not a disabled control: a management action
 * the member cannot take is not rendered." On a scope with no Add the headline
 * therefore stands ALONE inside the dashed container; the substituted sentence
 * that stood there through fix legs 2-4 was never in the drawing and is gone
 * (cinatra#2807 fix leg 5).
 *
 * The helper is keyed on the SCOPE KIND, not on this viewer's own authority:
 * where the scope does offer an Add the sentence is third-person prose about
 * what a manager can do, which is true and worth reading for a read-only member
 * too. The viewer's authority governs the Add CONTROL, which the tab suppresses
 * separately.
 *
 * Extracted to its own module (cinatra#2807, fix leg 2) so the whole-workspace
 * Dashboards tab and the three shared scopes' Dashboards tab render ONE
 * element from ONE place, and the drawn wording lives in exactly one file.
 */
import {
  scopeOffersAddToScope,
  type ScopeDashboardsTabScopeKind,
} from "./scope-dashboards-contract";

export function ScopeDashboardsEmptyState({
  scopeKind,
  ...rest
}: {
  scopeKind: ScopeDashboardsTabScopeKind;
} & React.ComponentProps<"div">) {
  return (
    <div
      data-state="empty"
      className="rounded-lg border border-dashed border-line px-3 py-[18px] text-center"
      {...rest}
    >
      <p className="text-scope-empty-title font-semibold text-foreground">
        No dashboards in this scope yet
      </p>
      {scopeOffersAddToScope(scopeKind) ? (
        <p className="mx-auto mt-1.5 max-w-sm text-scope-empty-help text-muted-foreground">
          A manager can <b className="font-semibold text-foreground">Add</b> an
          existing dashboard, or create one that homes here.
        </p>
      ) : null}
    </div>
  );
}
