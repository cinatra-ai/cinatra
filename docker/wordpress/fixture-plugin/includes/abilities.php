<?php
/**
 * Fixture Labs ability registrations (WP-core Abilities API).
 *
 * A read/write/destructive TRIO backed by a single option store, plus three
 * annotation edge-case read variants (unannotated / malformed / contradictory)
 * for the annotation-transport proof (#2016 §2). The MCP annotation carrier is
 * `meta.annotations` with the WordPress-format keys readonly/destructive/
 * idempotent (resolved by the C0 bring-up api-map + confirmed against the
 * mcp-adapter 0.5.0 source: RegisterAbilityAsMcpTool reads
 * ability.meta.annotations and maps them via McpAnnotationMapper to the MCP
 * ToolAnnotations readOnlyHint/destructiveHint/idempotentHint). `meta.mcp.public
 * = true` makes each ability discoverable via the adapter's default server
 * discover-abilities + enable-abilities-for-mcp.
 *
 * @package FixtureLabsThirdPartyMcp
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
function fixturelabs_register_ability_safe( string $name, array $args ): void {
	if ( ! function_exists( 'wp_register_ability' ) ) {
		return;
	}
	try {
		wp_register_ability( $name, $args );
	} catch ( \Throwable $e ) {
		error_log( '[fixturelabs] register ' . $name . ' failed: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}

/**
 * Register the fixturelabs/* abilities (the read/write/destructive trio + the
 * three annotation edge-case read variants).
 *
 * @return void
 */
function fixturelabs_register_abilities(): void {
	$public_tool = array(
		'public' => true,
		'type'   => 'tool',
	);

	// READ — read-only, non-destructive.
	fixturelabs_register_ability_safe(
		'fixturelabs/note-get',
		array(
			'label'               => 'Get Note',
			'description'         => 'Return the note stored by the Fixture Labs fixture plugin.',
			'category'            => 'fixturelabs',
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array( 'note' => array( 'type' => 'string' ) ),
				'required'   => array( 'note' ),
			),
			'execute_callback'    => 'fixturelabs_exec_note_get',
			'permission_callback' => 'fixturelabs_perm_read',
			'meta'                => array(
				'mcp'         => $public_tool,
				'annotations' => array(
					'readonly'    => true,
					'destructive' => false,
				),
			),
		)
	);

	// WRITE — non-destructive, idempotent create/update.
	fixturelabs_register_ability_safe(
		'fixturelabs/note-set',
		array(
			'label'               => 'Set Note',
			'description'         => 'Create or update the Fixture Labs note.',
			'category'            => 'fixturelabs',
			'input_schema'        => array(
				'type'       => 'object',
				'properties' => array(
					'note' => array(
						'type'        => 'string',
						'description' => 'Note text to store.',
					),
				),
				'required'   => array( 'note' ),
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'ok'   => array( 'type' => 'boolean' ),
					'note' => array( 'type' => 'string' ),
				),
			),
			'execute_callback'    => 'fixturelabs_exec_note_set',
			'permission_callback' => 'fixturelabs_perm_write',
			'meta'                => array(
				'mcp'         => $public_tool,
				'annotations' => array(
					'readonly'    => false,
					'destructive' => false,
					'idempotent'  => true,
				),
			),
		)
	);

	// DESTRUCTIVE — delete.
	fixturelabs_register_ability_safe(
		'fixturelabs/note-delete',
		array(
			'label'               => 'Delete Note',
			'description'         => 'Delete the Fixture Labs note.',
			'category'            => 'fixturelabs',
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array( 'ok' => array( 'type' => 'boolean' ) ),
			),
			'execute_callback'    => 'fixturelabs_exec_note_delete',
			'permission_callback' => 'fixturelabs_perm_write',
			'meta'                => array(
				'mcp'         => $public_tool,
				'annotations' => array(
					'readonly'    => false,
					'destructive' => true,
				),
			),
		)
	);

	// EDGE CASE — ABSENT annotations (no meta.annotations at all).
	fixturelabs_register_ability_safe(
		'fixturelabs/note-get-unannotated',
		array(
			'label'               => 'Get Note (unannotated)',
			'description'         => 'Read variant with NO MCP annotations declared — proves absent-annotation behavior.',
			'category'            => 'fixturelabs',
			'execute_callback'    => 'fixturelabs_exec_note_get',
			'permission_callback' => 'fixturelabs_perm_read',
			'meta'                => array( 'mcp' => $public_tool ),
		)
	);

	// EDGE CASE — MALFORMED annotation VALUES. The mcp-adapter McpAnnotationMapper
	// coerces valid string-booleans (readonly:"true" -> true) and DROPS
	// uninterpretable values (destructive:"not-a-bool", idempotent:5) — the
	// capture (§3e) records exactly what is emitted, raw.
	fixturelabs_register_ability_safe(
		'fixturelabs/note-get-malformed',
		array(
			'label'               => 'Get Note (malformed annotations)',
			'description'         => 'Read variant whose annotation values are malformed types — proves malformed-annotation handling.',
			'category'            => 'fixturelabs',
			'execute_callback'    => 'fixturelabs_exec_note_get',
			'permission_callback' => 'fixturelabs_perm_read',
			'meta'                => array(
				'mcp'         => $public_tool,
				'annotations' => array(
					'readonly'    => 'true',
					'destructive' => 'not-a-bool',
					'idempotent'  => 5,
				),
			),
		)
	);

	// EDGE CASE — CONTRADICTORY annotations (read-only AND destructive both true).
	fixturelabs_register_ability_safe(
		'fixturelabs/note-get-contradictory',
		array(
			'label'               => 'Get Note (contradictory annotations)',
			'description'         => 'Read variant declaring readOnly AND destructive both true — proves contradictory-annotation behavior.',
			'category'            => 'fixturelabs',
			'execute_callback'    => 'fixturelabs_exec_note_get',
			'permission_callback' => 'fixturelabs_perm_read',
			'meta'                => array(
				'mcp'         => $public_tool,
				'annotations' => array(
					'readonly'    => true,
					'destructive' => true,
				),
			),
		)
	);
}

/**
 * Execute: return the stored note.
 *
 * @param array $input Unused.
 * @return array
 */
function fixturelabs_exec_note_get( $input = array() ): array {
	unset( $input );
	return array( 'note' => (string) get_option( FIXTURELABS_NOTE_OPTION, '' ) );
}

/**
 * Execute: create/update the note.
 *
 * @param array $input { note: string }.
 * @return array
 */
function fixturelabs_exec_note_set( $input = array() ): array {
	$note = ( is_array( $input ) && isset( $input['note'] ) ) ? (string) $input['note'] : '';
	update_option( FIXTURELABS_NOTE_OPTION, $note );
	return array(
		'ok'   => true,
		'note' => $note,
	);
}

/**
 * Execute: delete the note.
 *
 * @param array $input Unused.
 * @return array
 */
function fixturelabs_exec_note_delete( $input = array() ): array {
	unset( $input );
	delete_option( FIXTURELABS_NOTE_OPTION );
	return array( 'ok' => true );
}

/**
 * Permission: any authenticated user may read.
 *
 * @param array $input Unused.
 * @return bool
 */
function fixturelabs_perm_read( $input = array() ): bool {
	unset( $input );
	return is_user_logged_in();
}

/**
 * Permission: writing/deleting requires edit_posts.
 *
 * @param array $input Unused.
 * @return bool
 */
function fixturelabs_perm_write( $input = array() ): bool {
	unset( $input );
	return current_user_can( 'edit_posts' );
}
