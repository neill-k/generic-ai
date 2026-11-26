import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createToolErrorEnvelope,
  GenericAIToolError,
  type ToolErrorKind,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import {
  createWorkspaceFs,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";
import { type Static, type TSchema, Type } from "@sinclair/typebox";

import { markdownToDocx } from "./docx-writer.js";
import { htmlToMarkdown, markdownToHtml } from "./markdown.js";
import { type CellValue, readXlsx, type Sheet, SpreadsheetError, writeXlsx } from "./xlsx.js";

export { htmlToMarkdown, markdownToHtml, parseInline, parseMarkdown } from "./markdown.js";
export type { InlineSpan, ListItem, MarkdownBlock } from "./markdown.js";
export { markdownToDocx } from "./docx-writer.js";
export { type CellValue, readXlsx, type Sheet, SpreadsheetError, writeXlsx } from "./xlsx.js";

export const name = "@generic-ai/plugin-tools-documents" as const;
export const kind = "tools-documents" as const;

export const READABLE_DOCUMENT_FORMATS = [
  "pdf",
  "docx",
  "xlsx",
  "csv",
  "tsv",
  "html",
  "markdown",
  "text",
  "json",
] as const;
export type ReadableDocumentFormat = (typeof READABLE_DOCUMENT_FORMATS)[number];

export const WRITABLE_DOCUMENT_FORMATS = [
  "markdown",
  "text",
  "html",
  "docx",
  "xlsx",
  "csv",
  "tsv",
  "json",
] as const;
export type WritableDocumentFormat = (typeof WRITABLE_DOCUMENT_FORMATS)[number];

const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 200_000;
const SAVED_PREVIEW_CHARS = 2_000;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const EXTENSION_FORMATS: Readonly<Record<string, ReadableDocumentFormat>> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".csv": "csv",
  ".tsv": "tsv",
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".text": "text",
  ".log": "text",
  ".yaml": "text",
  ".yml": "text",
  ".xml": "text",
  ".json": "json",
};

const LEGACY_FORMATS: Readonly<Record<string, string>> = {
  ".doc": "Word 97-2003 (.doc)",
  ".xls": "Excel 97-2003 (.xls)",
  ".ppt": "PowerPoint 97-2003 (.ppt)",
  ".pptx": "PowerPoint (.pptx)",
  ".rtf": "Rich Text (.rtf)",
  ".odt": "OpenDocument text (.odt)",
};

export class DocumentToolError extends GenericAIToolError {
  constructor(
    kind: ToolErrorKind,
    message: string,
    options: { readonly cause?: unknown; readonly hint?: string; readonly path?: string } = {},
  ) {
    super(
      createToolErrorEnvelope({
        kind,
        safeMessage: message,
        retryable: false,
        ...(options.cause === undefined ? {} : { rawCause: options.cause }),
        ...(options.hint === undefined
          ? {}
          : { remediationHints: [{ kind: "adjust_input", message: options.hint }] }),
        ...(options.path === undefined ? {} : { metadata: { path: options.path } }),
      }),
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = "DocumentToolError";
  }
}

export interface DocumentReadRequest {
  readonly path: string;
  /** PDF only: pages to read, such as `"1-3,7"`. Defaults to every page. */
  readonly pages?: string;
  /** Spreadsheet only: the sheet to read. Defaults to every sheet. */
  readonly sheet?: string;
  /** Maximum characters returned. The rest is cut, unless `saveTo` is set. */
  readonly maxChars?: number;
  /**
   * Write the full extracted text to this workspace path (Markdown) and return only a short
   * preview, so long documents stay out of the model's context.
   */
  readonly saveTo?: string;
}

export interface DocumentReadResult {
  readonly path: string;
  readonly format: ReadableDocumentFormat;
  readonly text: string;
  readonly totalChars: number;
  readonly truncated: boolean;
  readonly pageCount?: number;
  readonly pagesRead?: readonly number[];
  readonly sheets?: readonly string[];
  readonly savedTo?: string;
}

export interface DocumentWriteSheet {
  readonly name?: string;
  readonly rows: readonly (readonly CellValue[])[];
}

export interface DocumentWriteRequest {
  readonly path: string;
  /** Inferred from the extension when left out. */
  readonly format?: WritableDocumentFormat;
  /** Markdown for markdown, text, html and docx; raw text for csv, tsv and json. */
  readonly content?: string;
  /** Rows for xlsx (one entry per sheet), csv and tsv (first sheet only). */
  readonly sheets?: readonly DocumentWriteSheet[];
  /** Any JSON value, for json. */
  readonly data?: unknown;
  /** Document title for html and docx. Defaults to the file name. */
  readonly title?: string;
  /** Replace an existing file. Defaults to false. */
  readonly overwrite?: boolean;
}

export interface DocumentWriteResult {
  readonly path: string;
  readonly format: WritableDocumentFormat;
  readonly bytes: number;
}

const CELL_SCHEMA = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

const DOCUMENT_READ_PARAMETERS = Type.Object({
  path: Type.String({
    minLength: 1,
    description:
      "Workspace path of a PDF, Word (.docx), Excel (.xlsx), CSV, HTML, Markdown, text or JSON file.",
  }),
  pages: Type.Optional(
    Type.String({ description: 'PDF only: pages to read, for example "1-3,7". Default: all.' }),
  ),
  sheet: Type.Optional(
    Type.String({ description: "Spreadsheet only: sheet name to read. Default: all sheets." }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      minimum: 256,
      maximum: MAX_MAX_CHARS,
      description: `Maximum characters returned (default ${DEFAULT_MAX_CHARS}).`,
    }),
  ),
});

