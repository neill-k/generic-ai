# @generic-ai/plugin-tools-documents

Document tools for generic work: agents read the PDFs, Word files and spreadsheets people send
them, and write reports and tables people can open. Everything stays inside the workspace root.

## Tools

| Tool | Effects | What it does |
| --- | --- | --- |
| `document_read` | `fs.read` | Read `.pdf`, `.docx`, `.xlsx`, `.csv`, `.tsv`, `.html`, `.md`, `.txt`, `.json`, `.yaml` or `.xml` as Markdown text. `pages` narrows a PDF (`"1-3,7"`), `sheet` picks a spreadsheet sheet, `maxChars` caps the output (default 20,000). |
| `document_extract` | `fs.read`, `fs.write` | Convert a document to a Markdown file at `saveTo` and return only a 2,000-character preview, so long documents stay out of the model's context. |
| `document_write` | `fs.write` | Write Markdown `content` as `.md`, `.txt`, `.html` or Word `.docx`; `sheets` of rows as Excel `.xlsx`, `.csv` or `.tsv`; `data` as `.json`. Refuses to replace a file unless `overwrite: true`. |

Read-only roles get `document_read`. Writing roles get all three.

What comes back:

- **PDF**: text per page under `## Page N` headings (text layer only; scanned images have no text).
- **Word**: headings, paragraphs, bold, italic, links, bullet and numbered lists, and tables as
  Markdown.
- **Excel**: each sheet as a Markdown table under `## <sheet name>`, using the first non-empty row
  as the header. Cached formula results are read; formulas themselves are not.
- **HTML**: readable Markdown with scripts and styles removed.

Legacy formats (`.doc`, `.xls`, `.ppt`, `.pptx`, `.rtf`, `.odt`) and PDF output are refused with a
hint to convert first. Files over 50 MB (`maxFileBytes`) are refused.

The Markdown writer supports headings, paragraphs, bullet and numbered lists (nested by two-space
indent), tables, fenced code, horizontal rules, and bold, italic, code and link spans. HTML output
escapes raw HTML and drops non-http links.

## Example

```ts
import { createDocumentTools } from "@generic-ai/plugin-tools-documents";

const documents = createDocumentTools({ root: workspaceRoot });

// Hand the tools to an agent harness run.
const customTools = [...documents.piTools];

// Or call them directly.
const brief = await documents.read({ path: "inbox/brief.pdf", pages: "1-2" });
await documents.write({ path: "out/summary.docx", content: "# Summary\n\n- Point one" });
await documents.write({
  path: "out/leads.xlsx",
  sheets: [{ name: "Leads", rows: [["Company", "Score"], ["Acme", 87]] }],
});
```

Errors are `DocumentToolError`, a `GenericAIToolError` with a structured envelope (`not_found`,
`invalid_input`, `policy_blocked`) and a remediation hint.

## Dependencies

`unpdf` (PDF text, MIT), `mammoth` (Word reading, BSD-2-Clause), `docx` (Word writing, MIT) and
`fflate` (zip for `.xlsx`, MIT). The `.xlsx` reader and writer are this package's own, so no
spreadsheet library with a large dependency tree is pulled in.
