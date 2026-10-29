import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { replacePageText } from "./text-edit";
import type { TextReplacement } from "./text-edit";

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
}

/** Copy pages without rasterising their original text or graphics. */
export async function exportPdf(sources: Source[], pages: EditorPage[]) {
  if (!pages.length) throw new Error("Add at least one page before exporting.");
  const output = await PDFDocument.create();
  const loaded = new Map<string, PDFDocument>();
  const font = await output.embedFont(StandardFonts.Helvetica);
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
    replacePageText(page, item.textReplacements ?? []);
    for (const annotation of item.annotations) {
      const hex = annotation.color.replace("#", "");
      const color = rgb(
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
      );
      if (annotation.kind === "text") {
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
  }
  return output.save();
}
