<?php
/**
 * Plugin Name:       Scale Smoke Fixture
 * Plugin URI:        https://example.com/scale-smoke-fixture
 * Description:       Fixture-only plugin that registers many read-only abilities on a dedicated first-class MCP server. It exists solely to prove the trusted-read native-injection pipeline behaves correctly at provider scale (cinatra#2019) — a separate concern from the fixturelabs annotation fixture (#2016) and deliberately kept out of that plugin's tree so this fixture's own churn never marks the S1 captures stale. Do not ship it to a real site.
 * Version:           1.0.0
 * Requires at least: 6.9
 * Requires PHP:      8.0
 * Author:            Scale Smoke Fixture
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:        scale-smoke-fixture
 *
 * @package ScaleSmokeFixture
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// How many read-only abilities to register + expose as first-class MCP tools.
// Kept as a single constant so the ability count, the tool count on the
// dedicated server, and any documentation/test expectation all derive from
// ONE number (cinatra#2019's "≥64 read abilities" requirement).
if ( ! defined( 'SCALESMOKE_ABILITY_COUNT' ) ) {
	define( 'SCALESMOKE_ABILITY_COUNT', 64 );
}

require_once __DIR__ . '/includes/abilities.php';
require_once __DIR__ . '/includes/mcp-server.php';

// Register the ability category before the abilities (mirrors mcp-adapter/eafm
// and the fixturelabs fixture plugin's own ordering).
add_action( 'wp_abilities_api_categories_init', 'scalesmoke_register_category' );
// Register the scalesmoke/* abilities on the WP-core Abilities API.
add_action( 'wp_abilities_api_init', 'scalesmoke_register_abilities' );
// Register the dedicated first-class MCP server on the adapter (fires only
// when mcp-adapter is active; guarded so a missing/renamed adapter API can
// never fatal the boot).
add_action( 'mcp_adapter_init', 'scalesmoke_register_server' );

/**
 * Register the scale-smoke ability category.
 *
 * @return void
 */
function scalesmoke_register_category() {
	if ( ! function_exists( 'wp_register_ability_category' ) ) {
		return;
	}
	try {
		wp_register_ability_category(
			'scalesmoke',
			array(
				'label'       => 'Scale Smoke',
				'description' => 'Fixture-only read abilities used to prove trusted-read native injection at provider scale (cinatra#2019).',
			)
		);
	} catch ( \Throwable $e ) {
		// A fixture must never break the boot — log and continue.
		error_log( '[scale-smoke] category registration failed: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}
