/** Keep keyboard focus within an open modal and restore its trigger on close.
 * @param {HTMLElement} node
 */
export function modalFocus(node) {
  const previous = document.activeElement;
  const focusable = () => [...node.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')]
    .filter((element) => element instanceof HTMLElement && !element.hasAttribute('disabled') && element.getAttribute('tabindex') !== '-1');
  queueMicrotask(() => { if (node.isConnected) (/** @type {HTMLElement} */ (focusable()[0]) ?? node).focus(); });
  const handleKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab') return;
    const elements = focusable();
    const first = /** @type {HTMLElement} */ (elements[0]);
    const last = /** @type {HTMLElement} */ (elements.at(-1));
    if (!first) { event.preventDefault(); node.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  node.addEventListener('keydown', handleKey);
  return { destroy() {
    node.removeEventListener('keydown', handleKey);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  } };
}
