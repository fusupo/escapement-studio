import DOMPurify from "dompurify";
import { marked } from "marked";

// Parse Markdown, then sanitize the resulting HTML at the rendering boundary.
marked.setOptions({
  breaks: true, // GFM line breaks
  gfm: true,
});

/**
 * Render a markdown string to sanitized HTML for chat display.
 * Returns raw HTML string suitable for {@html ...} in Svelte.
 */
export function renderMarkdown(text) {
  if (!text) return "";
  return DOMPurify.sanitize(marked.parse(text, { async: false }), { USE_PROFILES: { html: true } });
}
