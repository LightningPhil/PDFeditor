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
import type {
  TextReplacement,
  TextOffset,
  TextTransform,
  TextCopy,
} from "./text-edit";
import type { TextGroup } from "./text-boxes";
import { assertTextGroups } from "./text-boxes";

export type Annotation = {
  id: string;
  color: string;
  x: number;
  y: number;
  rotation?: number;
  locked?: boolean;
  role?: "page-number" | "header" | "footer";
} & (
  | { kind: "text"; text: string; size: number; font?: TextFont }
  | {
      kind: "rectangle";
      width: number;
      height: number;
      fill?: string;
      borderWidth?: number;
    }
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
  textTransforms?: TextTransform[];
  textCopies?: TextCopy[];
  lockedRunIds?: string[];
  crop?: { x: number; y: number; width: number; height: number };
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
    page.node.delete(PDFName.of("PDFeditorLockedText"));
    if (item.crop) {
      const b = item.crop,
        m = page.getMediaBox();
      if (
        ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
        b.width <= 0 ||
        b.height <= 0 ||
        b.x < m.x - 1e-5 ||
        b.y < m.y - 1e-5 ||
        b.x + b.width > m.x + m.width + 1e-5 ||
        b.y + b.height > m.y + m.height + 1e-5
      )
        throw Error("Crop must be a positive rectangle inside the media box.");
      page.setCropBox(b.x, b.y, b.width, b.height);
    }
    if (item.rotation) {
      if (!Number.isInteger(item.rotation / 90))
        throw new Error("Page rotation must be a multiple of 90 degrees.");
      page.setRotation(
        degrees(
          (((page.getRotation().angle + item.rotation) % 360) + 360) % 360,
        ),
      );
    }
    const needsMapping = !!(
      item.textGroups?.length ||
      item.lockedRunIds?.length ||
      item.annotations.some((a) => a.locked)
    );
    const sourceRuns = needsMapping
      ? inspectPageText(page, [], item.textCopies)
      : [];
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
    const expected = needsMapping
      ? sourceRuns.flatMap((run) => {
          const text = replacements.get(run.id) ?? run.text;
          return text.trim() ? [{ id: run.id, text, font: run.font }] : [];
        })
      : [];
    storePageTextGroups(page, []);
    replacePageText(
      page,
      item.textReplacements ?? [],
      item.textOffsets ?? [],
      item.textTransforms,
      item.textCopies,
    );
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
        if (needsMapping && annotation.text.trim())
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
          rotate: degrees(annotation.rotation ?? 0),
        });
      } else
        page.drawRectangle({
          x: annotation.x,
          y: annotation.y,
          width: annotation.width,
          height: annotation.height,
          borderColor: color,
          borderWidth: annotation.borderWidth ?? 2,
          ...(annotation.fill
            ? {
                color: rgb(
                  parseInt(annotation.fill.slice(1, 3), 16) / 255,
                  parseInt(annotation.fill.slice(3, 5), 16) / 255,
                  parseInt(annotation.fill.slice(5, 7), 16) / 255,
                ),
              }
            : {}),
        });
    }
    if (needsMapping)
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
      const locked = [
        ...new Set([
          ...(item.lockedRunIds ?? []),
          ...item.annotations
            .filter((a) => a.locked && a.kind === "text")
            .map((a) => `added:${a.id}`),
        ]),
      ].flatMap((id) => (mapping.has(id) ? [mapping.get(id)!] : []));
      if (locked.length)
        page.node.set(
          PDFName.of("PDFeditorLockedText"),
          PDFHexString.fromText(JSON.stringify(locked)),
        );
      else page.node.delete(PDFName.of("PDFeditorLockedText"));
    }
  }
  return output.save();
}
