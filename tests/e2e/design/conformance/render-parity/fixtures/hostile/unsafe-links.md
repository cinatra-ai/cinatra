## Unsafe links and schemes (all must be neutralized)

A [javascript link](javascript:alert(1)) must drop its href.

A [data-uri link](data:text/html,<script>alert(1)</script>) must drop its href.

A [vbscript link](vbscript:msgbox(1)) must drop its href.

A [tab-obfuscated scheme](java&#9;script:alert(1)) must not execute.

A [protocol-relative link](//evil.example.com/path) must not become a
cross-origin navigation.

A [backslash-obfuscated link](/\evil.example.com) must not become
protocol-relative.

An unsafe image must be dropped: ![unsafe image](javascript:alert(2))

A safe root-relative link stays: [dashboard](/content/123).
