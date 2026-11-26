import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { decodeEntities, escapeHtml } from "./markdown.js";

/**
 * Minimal Office Open XML spreadsheet (.xlsx) reader and writer. It reads cell values (shared and
 * inline strings, numbers, booleans, cached formula results) from every sheet, and writes plain
 * value sheets. Styles, merged cells, charts and formulas are out of scope.
 */

export type CellValue = string | number | boolean | null;

export interface Sheet {
  readonly name: string;
  readonly rows: readonly (readonly CellValue[])[];
}

/** Refuse archives that would inflate past this many bytes. */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetError";
  }
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

function textOf(xml: string): string {
  // Concatenate every <t> run, which covers plain and rich-text strings.
  let text = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    text += decodeEntities(match[1] ?? "");
  }
  return text;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function columnLetters(index: number): string {
  let letters = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function resolveTarget(target: string): string {
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

export function readXlsx(data: Uint8Array): readonly Sheet[] {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter(file) {
        total += file.originalSize;
        if (total > MAX_UNZIPPED_BYTES) {
          throw new SpreadsheetError("Spreadsheet is too large to read (over 200 MB unpacked).");
        }
        return (
          (file.name.startsWith("xl/") && file.name.endsWith(".xml")) || file.name.endsWith(".rels")
        );
      },
    });
  } catch (error) {
    if (error instanceof SpreadsheetError) {
      throw error;
    }
    throw new SpreadsheetError("File is not a readable .xlsx spreadsheet.");
  }
  const read = (name: string): string | undefined => {
    const file = files[name];
    return file === undefined ? undefined : strFromU8(file);
  };

  const workbook = read("xl/workbook.xml");
  if (workbook === undefined) {
    throw new SpreadsheetError("File is not a readable .xlsx spreadsheet (no workbook).");
  }
  const rels = new Map<string, string>();
  for (const match of (read("xl/_rels/workbook.xml.rels") ?? "").matchAll(
    /<Relationship\b[^>]*>/g,
  )) {
    const id = attribute(match[0], "Id");
    const target = attribute(match[0], "Target");
    if (id !== undefined && target !== undefined) {
      rels.set(id, resolveTarget(target));
    }
  }
  const shared: string[] = [];
  for (const match of (read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(textOf(match[1] ?? ""));
  }

  const sheets: Sheet[] = [];
  let position = 0;
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    position += 1;
    const name = attribute(match[0], "name") ?? `Sheet${position}`;
    const relId = attribute(match[0], "r:id");
    const path =
      (relId === undefined ? undefined : rels.get(relId)) ?? `xl/worksheets/sheet${position}.xml`;
    const xml = read(path) ?? "";
    const rows: CellValue[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNumber = Number(attribute(`<row ${rowMatch[1] ?? ""}>`, "r") ?? rows.length + 1);
      const row: CellValue[] = [];
      for (const cell of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c ${cell[1] ?? ""}>`;
        const body = cell[2] ?? "";
        const ref = attribute(tag, "r");
        const column = ref === undefined ? row.length : columnIndex(ref);
        const type = attribute(tag, "t");
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: CellValue = null;
        if (type === "s") {
          value = shared[Number(raw)] ?? "";
        } else if (type === "inlineStr") {
          value = textOf(body);
        } else if (type === "b") {
          value = raw === "1";
        } else if (type === "str" || type === "e") {
          value = raw === undefined ? null : decodeEntities(raw);
        } else if (raw !== undefined) {
          const number = Number(raw);
          value = Number.isFinite(number) ? number : decodeEntities(raw);
        }
        while (row.length < column) {
          row.push(null);
        }
        row[column] = value;
      }
      while (rows.length < rowNumber - 1) {
        rows.push([]);
      }
      rows[rowNumber - 1] = row;
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

function sheetXml(rows: readonly (readonly CellValue[])[]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === undefined || value === "") {
            return "";
          }
          const ref = `${columnLetters(columnIndex)}${rowIndex + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          if (typeof value === "boolean") {
            return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeHtml(
            String(value),
          )}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function sheetName(name: string, index: number, used: Set<string>): string {
  let clean =
    name
      .replace(/[\\/?*[\]:]/g, " ")
      .trim()
      .slice(0, 31) || `Sheet${index + 1}`;
  let suffix = 2;
  while (used.has(clean.toLowerCase())) {
    clean = `${clean.slice(0, 28)} ${suffix}`;
    suffix += 1;
  }
  used.add(clean.toLowerCase());
  return clean;
}

export function writeXlsx(sheets: readonly Sheet[]): Uint8Array {
  if (sheets.length === 0) {
    throw new SpreadsheetError("A spreadsheet needs at least one sheet.");
  }
  const used = new Set<string>();
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index, used));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names
        .map(
          (_name, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("")}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map(
          (name, index) =>
            `<sheet name="${escapeHtml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
        .map(
          (_name, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet.rows));
  });
  return zipSync(files, { level: 6 });
}
