// ---------------------------------------------------------------------------
// The pure access-scope label helpers, moved into the package that owns the
// access picker (cinatra#3385), so a connector pack can draw the picker
// without reaching into the app. This path stays the stable in-app import:
// every existing caller is unchanged.
// ---------------------------------------------------------------------------
export * from "@cinatra-ai/sdk-ui/access/scope";
