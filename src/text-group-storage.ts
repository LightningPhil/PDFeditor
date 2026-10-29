import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import type { TextGroup } from "./text-boxes";

const key = PDFName.of("PDFeditorTextGroups");
/** Private page metadata: other viewers ignore it, so it cannot affect appearance. */
export async function readDocumentTextGroups(
  bytes: Uint8Array,
): Promise<TextGroup[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    try {
      const value = page.node.lookup(key);
      if (!(value instanceof PDFString)) return [];
      const data = JSON.parse(value.decodeText());
      if (
        data.version !== 1 ||
        !Array.isArray(data.groups) ||
        data.groups.length > 10000
      )
        return [];
      const seen = new Set<string>(),
        ids = new Set<string>();
      const groups: TextGroup[] = [];
      for (const group of data.groups) {
        if (
          !group ||
          typeof group.id !== "string" ||
          !group.id ||
          /^\d+:\d+$/.test(group.id) ||
          group.id.startsWith("added:") ||
          ids.has(group.id) ||
          !Array.isArray(group.runIds) ||
          !group.runIds.length ||
          group.runIds.length > 10000
        )
          continue;
        const members = group.runIds.filter(
          (id: unknown): id is string =>
            typeof id === "string" && /^\d+:\d+$/.test(id) && !seen.has(id),
        );
        const unique = [...new Set<string>(members)];
        if (!unique.length) continue;
        unique.forEach((id) => seen.add(id));
        ids.add(group.id);
        groups.push({ id: group.id, runIds: unique });
      }
      return groups;
    } catch {
      return [];
    }
  });
}
export function storePageTextGroups(page: PDFPage, groups: TextGroup[]) {
  page.node.delete(key);
  if (groups.length)
    page.node.set(key, PDFString.of(JSON.stringify({ version: 1, groups })));
}