const DOCUMENT_EXTRACT_PARAMETERS = Type.Object({
  path: DOCUMENT_READ_PARAMETERS.properties.path,
  saveTo: Type.String({
    minLength: 1,
    description:
      "Workspace path for the extracted Markdown, for example notes/report.md. Replaced if it exists.",
  }),
  pages: DOCUMENT_READ_PARAMETERS.properties.pages,
  sheet: DOCUMENT_READ_PARAMETERS.properties.sheet,
});

const DOCUMENT_WRITE_PARAMETERS = Type.Object({
  path: Type.String({
    minLength: 1,
    description:
      "Workspace path to write: .md, .txt, .html, .docx, .xlsx, .csv, .tsv or .json. Parent folders are created.",
  }),
  format: Type.Optional(
    Type.Union(
      WRITABLE_DOCUMENT_FORMATS.map((format) => Type.Literal(format)),
      { description: "Output format. Default: inferred from the path's extension." },
    ),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Markdown for .md, .txt, .html and .docx (headings, lists, tables, bold, italic, links). Raw text for .csv, .tsv and .json.",
    }),
  ),
  sheets: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.Optional(Type.String()),
        rows: Type.Array(Type.Array(CELL_SCHEMA)),
      }),
      { description: "Rows for .xlsx (one entry per sheet), .csv and .tsv (first sheet)." },
    ),
  ),
  data: Type.Optional(Type.Unknown({ description: "Any JSON value, for .json." })),
  title: Type.Optional(Type.String({ description: "Document title for .html and .docx." })),
  overwrite: Type.Optional(
    Type.Boolean({ description: "Replace the file if it exists. Default: false." }),
  ),
});

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface DocumentToolResult<TDetails> {
  readonly content: readonly TextContent[];
  readonly details: TDetails;
}

export interface DocumentTool<TParams extends TSchema, TDetails> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ): Promise<DocumentToolResult<TDetails>>;
}

export type DocumentReadTool = DocumentTool<typeof DOCUMENT_READ_PARAMETERS, DocumentReadResult>;
export type DocumentExtractTool = DocumentTool<
  typeof DOCUMENT_EXTRACT_PARAMETERS,
  DocumentReadResult
>;
export type DocumentWriteTool = DocumentTool<typeof DOCUMENT_WRITE_PARAMETERS, DocumentWriteResult>;

export interface DocumentToolsOptions {
  readonly root: WorkspaceRootInput;
  /** Largest file `document_read` opens. Defaults to 50 MB. */
  readonly maxFileBytes?: number;
  /** Default `maxChars` for `document_read`. Defaults to 20,000. */
  readonly defaultMaxChars?: number;
}

