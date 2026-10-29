import { PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import type { EditorPage } from "./pdf";
import type { EditableRun, TextReplacement } from "./text-edit";
import { getTextBoxes, getAllTextRuns } from "./text-boxes";
import { bounds } from "./geometry";
import { layoutParagraph, validateParagraph, textFonts } from "./typography";
import type { Paragraph } from "./typography";

export function applyTextEdits(
  page: EditorPage,
  edits: TextReplacement[],
): EditorPage {
  const locked = new Set([
    ...(page.lockedRunIds ?? []),
    ...page.annotations.filter((a) => a.locked).map((a) => `added:${a.id}`),
  ]);
  if (edits.some((edit) => locked.has(edit.runId)))
    throw Error("Unlock the selected text before editing it.");
  const map = new Map(edits.map((edit) => [edit.runId, edit]));
  const affected = new Set(
    (page.textGroups ?? [])
      .filter((group) => group.runIds.some((id) => map.has(id)))
      .map((group) => group.id),
  );
  return {
    ...page,
    annotations: page.annotations.map((a) =>
      a.kind === "text" && map.has(`added:${a.id}`)
        ? { ...a, text: map.get(`added:${a.id}`)!.replacement }
        : a,
    ),
    textReplacements: [
      ...(page.textReplacements ?? []).filter((edit) => !map.has(edit.runId)),
      ...edits.filter(
        (edit) =>
          !edit.runId.startsWith("added:") &&
          edit.original !== edit.replacement,
      ),
    ],
    paragraphs: page.paragraphs?.filter((p) => !affected.has(p.groupId)),
  };
}
/** Infer readable paragraph text from positions, without changing the source. */
export function paragraphFromSelection(
  page: EditorPage,
  runs: EditableRun[],
  ids: string[],
): Paragraph {
  const existing = page.paragraphs?.find(
    (p) => ids.length === 1 && ids[0] === p.groupId,
  );
  if (existing) return { ...existing };
  const boxes = getTextBoxes(page, runs).filter((box) => ids.includes(box.id));
  const pieces = boxes.flatMap((box) =>
    box.pieces.map((piece) => ({
      piece,
      run: box.runs.find((run) => run.id === piece.runId)!,
    })),
  );
  if (!pieces.length || boxes.some((box) => !box.movable))
    throw new Error("Select positioned text before formatting.");
  const area = bounds(pieces.flatMap((entry) => entry.piece.quad));
  const ordered = pieces.sort((a, b) =>
    Math.abs(a.piece.baseline.y - b.piece.baseline.y) >
    Math.max(2, (area.height / Math.max(pieces.length, 1)) * 0.4)
      ? b.piece.baseline.y - a.piece.baseline.y
      : a.piece.baseline.x - b.piece.baseline.x,
  );
  const replacements = new Map(
    (page.textReplacements ?? []).map((edit) => [edit.runId, edit.replacement]),
  );
  let text = "",
    previous: (typeof ordered)[number] | undefined;
  for (const entry of ordered) {
    const value = replacements.get(entry.run.id) ?? entry.run.text;
    if (previous && text && value && !/\s$/.test(text) && !/^\s/.test(value)) {
      const last = bounds(previous.piece.quad),
        now = bounds(entry.piece.quad);
      if (
        Math.abs(previous.piece.baseline.y - entry.piece.baseline.y) >
        Math.min(last.height, now.height) * 0.6
      )
        text += "\n";
      else if (
        now.x - last.x - last.width >
        Math.min(last.height, now.height) * 0.15
      )
        text += " ";
    }
    text += value;
    previous = entry;
  }
  const first = ordered[0];
  const height = bounds(first.piece.quad).height;
  return {
    groupId: "",
    text,
    x: area.x,
    y: first.piece.baseline.y,
    width: Math.max(30, Math.round(area.width * 100) / 100),
    size: Math.max(
      1,
      Math.min(300, Math.round((first.run.fontSize ?? height) * 100) / 100),
    ),
    font:
      textFonts.find(
        (font) => font === first.run.font.replace(/^[A-Z]{6}\+/, ""),
      ) ??
      (/bold/i.test(first.run.font)
        ? /italic|oblique/i.test(first.run.font)
          ? "Helvetica-BoldOblique"
          : "Helvetica-Bold"
        : /italic|oblique/i.test(first.run.font)
          ? "Helvetica-Oblique"
          : "Helvetica"),
    color:
      page.annotations.find((a) => `added:${a.id}` === first.run.id)?.color ??
      "#202a25",
    lineHeight: 1.3,
    align: "left",
  };
}
export function reflowSelection(
  page: EditorPage,
  runs: EditableRun[],
  ids: string[],
  paragraph: Paragraph,
  makeId: () => string,
): EditorPage {
  const selected = getTextBoxes(page, runs).filter((box) =>
    ids.includes(box.id),
  );
  if (
    !selected.length ||
    selected.length !== new Set(ids).size ||
    selected.some((box) => !box.movable || box.locked)
  )
    throw new Error("Select movable text to format.");
  const lines = layoutParagraph(paragraph).filter((line) => line.text.trim());
  if (!lines.length) throw new Error("Enter some paragraph text.");
  const members = new Set(
    selected.flatMap((box) => box.runs.map((run) => run.id)),
  );
  let next = applyTextEdits(
    page,
    getAllTextRuns(page, runs)
      .filter((run) => members.has(run.id) && !run.id.startsWith("added:"))
      .map((run) => ({ runId: run.id, original: run.text, replacement: "" })),
  );
  const groupId = paragraph.groupId || `paragraph:${makeId()}`;
  const annotations = lines.map((line) => ({
    id: makeId(),
    kind: "text" as const,
    text: line.text,
    x: line.x,
    y: line.y,
    size: paragraph.size,
    font: paragraph.font,
    color: paragraph.color,
  }));
  next = {
    ...next,
    annotations: [
      ...next.annotations.filter((a) => !members.has(`added:${a.id}`)),
      ...annotations,
    ],
    textGroups: [
      ...(next.textGroups ?? []).filter((group) => !ids.includes(group.id)),
      { id: groupId, runIds: annotations.map((a) => `added:${a.id}`) },
    ],
    paragraphs: [
      ...(next.paragraphs ?? []).filter((p) => !ids.includes(p.groupId)),
      { ...paragraph, groupId },
    ],
  };
  return next;
}
export async function readDocumentParagraphs(
  bytes: Uint8Array,
  groups: { id: string }[][],
): Promise<Paragraph[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page, index) => {
    try {
      const value = page.node.lookup(PDFName.of("PDFeditorParagraphs"));
      if (
        !(value instanceof PDFHexString) ||
        value.sizeInBytes() > 4 * 1024 * 1024
      )
        return [];
      const bytes = value.asBytes();
      const json = new TextDecoder("utf-16be", { fatal: true }).decode(
        bytes.subarray(2),
      );
      const data = JSON.parse(json);
      if (
        data.version !== 1 ||
        !Array.isArray(data.paragraphs) ||
        data.paragraphs.length > 1000
      )
        return [];
      return data.paragraphs.filter((p: Paragraph) => {
        try {
          validateParagraph(p);
          return groups[index]?.some((g) => g.id === p.groupId);
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  });
}
