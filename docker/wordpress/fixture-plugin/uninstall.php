<?php
/**
 * Uninstall cleanup for the Fixture Labs third-party fixture plugin.
 *
 * Removes the single option-backed note store. Runs only via the WordPress
 * uninstall lifecycle (WP_UNINSTALL_PLUGIN defined).
 *
 * @package FixtureLabsThirdPartyMcp
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'fixturelabs_note' );
