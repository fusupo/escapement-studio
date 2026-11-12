// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
// @ts-expect-error Browser helper is JavaScript.
import { renderMarkdown } from "../../web/src/lib/markdown.js";

describe("safe Markdown", () => {
  it.each(['<img src=x onerror="alert(1)">', '<script>alert(1)</script>', '<svg onload="alert(1)"></svg>', '<a href="javascript:alert(1)">click</a>', '[click](javascript:alert%281%29)', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'])("removes executable markup: %s", (input) => {
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown(input);
    expect(host.querySelector("script, iframe, svg, [onerror], [onload], [srcdoc]")).toBeNull();
    expect(host.querySelector('[href^="javascript:"]')).toBeNull();
  });
  it("preserves headings, code, tables, emphasis and safe links", () => {
    const html = renderMarkdown('# Plan\n\n**safe** [docs](https://example.com)\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    for (const tag of ['<h1>', '<strong>', '<pre>', '<table>', 'href="https://example.com"']) expect(html).toContain(tag);
    expect(renderMarkdown('')).toBe('');
  });
});
