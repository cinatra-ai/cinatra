// CSS type declarations for TS 6.0+ strict side-effect import checking.
// Declares CSS files as side-effect-only modules (no default/named exports).
// Intentionally does NOT export a default to prevent accidental `import styles from "*.css"` usage.
declare module "*.css" {
  const _: never;
  export default _;
}