export interface DocumentToolsPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  /** `document_read` (fs.read), `document_extract` (fs.read, fs.write), `document_write` (fs.write). */
  readonly piTools: readonly [DocumentReadTool, DocumentExtractTool, DocumentWriteTool];
  read(request: DocumentReadRequest): Promise<DocumentReadResult>;
  write(request: DocumentWriteRequest): Promise<DocumentWriteResult>;
}

export function detectDocumentFormat(filePath: string): ReadableDocumentFormat {
  const extension = path.extname(filePath).toLowerCase();
  const format = EXTENSION_FORMATS[extension];
  if (format !== undefined) {
    return format;
  }
  const legacy = LEGACY_FORMATS[extension];
  throw new DocumentToolError(
    "invalid_input",
    legacy === undefined
      ? `Cannot read "${filePath}": unsupported file type "${extension || "(none)"}".`
      : `Cannot read "${filePath}": ${legacy} is not supported.`,
    {
      path: filePath,
      hint: "Supported: .pdf, .docx, .xlsx, .csv, .tsv, .html, .md, .txt, .json, .yaml, .xml. Convert other formats first, for example to PDF or .docx.",
    },
  );
}

function writableFormatFor(filePath: string): WritableDocumentFormat {
  const extension = path.extname(filePath).toLowerCase();
  const format = EXTENSION_FORMATS[extension];
  if (format === "pdf") {
    throw new DocumentToolError(
      "invalid_input",
      `Cannot write "${filePath}": PDF output is not supported; write .docx or .html instead.`,
      { path: filePath, hint: "Write .docx or .html; the owner can print either to PDF." },
    );
  }
  if (format === undefined) {
    throw new DocumentToolError(
      "invalid_input",
      `Cannot write "${filePath}": choose .md, .txt, .html, .docx, .xlsx, .csv, .tsv or .json.`,
      { path: filePath, hint: "Use a supported extension or pass format." },
    );
  }
  return format;
}

/** Parse a page selection such as "1-3,7" into sorted, unique, 1-based page numbers. */
export function parsePageSelection(selection: string, pageCount: number): readonly number[] {
  const pages = new Set<number>();
  for (const part of selection.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const range = /^(\d+)\s*-\s*(\d+)?$/.exec(trimmed);
    const single = /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
    const start = range === null ? single : Number(range[1]);
    const end = range === null ? single : range[2] === undefined ? pageCount : Number(range[2]);
    if (start === undefined || end === undefined || start < 1 || end < start) {
      throw new DocumentToolError("invalid_input", `Invalid page selection "${selection}".`, {
        hint: 'Use page numbers and ranges such as "1-3,7" (pages start at 1).',
      });
    }
    for (let page = start; page <= Math.min(end, pageCount); page += 1) {
      pages.add(page);
    }
  }
  if (pages.size === 0) {
    throw new DocumentToolError(
      "invalid_input",
      `Page selection "${selection}" matches no pages; the document has ${pageCount}.`,
    );
  }
  return [...pages].sort((left, right) => left - right);
}

function escapeTableCell(value: CellValue): string {
  if (value === null) {
    return "";
  }
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Render a sheet as a Markdown table, using the first non-empty row as the header. */
export function sheetToMarkdown(sheet: Sheet): string {
  const rows = sheet.rows.filter((row) => row.some((cell) => cell !== null && cell !== ""));
  if (rows.length === 0) {
    return `## ${sheet.name}\n\n(empty sheet)`;
  }
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: readonly CellValue[]) =>
    `| ${Array.from({ length: width }, (_unused, index) => escapeTableCell(row[index] ?? null)).join(" | ")} |`;
  const [header, ...body] = rows;
  return [
    `## ${sheet.name}`,
    "",
    line(header ?? []),
    `|${" --- |".repeat(width)}`,
    ...body.map(line),
  ].join("\n");
}

