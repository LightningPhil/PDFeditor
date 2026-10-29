import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PDFName,
  PDFHexString,
} from "pdf-lib";
import type { Paragraph, TextFont } from "./typography";
import { validateParagraph } from "./typography";
import { replacePageText, inspectPageText } from "./text-edit";
import { storePageTextGroups } from "./text-group-storage";
import type { TextReplacement, TextOffset } from "./text-edit";
import type { TextGroup } from "./text-boxes";
import { assertTextGroups } from "./text-boxes";

export type Annotation = { id: string; color: string; x: number; y: number } & (
  | { kind: "text"; text: string; size: number; font?: TextFont }
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
  rotation?: number;
  paragraphs?: Paragraph[];
}

/** Annotations render in a separate SVG layer; grouping never affects pixels. */
export function exportPagePreview(
  source: Source,
  page: EditorPage,
  includeAnnotations = false,
) {
  return exportPdf(
    [source],
    [
      {
        ...page,
        annotations: includeAnnotations ? page.annotations : [],
        textGroups: [],
        paragraphs: [],
      },
    ],
  );
}

/** Copy pages without rasterising their original text or graphics. */
export async function exportPdf(sources: Source[], pages: EditorPage[]) {
  if (!pages.length) throw new Error("Add at least one page before exporting.");
  const output = await PDFDocument.create();
  const loaded = new Map<string, PDFDocument>();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const fonts = new Map<string, typeof font>([["Helvetica", font]]);
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
    if (item.rotation) {
      if (!Number.isInteger(item.rotation / 90))
        throw new Error("Page rotation must be a multiple of 90 degrees.");
      page.setRotation(
        degrees(
          (((page.getRotation().angle + item.rotation) % 360) + 360) % 360,
        ),
      );
    }
    const sourceRuns = item.textGroups?.length ? inspectPageText(page) : [];
    const validGroups = assertTextGroups(item.textGroups ?? [], [
      ...sourceRuns.map((run) => run.id),
      ...item.annotations
        .filter((annotation) => annotation.kind === "text")
        .map((annotation) => `added:${annotation.id}`),
    ]);
    const replacements = new Map(
      (item.textReplacements ?? []).map((edit) => [
        edit.runId,
        edit.replacement,
      ]),
    );
    const expected = item.textGroups?.length
      ? sourceRuns.flatMap((run) => {
          const text = replacements.get(run.id) ?? run.text;
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
        const fontName = annotation.font ?? "Helvetica";
        let annotationFont = fonts.get(fontName);
        if (!annotationFont) {
          annotationFont = await output.embedFont(fontName as StandardFonts);
          fonts.set(fontName, annotationFont);
        }
        if (item.textGroups?.length && annotation.text.trim())
          expected.push({
            id: `added:${annotation.id}`,
            text: annotation.text,
            font: fontName,
          });
        try {
          annotationFont.encodeText(annotation.text);
        } catch {
          throw new Error(
            "An annotation contains unsupported characters. This first version supports basic Latin text. Undo that annotation before exporting.",
          );
        }
        page.drawText(annotation.text, {
          x: annotation.x,
          y: annotation.y,
          size: annotation.size,
          font: annotationFont,
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
    if (validGroups.length)
      grouped.push({
        page,
        item: { ...item, textGroups: validGroups },
        expected,
      });
    page.node.delete(PDFName.of("PDFeditorParagraphs"));
    const paragraphs = (item.paragraphs ?? []).filter((p) =>
      validGroups.some((g) => g.id === p.groupId),
    );
    if (paragraphs.length) {
      paragraphs.forEach(validateParagraph);
      const json = JSON.stringify({ version: 1, paragraphs });
      if (json.length > 900000 || paragraphs.length > 1000)
        throw new Error(
          "Too much paragraph data on this page. Split the document before exporting.",
        );
      page.node.set(
        PDFName.of("PDFeditorParagraphs"),
        PDFHexString.fromText(json),
      );
    }
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
