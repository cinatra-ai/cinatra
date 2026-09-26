// ---------------------------------------------------------------------------
// The unified access picker, moved into the package that owns it
// (cinatra#3385), so the connector Sharing tab draws the SAME picker whether
// the app's generated page or a connector pack's own page draws it. There is
// one implementation, never two copies.
//
// This path stays the stable in-app import, so every existing caller is
// unchanged: the approvals decision form, the skills toolbar, the
// install-scope dialogs, the artifact library toolbar, the assistants
// directory, and the rest.
// ---------------------------------------------------------------------------
export * from "@cinatra-ai/sdk-ui/access-combobox";