function delimitedCell(value: CellValue, delimiter: string): string {
  if (value === null) {
    return "";
  }
  const text = String(value);
  if (delimiter === "\t") {
    return text.replace(/[\t\r\n]+/g, " ");
  }
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToDelimited(
  rows: readonly (readonly CellValue[])[],
  delimiter: "," | "\t",
): string {
  return `${rows.map((row) => row.map((cell) => delimitedCell(cell, delimiter)).join(delimiter)).join("\n")}\n`;
}

async function extractPdf(
  data: Uint8Array,
  pages: string | undefined,
): Promise<{ text: string; pageCount: number; pagesRead: readonly number[] }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let document: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    document = await getDocumentProxy(data);
  } catch (error) {
    throw new DocumentToolError("invalid_input", "File is not a readable PDF.", { cause: error });
  }
  try {
    const { totalPages, text } = await extractText(document, { mergePages: false });
    const pagesRead =
      pages === undefined
        ? Array.from({ length: totalPages }, (_unused, index) => index + 1)
        : parsePageSelection(pages, totalPages);
    const body = pagesRead
      .map(
        (page) => `## Page ${page}\n\n${(text[page - 1] ?? "").trim() || "(no text on this page)"}`,
      )
      .join("\n\n");
    return { text: body, pageCount: totalPages, pagesRead };
  } finally {
    await (document as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
    return htmlToMarkdown(result.value);
  } catch (error) {
    throw new DocumentToolError("invalid_input", "File is not a readable Word (.docx) document.", {
      cause: error,
    });
  }
}

function extractXlsx(
  data: Uint8Array,
  sheetName: string | undefined,
): { text: string; sheets: readonly string[] } {
  let sheets: readonly Sheet[];
  try {
    sheets = readXlsx(data);
  } catch (error) {
    throw new DocumentToolError(
      "invalid_input",
      error instanceof SpreadsheetError
        ? error.message
        : "File is not a readable .xlsx spreadsheet.",
      { cause: error },
    );
  }
  const names = sheets.map((sheet) => sheet.name);
  const selected =
    sheetName === undefined ? sheets : sheets.filter((sheet) => sheet.name === sheetName);
  if (selected.length === 0) {
    throw new DocumentToolError("not_found", `No sheet named "${sheetName}".`, {
      hint: `Sheets in this workbook: ${names.join(", ")}.`,
    });
  }
  return { text: selected.map(sheetToMarkdown).join("\n\n"), sheets: names };
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length <= maxChars
    ? { text, truncated: false }
    : { text: text.slice(0, maxChars), truncated: true };
}

function toolText(result: DocumentReadResult): string {
  const facts = [
    result.format,
    result.pageCount === undefined ? undefined : `${result.pageCount} pages`,
    result.pagesRead === undefined || result.pagesRead.length === result.pageCount
      ? undefined
      : `read pages ${result.pagesRead.join(", ")}`,
    result.sheets === undefined ? undefined : `sheets: ${result.sheets.join(", ")}`,
    `${result.totalChars} characters`,
  ].filter((fact) => fact !== undefined);
  const header = `${result.path} (${facts.join("; ")})`;
  if (result.savedTo !== undefined) {
    return `${header}\nFull text saved to ${result.savedTo}. Preview:\n\n${result.text}${
      result.truncated ? "\n\n[preview ends; read the saved file for the rest]" : ""
    }`;
  }
  return `${header}\n\n${result.text}${
    result.truncated
      ? `\n\n[truncated: ${result.totalChars - result.text.length} more characters. Use document_extract to save the full text to a file, or narrow with pages or sheet.]`
      : ""
  }`;
}

