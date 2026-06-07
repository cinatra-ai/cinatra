<?php

/**
 * @file
 * Generic dev-content seeder for the local Cinatra dev Drupal.
 *
 * Run via `drush php:script` from scripts/drupal-entrypoint.sh once the site is
 * installed and the article/page content types exist (standard install
 * profile). Reads the generic, fictional content manifest
 * (scripts/fixtures/external-instances.dev-content.json, bind-mounted into the
 * container) and seeds it idempotently so a fresh dev Drupal is never empty.
 *
 * Idempotency mirrors the cinatra.devFixtures philosophy: CREATE if absent,
 * REPLACE only while still fixture-owned (live checksum == stored checksum) and
 * the manifest content changed, SKIP if the user edited or deleted the node.
 * Provenance lives in Drupal state under `cinatra_dev_fixtures.nodes`.
 *
 * Also performs a ONE-SHOT migration that deletes legacy OpenCloud demo nodes
 * (some local dev volumes still carry them from earlier manual UAT testing),
 * guarded by a state sentinel so it runs at most once per volume.
 *
 * Dev-only. Safe to re-run.
 */

// Classes are fully-qualified inline (no top-level `use`) so this stays robust
// when included by `drush php:script` across Drush versions.

const STATE_NS = 'cinatra_dev_fixtures';

function cinatra_seed_log(string $msg): void {
  // Mirror the entrypoint's log prefix so output is grep-able in compose logs.
  fwrite(STDERR, "[cinatra-drupal:seed] {$msg}\n");
}

