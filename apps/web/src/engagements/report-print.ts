/**
 * Self-contained print HTML export (STONE-7).
 * Renders outline markdown as escaped, dependency-free HTML with inline
 * styles only: no external fonts, scripts, images, or links, so the file
 * prints identically offline. Fenced code and headings get minimal
 * structure; everything else becomes paragraphs.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdownBody(markdown: string): string {
  const html: string[] = [];
  const lines = markdown.split("\n");
  let inCode = false;
  let code: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${escapeHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushCode = (): void => {
    if (code.length === 0) return;
    html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    if (line.startsWith("### ")) {
      flushParagraph();
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      flushParagraph();
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      flushParagraph();
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      flushParagraph();
      html.push(`<p class="item">${escapeHtml(line)}</p>`);
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushCode();
  return html.join("\n");
}

export function buildPrintHtml(title: string, markdown: string): string {
  const body = renderMarkdownBody(markdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: Georgia, "Times New Roman", serif; color: #000; background: #fff; max-width: 70ch; margin: 2em auto; padding: 0 1em; }
h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; }
pre { border: 1px solid #000; padding: 0.75em; white-space: pre-wrap; word-break: break-word; }
code { font-family: "Courier New", monospace; }
.item { margin-left: 1.5em; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
