/** Center a measured passage only when it is outside the editor viewport. */
export function passageScrollTop({
  top,
  bottom,
  scrollTop,
  viewportHeight,
}: {
  top: number;
  bottom: number;
  scrollTop: number;
  viewportHeight: number;
}): number {
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return scrollTop;
  const height = Math.min(bottom - top, viewportHeight);
  return Math.max(0, top - (viewportHeight - height) / 2);
}

// A source line can wrap many times. Measure the actual selection using the
// editor's typography and content width, including its scrollbar and padding.
// Text nodes keep note content inert; the temporary mirror never receives focus.
export function revealNoteSelection(element: HTMLTextAreaElement): void {
  if (element.clientWidth === 0 || element.clientHeight === 0) return;
  const document = element.ownerDocument;
  const style = document.defaultView?.getComputedStyle(element);
  if (style === undefined) return;
  const mirror = document.createElement("div");
  const text = document.createTextNode(element.value);
  mirror.append(text);
  mirror.setAttribute("aria-hidden", "true");
  for (const property of [
    "font-family", "font-size", "font-weight", "font-style", "font-variant",
    "font-stretch", "font-feature-settings", "font-kerning", "line-height",
    "letter-spacing", "word-spacing", "tab-size", "direction", "hyphens",
    "text-align", "text-indent", "text-transform", "word-break", "overflow-wrap",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
  ]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed",
    left: "0",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    border: "0",
    width: `${element.clientWidth}px`,
    whiteSpace: element.wrap === "off" ? "pre" : "pre-wrap",
  });
  document.body.append(mirror);
  try {
    const range = document.createRange();
    range.setStart(text, element.selectionStart);
    range.setEnd(text, element.selectionEnd);
    const rectangles = Array.from(range.getClientRects());
    const first = rectangles[0];
    const last = rectangles.at(-1);
    if (first === undefined || last === undefined) return;
    const mirrorTop = mirror.getBoundingClientRect().top;
    element.scrollTop = passageScrollTop({
      top: first.top - mirrorTop,
      bottom: last.bottom - mirrorTop,
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
    });
  } finally {
    mirror.remove();
  }
}
