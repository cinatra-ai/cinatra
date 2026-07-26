<?php
/**
 * Plugin Name:       Fixture Labs Third-Party MCP
 * Plugin URI:        https://example.com/fixture-labs/third-party-mcp
 * Description:       Fixture-only stand-in for an ARBITRARY community plugin (NOT the cinatra companion, NOT an upstream plugin). It registers WP-core abilities under the fixturelabs/ namespace AND stands up its own dedicated MCP server, with annotated, unannotated, malformed, and contradictory tool variants. It exists solely to exercise the cinatra WordPress open-catalog MCP gateway (issue #2016) — do not ship it to a real site.
 * Version:           1.0.0
 * Requires at least: 6.9
 * Requires PHP:      8.0
 * Author:            Fixture Labs
 * Author URI:        https://example.com/fixture-labs
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       fixture-thirdparty-mcp
 *
 * @package FixtureLabsThirdPartyMcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Single option-backed note store shared by the fixturelabs/note-* abilities.
if ( ! defined( 'FIXTURELABS_NOTE_OPTION' ) ) {
	define( 'FIXTURELABS_NOTE_OPTION', 'fixturelabs_note' );
}

require_once __DIR__ . '/includes/abilities.php';
require_once __DIR__ . '/includes/mcp-server.php';

// Register the ability category before the abilities (mirrors mcp-adapter/eafm).
add_action( 'wp_abilities_api_categories_init', 'fixturelabs_register_category' );
// Register the fixturelabs/* abilities on the WP-core Abilities API.
add_action( 'wp_abilities_api_init', 'fixturelabs_register_abilities' );
// Register the dedicated MCP server on the adapter (fires only when mcp-adapter
// is active; guarded so a missing/renamed adapter API can never fatal the boot).
add_action( 'mcp_adapter_init', 'fixturelabs_register_server' );

/**
 * Register the fixturelabs ability category.
 *
 * @return void
 */
function fixturelabs_register_category() {
	if ( ! function_exists( 'wp_register_ability_category' ) ) {
		return;
	}
	try {
		wp_register_ability_category(
			'fixturelabs',
			array(
				'label'       => 'Fixture Labs',
				'description' => 'Fixture-only abilities from the Fixture Labs third-party stand-in plugin (#2016).',
			)
		);
	} catch ( \Throwable $e ) {
		// A fixture must never break the boot — log and continue.
		error_log( '[fixturelabs] category registration failed: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}
