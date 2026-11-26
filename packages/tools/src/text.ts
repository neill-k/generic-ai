/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
  return splitBom(content).text;
}
