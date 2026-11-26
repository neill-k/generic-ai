/**
 * A small Markdown block model shared by the HTML and Word writers, plus an HTML-to-Markdown
 * converter used by the HTML and Word readers. It covers what agents write in reports: headings,
 * paragraphs, bullet and numbered lists, tables, code blocks, rules, and bold, italic, code and
 * link spans. It is not a full CommonMark implementation.
 */

export type InlineSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "italic"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly url: string };

export type MarkdownBlock =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | {
      readonly kind: "table";
      readonly header: readonly string[];
      readonly rows: readonly string[][];
    }
  | { readonly kind: "code"; readonly language?: string; readonly text: string }
  | { readonly kind: "rule" };

export interface ListItem {
  readonly text: string;
  readonly level: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence[1] ?? "```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({
        kind: "code",
        ...(fence[2] ? { language: fence[2] } : {}),
        text: body.join("\n"),
      });
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2] ?? "",
      });
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    const item = bullet ?? numbered;
    if (item !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: ListItem[] = [];
      let current: RegExpExecArray | null = item;
      while (current !== null) {
        items.push({
          text: current[2] ?? "",
          level: Math.min(Math.floor((current[1] ?? "").replace(/\t/g, "  ").length / 2), 8),
        });
        const next = lines[index + 1] ?? "";
        const nextMatch = ordered ? NUMBERED.exec(next) : BULLET.exec(next);
        if (nextMatch === null) {
          break;
        }
        current = nextMatch;
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

const INLINE = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)(?<!\s)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): readonly InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) {
      spans.push({ kind: "text", text: text.slice(last, start) });
    }
    if (match[2] !== undefined) {
      spans.push({ kind: "bold", text: match[2] });
    } else if (match[4] !== undefined) {
      spans.push({ kind: "italic", text: match[4] });
    } else if (match[5] !== undefined) {
      spans.push({ kind: "code", text: match[5] });
    } else if (match[6] !== undefined && match[7] !== undefined) {
      spans.push({ kind: "link", text: match[6], url: match[7] });
    }
    last = start + match[0].length;
  }
  if (last < text.length) {
    spans.push({ kind: "text", text: text.slice(last) });
  }
  return spans;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeUrl(url: string): string {
  return /^(https?:|mailto:|#|\/|\.)/i.test(url) ? url : "#";
}

function inlineHtml(text: string): string {
  return parseInline(text)
    .map((span) => {
      switch (span.kind) {
        case "bold":
          return `<strong>${escapeHtml(span.text)}</strong>`;
        case "italic":
          return `<em>${escapeHtml(span.text)}</em>`;
        case "code":
          return `<code>${escapeHtml(span.text)}</code>`;
        case "link":
          return `<a href="${escapeHtml(safeUrl(span.url))}">${escapeHtml(span.text)}</a>`;
        default:
          return escapeHtml(span.text);
      }
    })
    .join("");
}

function listHtml(block: Extract<MarkdownBlock, { kind: "list" }>): string {
  const tag = block.ordered ? "ol" : "ul";
  let html = "";
  let depth = -1;
  for (const item of block.items) {
    while (depth < item.level) {
      html += `<${tag}>`;
      depth += 1;
    }
    while (depth > item.level) {
      html += `</${tag}>`;
      depth -= 1;
    }
    html += `<li>${inlineHtml(item.text)}</li>`;
  }
  while (depth >= 0) {
    html += `</${tag}>`;
    depth -= 1;
  }
  return html;
}

/** Render Markdown as a standalone HTML document. Raw HTML in the source is escaped, not passed through. */
export function markdownToHtml(source: string, title = "Document"): string {
  const body = parseMarkdown(source)
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`;
        case "paragraph":
          return `<p>${inlineHtml(block.text)}</p>`;
        case "list":
          return listHtml(block);
        case "table":
          return `<table><thead><tr>${block.header
            .map((cell) => `<th>${inlineHtml(cell)}</th>`)
            .join("")}</tr></thead><tbody>${block.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`;
        case "code":
          return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case "rule":
          return "<hr>";
        default:
          return "";
      }
    })
    .join("\n");
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title></head>\n<body>\n${body}\n</body></html>\n`;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Convert HTML to readable Markdown: headings, paragraphs, lists, tables, emphasis and links are
 * kept; scripts, styles and other markup are dropped.
 */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, "");
  // Keep each table cell on one line: Word exports wrap cell text in paragraphs.
  text = text.replace(
    /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, tag: string, inner: string) =>
      `<${tag}>${inner.replace(/<\/?(p|div|br)\b[^>]*>/gi, " ").trim()}</${tag}>`,
  );
  // Number the items of ordered lists that hold no nested lists.
  text = text.replace(/<ol\b[^>]*>((?:(?!<[ou]l\b)[\s\S])*?)<\/ol>/gi, (_m, inner: string) => {
    let number = 0;
    return `${inner.replace(/<li\b[^>]*>/gi, () => {
      number += 1;
      return `\n${number}. `;
    })}\n\n`;
  });
  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      return `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]*>/g, "").trim()}\n\n`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]*>/g, "").trim();
        return href.startsWith("#") || label.length === 0 ? label : `[${label}](${href})`;
      },
    )
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<tr\b[^>]*>/gi, "\n|")
    .replace(/<\/t[hd]>/gi, " |")
    .replace(/<t[hd]\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|ul|ol|table|thead|tbody|blockquote|pre|header|footer)>/gi,
      "\n\n",
    )
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  // Insert a divider after the first row of each table so it renders as a Markdown table.
  text = text.replace(
    /(^|\n\n)(\|[^\n]*\|)\n(\|)/g,
    (_m, lead: string, first: string, next: string) => {
      const cells = first.split("|").length - 2;
      return `${lead}${first}\n|${" --- |".repeat(Math.max(cells, 1))}\n${next}`;
    },
  );
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
