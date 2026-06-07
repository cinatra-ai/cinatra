<?php

/**
 * Generic dev-content seeder for the local Cinatra dev WordPress.
 *
 * Run via `wp eval-file` from scripts/wordpress-entrypoint.sh after core is
 * installed and the cinatra + mcp-adapter plugins are active. Reads the
 * generic, fictional content manifest
 * (scripts/fixtures/external-instances.dev-content.json, bind-mounted into the
 * container) and seeds posts/pages idempotently so a fresh dev WordPress has
 * realistic content to operate on.
 *
 * Layered ON TOP of WordPress core's default "Hello world!" post + "Sample
 * Page" — those are left untouched.
 *
 * Idempotency mirrors the cinatra.devFixtures philosophy via two post-meta
 * keys: `_cinatra_dev_fixture_id` (stable fixture id) and
 * `_cinatra_dev_fixture_checksum` (content checksum at seed time). CREATE if
 * absent, REPLACE only while still fixture-owned and the manifest changed, SKIP
 * if the user edited/trashed the post.
 *
 * Dev-only. Safe to re-run.
 */

const CINATRA_WP_FIXTURE_ID_META = '_cinatra_dev_fixture_id';
const CINATRA_WP_FIXTURE_CHECKSUM_META = '_cinatra_dev_fixture_checksum';
const CINATRA_WP_FIXTURE_REV_META = '_cinatra_dev_fixture_rev';

function cinatra_wp_seed_log(string $msg): void {
  fwrite(STDERR, "[cinatra-wp:seed] {$msg}\n");
}

function cinatra_wp_seed_checksum(string $type, string $title, string $content, string $status): string {
  return hash('sha256', json_encode([
    'type' => $type,
    'title' => $title,
    'content' => $content,
    'status' => $status,
  ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

function cinatra_wp_seed_load_manifest(): array {
  $path = getenv('CINATRA_DEV_CONTENT_JSON') ?: '/opt/cinatra-dev-content/external-instances.dev-content.json';
  if (!is_file($path)) {
    cinatra_wp_seed_log("manifest not found at {$path} — skipping (mount scripts/fixtures into the container to enable)");
    return [];
  }
  $data = json_decode((string) file_get_contents($path), TRUE);
  if (!is_array($data)) {
    cinatra_wp_seed_log('manifest is not valid JSON — skipping');
    return [];
  }
  return $data;
}

/** Find the existing fixture-owned post for a fixture id, across any status. */
function cinatra_wp_seed_find(string $fixture_id) {
  $found = get_posts([
    'post_type' => ['post', 'page'],
    'post_status' => ['publish', 'draft', 'pending', 'private', 'future', 'trash'],
    'meta_key' => CINATRA_WP_FIXTURE_ID_META,
    'meta_value' => $fixture_id,
    'numberposts' => 1,
    'suppress_filters' => TRUE,
  ]);
  return $found ? $found[0] : NULL;
}

/** Persist the fixture provenance meta (id + persisted checksum + rev). */
function cinatra_wp_seed_mark(int $post_id, string $fixture_id, int $version): void {
  $post = get_post($post_id);
  $checksum = cinatra_wp_seed_checksum(
    $post->post_type,
    (string) $post->post_title,
    (string) $post->post_content,
    (string) $post->post_status,
  );
  update_post_meta($post_id, CINATRA_WP_FIXTURE_ID_META, $fixture_id);
  update_post_meta($post_id, CINATRA_WP_FIXTURE_CHECKSUM_META, $checksum);
  update_post_meta($post_id, CINATRA_WP_FIXTURE_REV_META, (string) $version);
}

/**
 * Seed (create/replace/skip) one fixture post. Provenance carries the PERSISTED
 * checksum (for user-edit detection) and a `rev` equal to the manifest version
 * (bumping the version re-applies content).
 */
function cinatra_wp_seed_post(array $post, int $version): string {
  $fixture_id = (string) ($post['fixtureId'] ?? '');
  if ($fixture_id === '') {
    return 'error';
  }
  $type = ($post['postType'] ?? 'post') === 'page' ? 'page' : 'post';
  $title = (string) ($post['title'] ?? '');
  $content = (string) ($post['content'] ?? '');
  $status = (string) ($post['status'] ?? 'publish');

  $existing = cinatra_wp_seed_find($fixture_id);

  if ($existing === NULL) {
    $new_id = wp_insert_post([
      'post_type' => $type,
      'post_title' => $title,
      'post_content' => $content,
      'post_status' => $status,
    ], TRUE);
    if (is_wp_error($new_id) || !$new_id) {
      return 'error';
    }
    cinatra_wp_seed_mark((int) $new_id, $fixture_id, $version);
    return 'created';
  }

  // User trashed the seeded post — respect that, never resurrect it.
  if ($existing->post_status === 'trash') {
    return 'skipped-deleted';
  }

  $stored_checksum = (string) get_post_meta($existing->ID, CINATRA_WP_FIXTURE_CHECKSUM_META, TRUE);
  $stored_rev = (int) get_post_meta($existing->ID, CINATRA_WP_FIXTURE_REV_META, TRUE);
  $live_checksum = cinatra_wp_seed_checksum(
    $existing->post_type,
    (string) $existing->post_title,
    (string) $existing->post_content,
    (string) $existing->post_status,
  );

  // User edited it since we last seeded → leave it alone.
  if ($live_checksum !== $stored_checksum) {
    return 'skipped-user-edited';
  }
  // Still fixture-owned but the manifest version has not advanced → nothing to do.
  if ($version <= $stored_rev) {
    return 'skipped-current';
  }
  // Manifest version advanced and still fixture-owned → REPLACE.
  $updated = wp_update_post([
    'ID' => $existing->ID,
    'post_title' => $title,
    'post_content' => $content,
    'post_status' => $status,
  ], TRUE);
  if (is_wp_error($updated)) {
    return 'error';
  }
  cinatra_wp_seed_mark((int) $existing->ID, $fixture_id, $version);
  return 'replaced';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

$manifest = cinatra_wp_seed_load_manifest();
$posts = $manifest['wordpress']['posts'] ?? [];
if (empty($posts)) {
  cinatra_wp_seed_log('no wordpress fixtures in manifest — nothing to do');
  return;
}

$version = (int) ($manifest['version'] ?? 1);
$counts = ['created' => 0, 'replaced' => 0, 'skipped' => 0, 'error' => 0];
foreach ($posts as $post) {
  $action = cinatra_wp_seed_post($post, $version);
  if ($action === 'created') {
    $counts['created']++;
  }
  elseif ($action === 'replaced') {
    $counts['replaced']++;
  }
  elseif ($action === 'error') {
    $counts['error']++;
  }
  else {
    $counts['skipped']++;
  }
}

cinatra_wp_seed_log(sprintf(
  'posts: created=%d replaced=%d skipped=%d error=%d',
  $counts['created'],
  $counts['replaced'],
  $counts['skipped'],
  $counts['error'],
));
