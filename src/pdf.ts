import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { replacePageText, inspectPageText } from "./text-edit";
import { storePageTextGroups } from "./text-group-storage";
import type { TextReplacement, TextOffset } from "./text-edit";
import type { TextGroup } from "./text-boxes";

export type Annotation = { id: string; color: string; x: number; y: number } & (
  | { kind: "text"; text: string; size: number }
  | { kind: "rectangle"; width: number; height: number }
);
export interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
}
export interface EditorPage {
  id: string;
  sourceId: string;
  index: number;
  annotations: Annotation[];
  textReplacements?: TextReplacement[];
  textOffsets?: TextOffset[];
  textGroups?: TextGroup[];
}

/** Copy pages without rasterising their original text or graphics. */
export async function exportPdf(sources: Source[], pages: EditorPage[]) {
  if (!pages.length) throw new Error("Add at least one page before exporting.");
  const output = await PDFDocument.create();
  const loaded = new Map<string, PDFDocument>();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const grouped: {
    page: ReturnType<PDFDocument["getPage"]>;
    item: EditorPage;
    expected: { id: string; text: string; font: string }[];
  }[] = [];
  for (const item of pages) {
    let original = loaded.get(item.sourceId);
    if (!original) {
      const source = sources.find((source) => source.id === item.sourceId);
      if (!source)
        throw new Error("Source PDF missing. Please reopen the document.");
      original = await PDFDocument.load(source.bytes);
      loaded.set(item.sourceId, original);
    }
    const [page] = await output.copyPages(original, [item.index]);
    output.addPage(page);
    const expected = item.textGroups?.length
      ? inspectPageText(page).flatMap((run) => {
          const text =
            item.textReplacements?.find((edit) => edit.runId === run.id)
              ?.replacement ?? run.text;
          return text.trim() ? [{ id: run.id, text, font: run.font }] : [];
        })
      : [];
    storePageTextGroups(page, []);
    replacePageText(page, item.textReplacements ?? [], item.textOffsets ?? []);
    for (const annotation of item.annotations) {
      const hex = annotation.color.replace("#", "");
      const color = rgb(
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
      );
      if (annotation.kind === "text") {
        if (item.textGroups?.length && annotation.text.trim())
          expected.push({
            id: `added:${annotation.id}`,
            text: annotation.text,
            font: "Helvetica",
          });
        try {
          font.encodeText(annotation.text);
        } catch {
          throw new Error(
            "An annotation contains unsupported characters. This first version supports basic Latin text. Undo that annotation before exporting.",
          );
        }
        page.drawText(annotation.text, {
          x: annotation.x,
          y: annotation.y,
          size: annotation.size,
          font,
          color,
        });
      } else
        page.drawRectangle({
          x: annotation.x,
          y: annotation.y,
          width: annotation.width,
          height: annotation.height,
          borderColor: color,
          borderWidth: 2,
        });
    }
    if (item.textGroups?.length) grouped.push({ page, item, expected });
  }
  if (grouped.length) {
    await output.flush();
    for (const { page, item, expected } of grouped) {
      const actual = inspectPageText(page);
      if (
        actual.length !== expected.length ||
        actual.some(
          (run, index) =>
            run.text !== expected[index].text ||
            run.font !== expected[index].font,
        )
      )
        throw new Error(
          "Unable to preserve this joined text box. Ungroup it before exporting.",
        );
      const mapping = new Map(
        expected.map((entry, index) => [entry.id, actual[index].id]),
      );
      storePageTextGroups(
        page,
        (item.textGroups ?? [])
          .map((group) => ({
            id: group.id,
            runIds: group.runIds.flatMap((id) =>
              mapping.has(id) ? [mapping.get(id)!] : [],
            ),
          }))
          .filter((group) => group.runIds.length),
      );
    }
  }
  return output.save();
}
