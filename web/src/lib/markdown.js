import { marked } from "marked";

// Configure marked for safe, compact rendering in chat bubbles
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
  return marked.parse(text);
}
