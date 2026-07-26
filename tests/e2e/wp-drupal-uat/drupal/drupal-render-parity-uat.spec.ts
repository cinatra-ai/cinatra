// CMS-iframe render-parity (target 3) — Drupal. Thin registration of the shared
// leg (../render-parity.ts); frames the SAME /embed/assistant inside the live
// Drupal admin widget iframe and DOM-compares the 11-fixture corpus (both themes)
// against the S3 packaged-renderer reference. cinatra#1998 (c), #1216 S6.
import { registerCmsRenderParitySpec } from "../render-parity";

registerCmsRenderParitySpec("drupal");
