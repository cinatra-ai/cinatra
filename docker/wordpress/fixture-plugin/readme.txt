=== Fixture Labs Third-Party MCP ===
Contributors: fixturelabs
Tags: mcp, abilities, fixture, testing
Requires at least: 6.9
Tested up to: 6.9
Requires PHP: 8.0
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A fixture-only stand-in for an arbitrary community plugin. NOT for production use.

== Description ==

This plugin exists solely to exercise the cinatra WordPress open-catalog MCP
gateway (cinatra-ai/cinatra issue #2016). It plays the role of an ARBITRARY
third-party community plugin — it is neither the cinatra companion plugin nor an
upstream WordPress.org plugin.

It does two independent things a real community plugin might do:

1. Registers WordPress-core abilities under the `fixturelabs/` namespace: a
   read/write/destructive trio (`fixturelabs/note-get`, `fixturelabs/note-set`,
   `fixturelabs/note-delete`) backed by a single option store, plus three
   annotation edge-case read variants (unannotated, malformed, contradictory).

2. Stands up its OWN dedicated MCP server (`fixturelabs-server`) via the
   mcp-adapter API, at /wp-json/fixturelabs/fixturelabs-server, exposing those
   abilities as MCP tools with annotated and unannotated tool variants.

The gateway acceptance suites use it to prove core-ability annotation transport
and zero-host-change auto-enrollment of a second, independent MCP server.

== Changelog ==

= 1.0.0 =
* Initial fixture: fixturelabs/note-* ability trio + edge-case variants and the
  dedicated fixturelabs-server MCP server.
