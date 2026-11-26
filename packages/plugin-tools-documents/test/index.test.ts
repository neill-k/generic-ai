import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GenericAIToolError, getAgentHarnessToolEffects } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDocumentTools,
  DocumentToolError,
  htmlToMarkdown,
  markdownToDocx,
  markdownToHtml,
  parseMarkdown,
  parsePageSelection,
  readXlsx,
  rowsToDelimited,
  writeXlsx,
} from "../src/index.js";

/** Build a small, valid PDF with one line of Helvetica text per page. */
function makePdf(pages: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_page, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-documents-"));
  roots.push(root);
  return { root, tools: createDocumentTools({ root }) };
}

const REPORT = [
  "# Quarterly report",
  "",
  "Revenue grew **12%** with *strong* demand. See [the site](https://example.com).",
  "",
  "## Highlights",
  "",
  "- New customers",
  "- Lower churn",
  "  - Mostly enterprise",
  "",
  "1. Hire",
  "2. Ship",
  "",
  "| Region | Revenue |",
  "| --- | --- |",
  "| North | 120 |",
  "| South | 80 |",
].join("\n");

describe("markdown model", () => {
  it("parses headings, lists, tables and code", () => {
    const blocks = parseMarkdown(`${REPORT}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n---`);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "list",
      "table",
      "code",
      "rule",
    ]);
    expect(blocks[3]).toMatchObject({
      ordered: false,
      items: [
        { text: "New customers", level: 0 },
        { text: "Lower churn", level: 0 },
        { text: "Mostly enterprise", level: 1 },
      ],
    });
    expect(blocks[5]).toMatchObject({
      header: ["Region", "Revenue"],
      rows: [
        ["North", "120"],
        ["South", "80"],
      ],
    });
  });

  it("renders HTML without passing raw HTML or unsafe links through", () => {
    const html = markdownToHtml(
      "# Title <script>\n\nHi [x](javascript:alert(1)) and **bold**",
      "T",
    );
    expect(html).toContain("<h1>Title &lt;script&gt;</h1>");
    expect(html).toContain('<a href="#">x</a>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>");
  });

  it("converts HTML back to Markdown, dropping scripts", () => {
    const markdown = htmlToMarkdown(
      "<html><head><title>x</title></head><body><script>evil()</script><h2>Plan</h2><p>Do <b>this</b> &amp; <a href='#'>that</a>.</p><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>",
    );
    expect(markdown).not.toContain("evil");
    expect(markdown).toContain("## Plan");
    expect(markdown).toContain("Do **this** & that.");
    expect(markdown).toContain("- One\n- Two");
    expect(markdown).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });
});

describe("spreadsheets", () => {
  it("round-trips sheets, types and awkward names through xlsx", () => {
    const data = writeXlsx([
      {
        name: "Sales",
        rows: [["Region", "Q1", "Closed"], ["North <&>", 120.5, true], [], [null, 3, false]],
      },
      { name: "Sales", rows: [["dup"]] },
      { name: "a/b:c", rows: [["x"]] },
    ]);
    const sheets = readXlsx(data);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Sales", "Sales 2", "a b c"]);
    expect(sheets[0]?.rows).toEqual([
      ["Region", "Q1", "Closed"],
      ["North <&>", 120.5, true],
      [],
      [null, 3, false],
    ]);
  });

  it("rejects files that are not spreadsheets", () => {
    expect(() => readXlsx(new TextEncoder().encode("not a zip"))).toThrow(/not a readable/);
  });

  it("quotes CSV cells that need it", () => {
    expect(rowsToDelimited([["a", 'say "hi"', "x,y", 1, null]], ",")).toBe(
      'a,"say ""hi""","x,y",1,\n',
    );
    expect(rowsToDelimited([["a\tb", "c"]], "\t")).toBe("a b\tc\n");
  });
});