/** Stable checksum of the fixture-owned fields of a node. */
function cinatra_seed_node_checksum(string $type, string $title, string $body, string $summary, bool $status): string {
  // Order-stable, content-only. We checksum the PERSISTED node (after save) so
  // any Drupal-side normalization is baked in and a later user edit is the only
  // thing that makes the live checksum diverge.
  return hash('sha256', json_encode([
    'type' => $type,
    'title' => $title,
    'body' => $body,
    'summary' => $summary,
    'status' => $status,
  ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

/** Checksum of a loaded/saved node entity (its currently-persisted values). */
function cinatra_seed_entity_checksum($entity): string {
  return cinatra_seed_node_checksum(
    $entity->bundle(),
    (string) $entity->label(),
    (string) ($entity->get('body')->value ?? ''),
    (string) ($entity->get('body')->summary ?? ''),
    (bool) $entity->isPublished(),
  );
}

/** Read the bind-mounted manifest; returns [] (and logs) if unavailable. */
function cinatra_seed_load_manifest(): array {
  $path = getenv('CINATRA_DEV_CONTENT_JSON') ?: '/opt/cinatra-dev-content/external-instances.dev-content.json';
  if (!is_file($path)) {
    cinatra_seed_log("manifest not found at {$path} — skipping (mount scripts/fixtures into the container to enable)");
    return [];
  }
  $raw = file_get_contents($path);
  $data = json_decode($raw, TRUE);
  if (!is_array($data)) {
    cinatra_seed_log('manifest is not valid JSON — skipping');
    return [];
  }
  return $data;
}

/**
 * One-shot deletion of legacy OpenCloud demo nodes. Guarded by a state
 * sentinel; runs at most once per volume.
 */
function cinatra_seed_opencloud_cleanup(array $cleanup): void {
  if (empty($cleanup) || empty($cleanup['sentinel'])) {
    return;
  }
  $state = \Drupal::state();
  $sentinel_key = STATE_NS . '.' . $cleanup['sentinel'];
  if ($state->get($sentinel_key) === TRUE) {
    return;
  }
  $prefixes = is_array($cleanup['titlePrefixes'] ?? NULL) ? $cleanup['titlePrefixes'] : [];
  $storage = \Drupal::entityTypeManager()->getStorage('node');
  $deleted = 0;
  foreach ($prefixes as $prefix) {
    if (!is_string($prefix) || $prefix === '') {
      continue;
    }
    // STARTS_WITH is case-insensitive on the default (MySQL) collation.
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('title', $prefix, 'STARTS_WITH')
      ->execute();
    if ($ids) {
      $nodes = $storage->loadMultiple($ids);
      $storage->delete($nodes);
      $deleted += count($nodes);
    }
  }
  $state->set($sentinel_key, TRUE);
  cinatra_seed_log("opencloud cleanup ({$cleanup['sentinel']}): removed {$deleted} legacy node(s)");
}

/** Apply manifest fields onto a (new or loaded) node entity. */
function cinatra_seed_apply(\Drupal\node\NodeInterface $entity, array $node): void {
  $entity->set('title', (string) ($node['title'] ?? ''));
  $entity->set('status', (bool) ($node['status'] ?? TRUE));
  $entity->set('body', [
    'value' => (string) ($node['body'] ?? ''),
    'summary' => (string) ($node['summary'] ?? ''),
    'format' => 'basic_html',
  ]);
}

/**
 * Seed (create/replace/skip) one fixture node. Returns the action taken.
 *
 * Provenance carries the PERSISTED checksum (for user-edit detection) and a
 * `rev` equal to the manifest version (bumping the version re-applies content).
 */
function cinatra_seed_node(array $node, int $version, array &$provenance): string {
  $fixture_id = (string) ($node['fixtureId'] ?? '');
  if ($fixture_id === '') {
    return 'error';
  }
  $type = (string) ($node['type'] ?? 'article');
  $storage = \Drupal::entityTypeManager()->getStorage('node');
  $entry = $provenance[$fixture_id] ?? NULL;

  // No provenance yet → CREATE.
  if ($entry === NULL) {
    $entity = \Drupal\node\Entity\Node::create(['type' => $type]);
    cinatra_seed_apply($entity, $node);
    $entity->save();
    $provenance[$fixture_id] = [
      'nid' => (int) $entity->id(),
      'checksum' => cinatra_seed_entity_checksum($entity),
      'rev' => $version,
    ];
    return 'created';
  }

  /** @var \Drupal\node\NodeInterface|null $entity */
  $entity = $storage->load($entry['nid'] ?? 0);
  if ($entity === NULL) {
    // User deleted the seeded node — respect that, never recreate.
    return 'skipped-deleted';
  }

  // User edited the node since we last seeded it → leave it alone.
  if (cinatra_seed_entity_checksum($entity) !== ($entry['checksum'] ?? NULL)) {
    return 'skipped-user-edited';
  }
  // Still fixture-owned but the manifest version has not advanced → nothing to do.
  if ($version <= (int) ($entry['rev'] ?? 0)) {
    return 'skipped-current';
  }
  // Manifest version advanced and still fixture-owned → REPLACE.
  cinatra_seed_apply($entity, $node);
  $entity->save();
  $provenance[$fixture_id] = [
    'nid' => (int) $entity->id(),
    'checksum' => cinatra_seed_entity_checksum($entity),
    'rev' => $version,
  ];
  return 'replaced';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

$manifest = cinatra_seed_load_manifest();
$drupal = $manifest['drupal'] ?? [];
if (empty($drupal)) {
  cinatra_seed_log('no drupal fixtures in manifest — nothing to do');
  return;
}

cinatra_seed_opencloud_cleanup($drupal['legacyCleanup'] ?? []);

$version = (int) ($manifest['version'] ?? 1);
$state = \Drupal::state();
$provenance = $state->get(STATE_NS . '.nodes', []);
if (!is_array($provenance)) {
  $provenance = [];
}

$counts = ['created' => 0, 'replaced' => 0, 'skipped' => 0, 'error' => 0];
foreach (($drupal['nodes'] ?? []) as $node) {
  $action = cinatra_seed_node($node, $version, $provenance);
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

$state->set(STATE_NS . '.nodes', $provenance);
cinatra_seed_log(sprintf(
  'nodes: created=%d replaced=%d skipped=%d error=%d',
  $counts['created'],
  $counts['replaced'],
  $counts['skipped'],
  $counts['error'],
));
