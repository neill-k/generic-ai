import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import { type MarkdownBlock, parseInline, parseMarkdown } from "./markdown.js";

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const NUMBERED_LIST = "generic-ai-numbered";

function runs(text: string, bold = false): (TextRun | ExternalHyperlink)[] {
  return parseInline(text).map((span) => {
    switch (span.kind) {
      case "bold":
        return new TextRun({ text: span.text, bold: true });
      case "italic":
        return new TextRun({ text: span.text, italics: true, bold });
      case "code":
        return new TextRun({ text: span.text, font: "Courier New", bold });
      case "link":
        return new ExternalHyperlink({
          link: span.url,
          children: [new TextRun({ text: span.text, style: "Hyperlink", bold })],
        });
      default:
        return new TextRun({ text: span.text, bold });
    }
  });
}

function blockToDocx(block: MarkdownBlock, listInstance: () => number): (Paragraph | Table)[] {
  switch (block.kind) {
    case "heading":
      return [
        new Paragraph({
          heading: HEADINGS[block.level - 1] ?? HEADINGS[0],
          children: runs(block.text),
        }),
      ];
    case "paragraph":
      return [new Paragraph({ children: runs(block.text) })];
    case "list": {
      const instance = listInstance();
      return block.items.map(
        (item) =>
          new Paragraph({
            children: runs(item.text),
            ...(block.ordered
              ? { numbering: { reference: NUMBERED_LIST, level: item.level, instance } }
              : { bullet: { level: item.level } }),
          }),
      );
    }
    case "table": {
      const width = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
      const row = (cells: readonly string[], header: boolean) =>
        new TableRow({
          tableHeader: header,
          children: Array.from(
            { length: width },
            (_unused, index) =>
              new TableCell({
                children: [new Paragraph({ children: runs(cells[index] ?? "", header) })],
              }),
          ),
        });
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [row(block.header, true), ...block.rows.map((cells) => row(cells, false))],
        }),
      ];
    }
    case "code":
      return block.text
        .split("\n")
        .map(
          (line) => new Paragraph({ children: [new TextRun({ text: line, font: "Courier New" })] }),
        );
    case "rule":
      return [new Paragraph({ thematicBreak: true, children: [] })];
    default:
      return [];
  }
}

/** Render Markdown as a Word (.docx) document. */
export async function markdownToDocx(source: string, title?: string): Promise<Uint8Array> {
  let instances = 0;
  const children = parseMarkdown(source).flatMap((block) =>
    blockToDocx(block, () => {
      instances += 1;
      return instances;
    }),
  );
  const document = new Document({
    ...(title === undefined ? {} : { title }),
    creator: "Generic AI",
    numbering: {
      config: [
        {
          reference: NUMBERED_LIST,
          levels: Array.from({ length: 9 }, (_unused, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: children.length === 0 ? [new Paragraph({ children: [] })] : children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