describe("document tools", () => {
  it("declares effects so read-only roles can read but not write", async () => {
    const { tools } = await workspace();
    const [read, extract, write] = tools.piTools;
    expect(read.name).toBe("document_read");
    expect(getAgentHarnessToolEffects(read)).toEqual(["fs.read"]);
    expect(getAgentHarnessToolEffects(extract)).toEqual(["fs.read", "fs.write"]);
    expect(getAgentHarnessToolEffects(write)).toEqual(["fs.write"]);
  });

  it("reads PDFs page by page and honours page selections", async () => {
    const { root, tools } = await workspace();
    await writeFile(
      path.join(root, "brief.pdf"),
      makePdf(["Executive summary", "Budget details", "Appendix"]),
    );

    const all = await tools.read({ path: "brief.pdf" });
    expect(all).toMatchObject({
      format: "pdf",
      pageCount: 3,
      pagesRead: [1, 2, 3],
      truncated: false,
    });
    expect(all.text).toContain("## Page 1\n\nExecutive summary");
    expect(all.text).toContain("## Page 3\n\nAppendix");

    const some = await tools.read({ path: "brief.pdf", pages: "2-" });
    expect(some.pagesRead).toEqual([2, 3]);
    expect(some.text).not.toContain("Executive");
  });

  it("writes Word documents and reads them back as Markdown", async () => {
    const { tools } = await workspace();
    const written = await tools.write({ path: "out/report.docx", content: REPORT });
    expect(written).toMatchObject({ path: "out/report.docx", format: "docx" });
    expect(written.bytes).toBeGreaterThan(1000);

    const read = await tools.read({ path: "out/report.docx" });
    expect(read.format).toBe("docx");
    expect(read.text).toContain("# Quarterly report");
    expect(read.text).toContain("## Highlights");
    expect(read.text).toContain("**12%**");
    expect(read.text).toContain("[the site](https://example.com)");
    expect(read.text).toContain("- New customers");
    expect(read.text).toContain("1. Hire\n2. Ship");
    expect(read.text).toContain("| North | 120 |");
  });

  it("writes and reads spreadsheets, CSV, HTML and JSON", async () => {
    const { root, tools } = await workspace();
    await tools.write({
      path: "data.xlsx",
      sheets: [
        {
          name: "People",
          rows: [
            ["Name", "Age"],
            ["Ada", 36],
            ["Alan | T", 41],
          ],
        },
        { name: "Empty", rows: [] },
      ],
    });
    const sheet = await tools.read({ path: "data.xlsx", sheet: "People" });
    expect(sheet.sheets).toEqual(["People", "Empty"]);
    expect(sheet.text).toBe(
      "## People\n\n| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Alan \\| T | 41 |",
    );
    await expect(tools.read({ path: "data.xlsx", sheet: "Nope" })).rejects.toThrow(
      /No sheet named "Nope"/,
    );

    await tools.write({ path: "data.csv", sheets: [{ rows: [["a", "b,c"]] }] });
    expect(await readFile(path.join(root, "data.csv"), "utf8")).toBe('a,"b,c"\n');

    await tools.write({ path: "page.html", content: REPORT });
    const html = await tools.read({ path: "page.html" });
    expect(html.text).toContain("# Quarterly report");

    await tools.write({ path: "facts.json", data: { ok: true } });
    expect((await tools.read({ path: "facts.json" })).text).toBe('{\n  "ok": true\n}\n');
    await expect(tools.write({ path: "bad.json", content: "{nope" })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("truncates long output and points at document_extract", async () => {
    const { root, tools } = await workspace();
    await writeFile(path.join(root, "long.txt"), "x".repeat(5_000));
    const [read, extract] = tools.piTools;

    const result = await read.execute("call-1", { path: "long.txt", maxChars: 1_000 });
    expect(result.details).toMatchObject({ truncated: true, totalChars: 5_000 });
    expect(result.content[0]?.text).toContain("4000 more characters. Use document_extract");

    const saved = await extract.execute("call-2", { path: "long.txt", saveTo: "notes/long.md" });
    expect(saved.details.savedTo).toBe("notes/long.md");
    expect(saved.details.text).toHaveLength(2_000);
    expect(saved.content[0]?.text).toContain("Full text saved to notes/long.md");
    expect(await readFile(path.join(root, "notes/long.md"), "utf8")).toHaveLength(5_000);
  });

  it("refuses to overwrite unless asked", async () => {
    const { tools } = await workspace();
    await tools.write({ path: "a.md", content: "one" });
    await expect(tools.write({ path: "a.md", content: "two" })).rejects.toThrow(/already exists/);
    await tools.write({ path: "a.md", content: "two", overwrite: true });
    expect((await tools.read({ path: "a.md" })).text).toBe("two");
  });

  it("reports structured errors for bad input", async () => {
    const { root, tools } = await workspace();
    const missing = await tools.read({ path: "nope.pdf" }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(GenericAIToolError);
    expect((missing as DocumentToolError).envelope.kind).toBe("not_found");

    await expect(tools.read({ path: "old.doc" })).rejects.toThrow(/Word 97-2003/);
    await expect(tools.write({ path: "out.pdf", content: "x" })).rejects.toThrow(/PDF output/);
    await expect(tools.read({ path: "../escape.txt" })).rejects.toThrow(/outside the workspace/);

    await writeFile(path.join(root, "fake.pdf"), "not a pdf");
    const notPdf = await tools.read({ path: "fake.pdf" }).catch((error: unknown) => error);
    expect((notPdf as DocumentToolError).envelope.kind).toBe("invalid_input");
    await writeFile(path.join(root, "fake.docx"), "not a docx");
    await expect(tools.read({ path: "fake.docx" })).rejects.toThrow(/not a readable Word/);
    await writeFile(path.join(root, "x.txt"), "x");
    await expect(tools.read({ path: "x.txt", pages: "1" })).rejects.toThrow(/PDF files only/);
  });

  it("does not follow symlinks out of the workspace", async () => {
    const { root, tools } = await workspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-documents-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await mkdir(path.join(root, "links"));
    await symlink(outside, path.join(root, "links", "out"));
    await expect(tools.read({ path: "links/out/secret.txt" })).rejects.toThrow(/outside/);
    await expect(tools.write({ path: "links/out/new.md", content: "x" })).rejects.toThrow();
  });

  it("parses page selections", () => {
    expect(parsePageSelection("3,1-2, 2", 5)).toEqual([1, 2, 3]);
    expect(parsePageSelection("4-", 5)).toEqual([4, 5]);
    expect(() => parsePageSelection("0", 5)).toThrow(/Invalid page selection/);
    expect(() => parsePageSelection("9", 5)).toThrow(/matches no pages/);
  });

  it("writes Word files directly from Markdown", async () => {
    const bytes = await markdownToDocx("# Hi\n\n1. a\n2. b", "Hi");
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK");
  });
});
