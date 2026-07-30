<?php
/**
 * Scale-smoke ability registrations (WP-core Abilities API).
 *
 * Registers SCALESMOKE_ABILITY_COUNT (>= 64) independent, read-only abilities
 * — `scalesmoke/note-get-001` .. `scalesmoke/note-get-0NN` — each returning a
 * static note keyed by its own index. Every ability shares the same schema
 * shape and annotation profile (`readonly:true, destructive:false`) by
 * design: the point of this fixture is tool-name SCALE (a real deployment
 * would never register 64 near-identical tools), not schema variety — schema
 * edge cases are already covered by the fixturelabs fixture (#2016).
 *
 * The MCP annotation carrier is `meta.annotations` with the WordPress-format
 * keys readonly/destructive (same convention as fixturelabs/includes/abilities.php);
 * `meta.mcp.public = true` makes each ability discoverable via the adapter's
 * default server discover-abilities + enable-abilities-for-mcp.
 *
 * @package ScaleSmokeFixture
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register a single ability, guarded so a bad arg can never fatal the boot.
 *
 * @param string $name Ability name (namespace/ability).
 * @param array  $args wp_register_ability() args.
 * @return void
 */
function scalesmoke_register_ability_safe( string $name, array $args ): void {
	if ( ! function_exists( 'wp_register_ability' ) ) {
		return;
	}
	try {
		wp_register_ability( $name, $args );
	} catch ( \Throwable $e ) {
		error_log( '[scale-smoke] register ' . $name . ' failed: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}

/**
 * Zero-pad an ability index to a stable 3-digit suffix (001..NNN).
 *
 * @param int $index 1-based ability index.
 * @return string
 */
function scalesmoke_index_suffix( int $index ): string {
	return str_pad( (string) $index, 3, '0', STR_PAD_LEFT );
}

/**
 * Register the scalesmoke/* read-only abilities (SCALESMOKE_ABILITY_COUNT of
 * them). Each ability's execute callback is a closure bound to its own index
 * — WordPress's Abilities API accepts any PHP callable, closures included.
 *
 * @return void
 */
function scalesmoke_register_abilities(): void {
	$public_tool = array(
		'public' => true,
		'type'   => 'tool',
	);

	for ( $index = 1; $index <= SCALESMOKE_ABILITY_COUNT; $index++ ) {
		$suffix = scalesmoke_index_suffix( $index );
		$name   = "scalesmoke/note-get-{$suffix}";

		scalesmoke_register_ability_safe(
			$name,
			array(
				'label'               => "Get Scale-Smoke Note {$suffix}",
				'description'         => "Return fixture note #{$suffix}, one of the scale-smoke read-only abilities used to prove trusted-read native injection at provider scale (cinatra#2019).",
				'category'            => 'scalesmoke',
				// No input_schema: the read takes no arguments. Deliberately
				// OMITTED (matching the fixturelabs note-get precedent) rather
				// than declared as an empty properties map — PHP JSON-encodes
				// an empty array() as [] (a list, not an object), which would
				// advertise a malformed schema fragment on the wire.
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'id'   => array( 'type' => 'integer' ),
						'note' => array( 'type' => 'string' ),
					),
					'required'   => array( 'id', 'note' ),
				),
				'execute_callback'    => function ( $input = array() ) use ( $index ) {
					unset( $input );
					return array(
						'id'   => $index,
						'note' => "Scale-smoke note #{$index}",
					);
				},
				'permission_callback' => 'scalesmoke_perm_read',
				'meta'                => array(
					'mcp'         => $public_tool,
					'annotations' => array(
						'readonly'    => true,
						'destructive' => false,
					),
				),
			)
		);
	}
}

/**
 * Permission: any authenticated user may read.
 *
 * @param array $input Unused.
 * @return bool
 */
function scalesmoke_perm_read( $input = array() ): bool {
	unset( $input );
	return is_user_logged_in();
}