export function createDocumentTools(options: DocumentToolsOptions): DocumentToolsPlugin {
  const workspace = createWorkspaceFs(options.root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const defaultMaxChars = options.defaultMaxChars ?? DEFAULT_MAX_CHARS;

  function relative(absolutePath: string): string {
    return path.relative(workspace.root, absolutePath).split(path.sep).join("/");
  }

  async function writableTarget(filePath: string, overwrite: boolean): Promise<string> {
    const absolute = await resolveSafeWorkspacePath(workspace.root, filePath);
    const existing = await stat(absolute).catch(() => undefined);
    if (existing?.isDirectory() === true) {
      throw new DocumentToolError("invalid_input", `"${filePath}" is a folder.`, {
        path: filePath,
      });
    }
    if (existing !== undefined && !overwrite) {
      throw new DocumentToolError("invalid_input", `"${filePath}" already exists.`, {
        path: filePath,
        hint: "Pass overwrite: true to replace it, or choose another path.",
      });
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    // Resolve again now that the parent exists, so a symlinked parent cannot escape the workspace.
    return resolveSafeWorkspacePath(workspace.root, filePath);
  }

  async function read(request: DocumentReadRequest): Promise<DocumentReadResult> {
    const format = detectDocumentFormat(request.path);
    let absolute: string;
    try {
      absolute = await resolveSafeWorkspacePath(workspace.root, request.path);
    } catch (error) {
      throw new DocumentToolError("policy_blocked", `"${request.path}" is outside the workspace.`, {
        cause: error,
        path: request.path,
      });
    }
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      throw new DocumentToolError("not_found", `No file at "${request.path}".`, {
        path: request.path,
      });
    }
    if (info.size > maxFileBytes) {
      throw new DocumentToolError(
        "invalid_input",
        `"${request.path}" is ${Math.ceil(info.size / 1024 / 1024)} MB, over the ${Math.floor(
          maxFileBytes / 1024 / 1024,
        )} MB limit.`,
        { path: request.path },
      );
    }
    if (request.pages !== undefined && format !== "pdf") {
      throw new DocumentToolError("invalid_input", "pages applies to PDF files only.");
    }
    if (request.sheet !== undefined && format !== "xlsx") {
      throw new DocumentToolError("invalid_input", "sheet applies to .xlsx files only.");
    }
    const data = new Uint8Array(await readFile(absolute));
    let full: string;
    let extra: Partial<Pick<DocumentReadResult, "pageCount" | "pagesRead" | "sheets">> = {};
    switch (format) {
      case "pdf": {
        const pdf = await extractPdf(data, request.pages);
        full = pdf.text;
        extra = { pageCount: pdf.pageCount, pagesRead: pdf.pagesRead };
        break;
      }
      case "docx":
        full = await extractDocx(data);
        break;
      case "xlsx": {
        const xlsx = extractXlsx(data, request.sheet);
        full = xlsx.text;
        extra = { sheets: xlsx.sheets };
        break;
      }
      case "html":
        full = htmlToMarkdown(Buffer.from(data).toString("utf8"));
        break;
      default:
        full = Buffer.from(data).toString("utf8");
        break;
    }

    let savedTo: string | undefined;
    if (request.saveTo !== undefined) {
      const target = await writableTarget(request.saveTo, true);
      await writeFile(target, full, "utf8");
      savedTo = relative(target);
    }
    const limit = Math.min(
      savedTo === undefined ? (request.maxChars ?? defaultMaxChars) : SAVED_PREVIEW_CHARS,
      MAX_MAX_CHARS,
    );
    const clipped = clip(full, limit);
    return Object.freeze({
      path: relative(absolute),
      format,
      text: clipped.text,
      totalChars: full.length,
      truncated: clipped.truncated,
      ...extra,
      ...(savedTo === undefined ? {} : { savedTo }),
    });
  }

  async function write(request: DocumentWriteRequest): Promise<DocumentWriteResult> {
    const format = request.format ?? writableFormatFor(request.path);
    const title = request.title ?? path.basename(request.path, path.extname(request.path));
    const needContent = (): string => {
      if (request.content === undefined) {
        throw new DocumentToolError("invalid_input", `Writing ${format} needs content.`, {
          path: request.path,
        });
      }
      return request.content;
    };
    const needRows = (): readonly (readonly CellValue[])[] | undefined => request.sheets?.[0]?.rows;

    let bytes: Uint8Array | string;
    switch (format) {
      case "markdown":
      case "text":
        bytes = needContent();
        break;
      case "html":
        bytes = markdownToHtml(needContent(), title);
        break;
      case "docx":
        bytes = await markdownToDocx(needContent(), title);
        break;
      case "xlsx":
        if (request.sheets === undefined || request.sheets.length === 0) {
          throw new DocumentToolError("invalid_input", "Writing xlsx needs sheets with rows.", {
            path: request.path,
          });
        }
        bytes = writeXlsx(
          request.sheets.map((sheet, index) => ({
            name: sheet.name ?? `Sheet${index + 1}`,
            rows: sheet.rows,
          })),
        );
        break;
      case "csv":
      case "tsv": {
        const rows = needRows();
        bytes =
          rows === undefined ? needContent() : rowsToDelimited(rows, format === "csv" ? "," : "\t");
        break;
      }
      case "json":
        if (request.data !== undefined) {
          bytes = `${JSON.stringify(request.data, null, 2)}\n`;
        } else {
          const content = needContent();
          try {
            JSON.parse(content);
          } catch (error) {
            throw new DocumentToolError("invalid_input", "content is not valid JSON.", {
              cause: error,
              path: request.path,
            });
          }
          bytes = content;
        }
        break;
      default:
        throw new DocumentToolError(
          "invalid_input",
          `Unsupported output format "${String(format)}".`,
        );
    }

    const target = await writableTarget(request.path, request.overwrite === true);
    await writeFile(target, bytes);
    return Object.freeze({
      path: relative(target),
      format,
      bytes: typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength,
    });
  }

  const readTool: DocumentReadTool = withAgentHarnessToolEffects(
    {
      name: "document_read",
      label: "Read document",
      description:
        "Read a PDF, Word (.docx), Excel (.xlsx), CSV, HTML, Markdown, text or JSON file from the workspace as Markdown text. Use pages (PDF) or sheet (Excel) to narrow a long document.",
      parameters: DOCUMENT_READ_PARAMETERS,
      async execute(_toolCallId: string, params: Static<typeof DOCUMENT_READ_PARAMETERS>) {
        const result = await read(params);
        return { content: [{ type: "text" as const, text: toolText(result) }], details: result };
      },
    },
    {
      id: "documents.read",
      label: "Read document",
      effects: ["fs.read"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    },
  ) as DocumentReadTool;

  const extractTool: DocumentExtractTool = withAgentHarnessToolEffects(
    {
      name: "document_extract",
      label: "Extract document to file",
      description:
        "Convert a PDF, Word, Excel, HTML or other readable document to a Markdown file in the workspace and return only a short preview. Use for long documents, then search or read the saved file in parts.",
      parameters: DOCUMENT_EXTRACT_PARAMETERS,
      async execute(_toolCallId: string, params: Static<typeof DOCUMENT_EXTRACT_PARAMETERS>) {
        const result = await read(params);
        return { content: [{ type: "text" as const, text: toolText(result) }], details: result };
      },
    },
    {
      id: "documents.extract",
      label: "Extract document to file",
      effects: ["fs.read", "fs.write"],
      reversibility: "reversible-with-cost",
      retrySemantics: "safe-to-retry",
    },
  ) as DocumentExtractTool;

  const writeTool: DocumentWriteTool = withAgentHarnessToolEffects(
    {
      name: "document_write",
      label: "Write document",
      description:
        "Write a document to the workspace: Markdown content as .md, .txt, .html or Word .docx; rows as Excel .xlsx, .csv or .tsv; data as .json. Refuses to replace an existing file unless overwrite is true.",
      parameters: DOCUMENT_WRITE_PARAMETERS,
      async execute(_toolCallId: string, params: Static<typeof DOCUMENT_WRITE_PARAMETERS>) {
        const result = await write(params as DocumentWriteRequest);
        return {
          content: [
            {
              type: "text" as const,
              text: `Wrote ${result.path} (${result.format}, ${result.bytes} bytes).`,
            },
          ],
          details: result,
        };
      },
    },
    {
      id: "documents.write",
      label: "Write document",
      effects: ["fs.write"],
      reversibility: "reversible-with-cost",
      retrySemantics: "safe-to-retry",
    },
  ) as DocumentWriteTool;

  return Object.freeze({
    name,
    kind,
    root: workspace.root,
    piTools: Object.freeze([readTool, extractTool, writeTool]) as readonly [
      DocumentReadTool,
      DocumentExtractTool,
      DocumentWriteTool,
    ],
    read,
    write,
  });
}
