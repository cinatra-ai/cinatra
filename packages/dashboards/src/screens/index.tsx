export { AgentsDashboardPage } from "./agents-dashboard";
export { PersonalDashboardPage } from "./personal-dashboard";
export { ProjectsDashboardPage } from "./projects-dashboard";
export { TeamsDashboardPage } from "./teams-dashboard";
export { TeamDetailDashboardPage } from "./team-detail-dashboard";
export { OrganizationsDashboardPage } from "./organizations-dashboard";
export { OrganizationDetailDashboardPage } from "./organization-detail-dashboard";
export { OrganizationSettingsPage } from "./organization-settings";
// The full-page artifacts DC dashboard (ArtifactsDashboardPage) was retired:
// `/artifacts` is now the bespoke consolidated surface (cinatra#1431). The
// artifacts analytics CUBE + its cinatraLinkedTable name→/artifacts/[id]
// mapping remain (they read the effective-identity fields per epic #1424).
