"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  assignScopeSkillAction,
  removeScopeSkillAction,
  searchScopeAssignableSkillsAction,
} from "@/lib/scope-assignment/scope-assignment-actions";

export type ScopeAssignmentSkillActions = {
  assignScopeSkillAction: typeof assignScopeSkillAction;
  removeScopeSkillAction: typeof removeScopeSkillAction;
  searchScopeAssignableSkillsAction: typeof searchScopeAssignableSkillsAction;
};

// The production default is the existing server boundary, unchanged. A
// provider lets the conformance harness substitute data without replacing the
// page, typeahead, selected rows or their state transitions. Like the install
// panel's action provider, this boundary draws no DOM.
const ScopeAssignmentSkillActionsContext = createContext<ScopeAssignmentSkillActions>({
  assignScopeSkillAction,
  removeScopeSkillAction,
  searchScopeAssignableSkillsAction,
});

export function ScopeAssignmentSkillActionsProvider({
  actions,
  children,
}: {
  actions: ScopeAssignmentSkillActions;
  children: ReactNode;
}) {
  return (
    <ScopeAssignmentSkillActionsContext.Provider value={actions}>
      {children}
    </ScopeAssignmentSkillActionsContext.Provider>
  );
}

export function useScopeAssignmentSkillActions(): ScopeAssignmentSkillActions {
  return useContext(ScopeAssignmentSkillActionsContext);
}
