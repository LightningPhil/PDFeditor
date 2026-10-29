import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { layoutParagraph, textWidth, textFonts } from "./typography";
import type { Paragraph } from "./typography";
import type { EditorPage } from "./pdf";
import { exportPdf } from "./pdf";
import {
  applyTextEdits,
  reflowSelection,
  readDocumentParagraphs,
} from "./document-editing";
import { inspectEditableText } from "./text-edit";
import type { EditableRun } from "./text-edit";
import { readDocumentTextGroups } from "./text-group-storage";
import {
  duplicatePages,
  reorderPages,
  rotatePages,
  documentChanges,
  movePagesTo,
} from "./page-operations";
import { findText, replacementEdits } from "./search";
import { alignText, snapTextMove } from "./text-alignment";
import { getTextBoxes } from "./text-boxes";
const model = (id = "p"): EditorPage => ({
  id,
  sourceId: "s",
  index: 0,
  annotations: [],
});
const paragraph: Paragraph = {
  groupId: "",
  text: "One two three four\n\nLast",
  x: 30,
  y: 400,
  width: 60,
  font: "Helvetica-Bold",
  size: 12,
  color: "#225588",
  lineHeight: 1.5,
  align: "center",
};
const run = (id: string, text: string, x: number, y = 400): EditableRun => ({
  id,
  text,
  font: "Helvetica",
  characters: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .[]",
  geometry: {
    baseline: { x, y },
    quad: [
      { x, y: y - 2 },
      { x: x + text.length * 6, y: y - 2 },
      { x: x + text.length * 6, y: y + 10 },
      { x, y: y + 10 },
    ],
  },
});
describe("workspace editing", () => {
  it("moves discontiguous pages to exact original boundaries, including the end", () => {
    const pages = [model("a"), model("b"), model("c"), model("d"), model("e")];
    expect(movePagesTo(pages, ["b", "d"], 5).map((p) => p.id)).toEqual([
      "a",
      "c",
      "e",
      "b",
      "d",
    ]);
    expect(movePagesTo(pages, ["b", "d"], 3).map((p) => p.id)).toEqual([
      "a",
      "c",
      "b",
      "d",
      "e",
    ]);
    expect(movePagesTo(pages, ["d", "b"], 0).map((p) => p.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
    expect(
      movePagesTo(
        pages,
        pages.map((p) => p.id),
        2,
      ),
    ).toEqual(pages);
    expect(movePagesTo(pages, [], 0)).toBe(pages);
    expect(() => movePagesTo(pages, ["b"], 6)).toThrow("position");
    expect(pages.map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
  for (const font of textFonts)
    it(`exports native formatted text in ${font} and keeps its group`, async () => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 500]);
      const bytes = await doc.save();
      const page: EditorPage = {
        ...model(),
        rotation: 90,
        annotations: [
          {
            id: "a",
            kind: "text",
            text: "Formatted £25",
            font,
            size: 17,
            color: "#285599",
            x: 40,
            y: 400,
          },
          {
            id: "b",
            kind: "text",
            text: "Second line",
            font,
            size: 17,
            color: "#285599",
            x: 40,
            y: 370,
          },
        ],
        textGroups: [{ id: "g", runIds: ["added:a", "added:b"] }],
      };
      const saved = await exportPdf(
        [{ id: "s", name: "font.pdf", bytes }],
        [page],
      );
      const actual = await inspectEditableText(saved, 0);
      expect(actual.map((r) => r.text)).toEqual([
        "Formatted £25",
        "Second line",
      ]);
      expect(actual.every((r) => r.font === font)).toBe(true);
      expect(
        actual[0].geometry!.quad[1].x - actual[0].geometry!.quad[0].x,
      ).toBeCloseTo(textWidth("Formatted £25", font, 17), 4);
      expect(
        (await PDFDocument.load(saved)).getPage(0).getRotation().angle,
      ).toBe(90);
      expect((await readDocumentTextGroups(saved))[0][0].runIds).toHaveLength(
        2,
      );
    });
  it("replaces several matches in a single native run without losing its prefix or suffix", () => {
    const runs = [run("0:1", "A cat cat Z", 10)];
    const matches = findText(model(), runs, "cat");
    expect(matches).toHaveLength(2);
    expect(replacementEdits(matches, "dog")).toEqual([
      { runId: "0:1", original: "A cat cat Z", replacement: "A dog dog Z" },
    ]);
  });
  it("wraps measured text, honours blank lines, alignment and line spacing", () => {
    const lines = layoutParagraph(paragraph);
    expect(lines.map((l) => l.text)).toEqual([
      "One two",
      "three four",
      "",
      "Last",
    ]);
    for (const [index, line] of lines.entries()) {
      expect(
        textWidth(line.text, paragraph.font, paragraph.size),
      ).toBeLessThanOrEqual(paragraph.width);
      expect(line.y).toBe(400 - index * 18);
      expect(line.x).toBeCloseTo(
        30 + (60 - textWidth(line.text, paragraph.font, 12)) / 2,
      );
    }
    const long = layoutParagraph({
      ...paragraph,
      text: "Supercalifragilistic",
      width: 15,
    });
    expect(long.length).toBeGreaterThan(3);
    expect(long.map((l) => l.text).join("")).toBe("Supercalifragilistic");
    expect(() => layoutParagraph({ ...paragraph, text: "Hello 🧩" })).toThrow(
      "cannot display",
    );
  });
  it("reflows genuine native text, keeps other text, and restores paragraph settings", async () => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica),
      p = doc.addPage([400, 500]);
    p.drawText("Original", { font, x: 30, y: 400, size: 12 });
    p.drawText("Keep me", { font, x: 30, y: 100, size: 12 });
    const bytes = await doc.save(),
      runs = await inspectEditableText(bytes, 0);
    let id = 0;
    const edited = reflowSelection(
      model(),
      runs,
      [runs[0].id],
      paragraph,
      () => `new${id++}`,
    );
    const saved = await exportPdf(
      [{ id: "s", name: "example.pdf", bytes }],
      [edited],
    );
    const actual = await inspectEditableText(saved, 0);
    expect(actual.map((r) => r.text)).toEqual([
      "Keep me",
      "One two",
      "three four",
      "Last",
    ]);
    expect(actual.slice(1).every((r) => r.font === "Helvetica-Bold")).toBe(
      true,
    );
    const groups = await readDocumentTextGroups(saved),
      paragraphs = await readDocumentParagraphs(saved, groups);
    expect(groups[0][0].runIds).toHaveLength(3);
    expect(paragraphs[0][0]).toMatchObject({
      ...paragraph,
      groupId: "paragraph:new0",
    });
    const reopened = {
      ...model(),
      textGroups: groups[0],
      paragraphs: paragraphs[0],
    };
    const again = reflowSelection(
      reopened,
      actual,
      [groups[0][0].id],
      { ...paragraphs[0][0], text: "Another paragraph", width: 120 },
      () => `again${id++}`,
    );
    const savedAgain = await exportPdf(
      [{ id: "s", name: "again.pdf", bytes: saved }],
      [again],
    );
    expect(
      (await inspectEditableText(savedAgain, 0)).map((r) => r.text).join(" "),
    ).toBe("Keep me Another paragraph");
  });
  it("reorders a selection as one block, duplicates independently, rotates and reviews removals", () => {
    const pages = [model("a"), model("b"), model("c"), model("d")];
    expect(reorderPages(pages, ["b", "d"], "a").map((p) => p.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
    const copied = duplicatePages(pages, ["b"], () => "copy");
    copied[2].annotations.push({
      id: "new",
      kind: "text",
      text: "Copy",
      size: 12,
      color: "#000000",
      x: 10,
      y: 10,
    });
    expect(pages[1].annotations).toHaveLength(0);
    const rotated = rotatePages(copied, ["copy"]);
    expect(rotated[2].rotation).toBe(90);
    expect(rotatePages(rotated, ["copy"], 270)[2].rotation).toBe(0);
    expect(
      documentChanges(
        rotated.filter((p) => p.id !== "a"),
        pages,
      )
        .map((c) => c.title)
        .join(" "),
    ).toContain("removed");
  });
  it("finds and replaces across fragmented runs and treats search syntax literally", () => {
    const runs = [
      run("0:1", "Hello", 10),
      run("0:2", "world", 45),
      run("0:3", "[A.]", 10, 370),
    ];
    const matches = findText(model(), runs, "hello world");
    expect(matches).toHaveLength(1);
    expect(matches[0].segments).toHaveLength(2);
    const edits = replacementEdits(matches, "New");
    expect(edits.map((e) => e.replacement)).toEqual(["New", ""]);
    const changed = applyTextEdits(model(), edits);
    expect(findText(changed, runs, "New")).toHaveLength(1);
    expect(findText(model(), runs, "[A.]")).toHaveLength(1);
    expect(findText(model(), runs, "Hello", true, true)).toHaveLength(1);
    expect(findText(model(), runs, "ello", false, true)).toHaveLength(0);
    expect(() => replacementEdits(matches, "🧩")).toThrow("cannot display");
  });
  it("aligns baselines, distributes gaps, and snaps without including the moving boxes", () => {
    const runs = [
      run("0:1", "One", 10, 400),
      run("0:2", "Two", 55, 380),
      run("0:3", "Three", 100, 360),
    ];
    const ids = runs.map((r) => r.id),
      aligned = alignText(model(), runs, ids, "baseline");
    expect(
      getTextBoxes(aligned, runs).map((b) => b.pieces[0].baseline.y),
    ).toEqual([400, 400, 400]);
    const distributed = getTextBoxes(
      alignText(model(), runs, ids, "horizontal"),
      runs,
    );
    expect(distributed[1].pieces[0].baseline.x).toBe(55);
    const snap = snapTextMove(getTextBoxes(model(), runs), ["0:1"], 44, -19);
    expect(snap.dx).toBe(45);
    expect(snap.dy).toBe(-20);
    expect(snap.guides).toHaveLength(2);
  });
});
