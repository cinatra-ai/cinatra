<?php
/**
 * Scale-smoke dedicated MCP server registration (mcp-adapter 0.5.0 API).
 *
 * Registers a SEPARATE, first-class MCP server (`scalesmoke-server`) at its
 * own REST route /wp-json/scalesmoke/scalesmoke-server, exposing every
 * scalesmoke/* ability as its own wire tool. Being first-class (built via
 * McpAdapter::create_server() with an explicit tools[] list, same as
 * fixturelabs-server) is what makes these abilities individually injectable —
 * the pinned DEFAULT adapter server stays triad-only regardless of how many
 * abilities exist (docker/wordpress/EXPOSURE-MODE.md).
 *
 * Confirmed against the pinned mcp-adapter 0.5.0 source (same contract the
 * fixturelabs fixture already relies on):
 *   McpAdapter::create_server( server_id, route_namespace, route, name,
 *     description, version, mcp_transports[], error_handler, observability,
 *     tools[], resources[], prompts[], transport_permission_callback ) — must be
 *     called during the mcp_adapter_init action; tools[] are ability NAMES.
 * Every call path is guarded (method_exists / class_exists / try-catch) so a
 * missing or changed adapter API degrades to a logged no-op, never a boot fatal.
 *
 * @package ScaleSmokeFixture
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register the dedicated scalesmoke-server on the mcp-adapter.
 *
 * @param object $adapter The McpAdapter instance passed by the mcp_adapter_init action.
 * @return void
 */
function scalesmoke_register_server( $adapter ): void {
	// Only proceed with a real adapter that exposes create_server().
	if ( ! is_object( $adapter ) || ! method_exists( $adapter, 'create_server' ) ) {
		return;
	}

	// HttpTransport is the adapter's REST/Streamable-HTTP transport. Reference it
	// as a string + class_exists guard so a renamed/missing class never fatals.
	$transport = 'WP\\MCP\\Transport\\HttpTransport';
	if ( ! class_exists( $transport ) ) {
		error_log( '[scale-smoke] mcp-adapter HttpTransport not available; skipping dedicated server.' ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		return;
	}

	$tools = array();
	for ( $index = 1; $index <= SCALESMOKE_ABILITY_COUNT; $index++ ) {
		$tools[] = 'scalesmoke/note-get-' . scalesmoke_index_suffix( $index );
	}

	try {
		$result = $adapter->create_server(
			'scalesmoke-server',                          // server_id
			'scalesmoke',                                 // route namespace -> /wp-json/scalesmoke/
			'scalesmoke-server',                           // route -> /wp-json/scalesmoke/scalesmoke-server
			'Scale Smoke MCP Server',                      // name
			'Dedicated first-class MCP server exposing many read-only abilities, used to prove trusted-read native injection at provider scale (cinatra#2019).', // description
			'1.0.0',                                       // version (bare — no vX.Y.Z milestone literal)
			array( $transport ),                           // mcp_transports
			null,                                          // error_handler -> NullMcpErrorHandler
			null,                                          // observability_handler -> Null
			$tools                                         // tools (ability names)
		);

		if ( function_exists( 'is_wp_error' ) && is_wp_error( $result ) ) {
			error_log( '[scale-smoke] create_server returned WP_Error: ' . $result->get_error_message() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}
	} catch ( \Throwable $e ) {
		error_log( '[scale-smoke] create_server threw: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}
