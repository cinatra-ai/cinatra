## Raw HTML must be escaped, never executed

A raw script tag: <script>alert('xss')</script>

An event-handler image: <img src="x" onerror="alert(1)">

A raw iframe: <iframe src="https://evil.example.com"></iframe>

An inline event handler on a span: <span onmouseover="alert(1)">hover me</span>

A raw anchor with a javascript href:
<a href="javascript:alert(1)">click</a>

Mixed with **valid** markdown _formatting_ around the raw `<b>bold</b>` tag.
