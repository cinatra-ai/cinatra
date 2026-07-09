## Fenced code with language highlighting

Inline `const x = 1` code, then a fenced block:

```ts
export function add(a: number, b: number): number {
  const sum = a + b;
  return sum;
}
```

A shell block:

```bash
echo "hello world"
ls -la /tmp
```

A block with no language:

```
plain preformatted text
  with indentation preserved
```
