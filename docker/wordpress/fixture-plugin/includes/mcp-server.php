<?php
/**
 * Fixture Labs dedicated MCP server registration (mcp-adapter 0.5.0 API).
 *
 * Registers a SEPARATE MCP server (`fixturelabs-server`) at its own REST route
 * /wp-json/fixturelabs/fixturelabs-server, exposing the six fixturelabs/*
 * abilities as tools. This is the "registers a dedicated MCP server (with
 * annotated and unannotated tool variants)" half of the fixture (#2016 §2.3) —
 * the second, independent MCP server the cinatra gateway must auto-enroll with
 * zero host changes (D8).
 *
 * Confirmed against the pinned mcp-adapter 0.5.0 source:
 *   McpAdapter::create_server( server_id, route_namespace, route, name,
 *     description, version, mcp_transports[], error_handler, observability,
 *     tools[], resources[], prompts[], transport_permission_callback ) — must be
 *     called during the mcp_adapter_init action; tools[] are ability NAMES.
 * Every call path is guarded (method_exists / class_exists / try-catch) so a
 * missing or changed adapter API degrades to a logged no-op, never a boot fatal.
 *
 * @package FixtureLabsThirdPartyMcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register the dedicated fixturelabs-server on the mcp-adapter.
 *
 * @param object $adapter The McpAdapter instance passed by the mcp_adapter_init action.
 * @return void
 */
function fixturelabs_register_server( $adapter ): void {
	// Only proceed with a real adapter that exposes create_server().
	if ( ! is_object( $adapter ) || ! method_exists( $adapter, 'create_server' ) ) {
		return;
	}

	// HttpTransport is the adapter's REST/Streamable-HTTP transport. Reference it
	// as a string + class_exists guard so a renamed/missing class never fatals.
	$transport = 'WP\\MCP\\Transport\\HttpTransport';
	if ( ! class_exists( $transport ) ) {
		error_log( '[fixturelabs] mcp-adapter HttpTransport not available; skipping dedicated server.' ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		return;
	}

	$tools = array(
		'fixturelabs/note-get',
		'fixturelabs/note-set',
		'fixturelabs/note-delete',
		'fixturelabs/note-get-unannotated',
		'fixturelabs/note-get-malformed',
		'fixturelabs/note-get-contradictory',
	);

	try {
		$result = $adapter->create_server(
			'fixturelabs-server',                       // server_id
			'fixturelabs',                              // route namespace -> /wp-json/fixturelabs/
			'fixturelabs-server',                       // route -> /wp-json/fixturelabs/fixturelabs-server
			'Fixture Labs MCP Server',                  // name
			'Dedicated MCP server for the Fixture Labs third-party fixture plugin (#2016).', // description
			'1.0.0',                                    // version (bare — no vX.Y.Z milestone literal)
			array( $transport ),                        // mcp_transports
			null,                                       // error_handler -> NullMcpErrorHandler
			null,                                       // observability_handler -> Null
			$tools                                      // tools (ability names)
		);

		if ( function_exists( 'is_wp_error' ) && is_wp_error( $result ) ) {
			error_log( '[fixturelabs] create_server returned WP_Error: ' . $result->get_error_message() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}
	} catch ( \Throwable $e ) {
		error_log( '[fixturelabs] create_server threw: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}
