import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectEditableText } from "./text-edit";
import { exportPdf } from "./pdf";
import type { EditorPage } from "./pdf";
import {
  duplicateItems,
  rotateText,
  lockItems,
  readDocumentLocks,
  updateShape,
  reorderItems,
} from "./item-operations";
import { getTextBoxes, moveTextBoxes, joinTextBoxes } from "./text-boxes";
import { applyTextEdits } from "./document-editing";
async function fixture() {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([400, 500]);
  p.drawText("seed", { font });
  const key = p.node
    .Resources()!
    .lookup(PDFName.of("Font"))!
    .toString()
    .match(/\/(Helvetica-[^ ]+)/)![1];
  p.node.set(
    PDFName.of("Contents"),
    doc.context.register(
      doc.context.flateStream(
        `q .2 .4 .6 rg .9 .1 -.05 1 12 8 cm BT /${key} 18 Tf .5 Tc 85 Tz 3 Ts 1 0 0 1 30 350 Tm [(Al) -60 (pha)] TJ (Beta) Tj 20 TL T* (Next line) Tj ET Q`,
      ),
    ),
  );
  return doc.save();
}
const model = (): EditorPage => ({
  id: "p",
  sourceId: "s",
  index: 0,
  annotations: [],
});
const save = (bytes: Uint8Array, page: EditorPage) =>
  exportPdf([{ id: "s", name: "fixture.pdf", bytes }], [page]);
async function pixels(bytes: Uint8Array) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl: fileURLToPath(
      new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
    ).replaceAll("\\", "/"),
  });
  try {
    const page = await (await task.promise).getPage(1),
      viewport = page.getViewport({ scale: 1.5 }),
      canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    return createHash("sha256")
      .update(
        canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
          .data,
      )
      .digest("hex");
  } finally {
    await task.destroy();
  }
}
describe("item niceties", () => {
  it("rotates native text with its original font, while preserving the following line matrix", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0),
      p = rotateText(model(), runs, [runs[0].id], 90),
      saved = await save(bytes, p),
      actual = await inspectEditableText(saved, 0);
    expect(actual.map((r) => r.text)).toEqual(runs.map((r) => r.text));
    expect(actual[1].geometry!.baseline.x).toBeCloseTo(
      runs[1].geometry!.baseline.x,
      6,
    );
    expect(actual[2].geometry!.baseline.y).toBeCloseTo(
      runs[2].geometry!.baseline.y,
      6,
    );
    const expected = getTextBoxes(p, runs)[0];
    actual[0].geometry!.quad.forEach((point, i) => {
      expect(point.x).toBeCloseTo(expected.pieces[0].quad[i].x, 6);
      expect(point.y).toBeCloseTo(expected.pieces[0].quad[i].y, 6);
    });
  });
  it("a full rotation preserves every rendered pixel", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0);
    expect(
      await pixels(
        await save(bytes, rotateText(model(), runs, [runs[0].id], 360)),
      ),
    ).toBe(await pixels(bytes));
  });
  it("copies native text without substituting its font or shifting neighbours, and edits the copy independently", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0);
    let n = 0;
    const copy = duplicateItems(
        model(),
        runs,
        [runs[0].id],
        [],
        () => `new${n++}`,
      ),
      saved = await save(bytes, copy.page),
      actual = await inspectEditableText(saved, 0);
    expect(actual.map((r) => r.text)).toEqual([
      "Alpha",
      "Alpha",
      "Beta",
      "Next line",
    ]);
    expect(
      actual[1].geometry!.baseline.x - runs[0].geometry!.baseline.x,
    ).toBeCloseTo(12, 6);
    expect(
      actual[1].geometry!.baseline.y - runs[0].geometry!.baseline.y,
    ).toBeCloseTo(-12, 6);
    expect(actual[2].geometry!.baseline.x).toBeCloseTo(
      runs[1].geometry!.baseline.x,
      6,
    );
    expect(actual[3].geometry!.baseline.y).toBeCloseTo(
      runs[2].geometry!.baseline.y,
      6,
    );
    const next = applyTextEdits(copy.page, [
      { runId: copy.runIds[0], original: "Alpha", replacement: "Alp" },
    ]);
    expect(
      (await inspectEditableText(await save(bytes, next), 0)).map(
        (r) => r.text,
      ),
    ).toEqual(["Alpha", "Alp", "Beta", "Next line"]);
  });
  it("enforces native locks for movement, joining and replacement, and retains locks through export", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0),
      p = lockItems(model(), runs, [runs[0].id], [], true);
    expect(() => moveTextBoxes(p, runs, [runs[0].id], 1, 2)).toThrow("Unlock");
    expect(() =>
      joinTextBoxes(p, runs, [runs[0].id, runs[1].id], "joined"),
    ).toThrow("Unlock");
    expect(() =>
      applyTextEdits(p, [
        { runId: runs[0].id, original: "Alpha", replacement: "A" },
      ]),
    ).toThrow("Unlock");
    expect((await readDocumentLocks(await save(bytes, p)))[0]).toHaveLength(1);
  });
  it("duplicates rectangle styles independently and respects locks and layer order", () => {
    const p = model();
    p.annotations = [
      {
        id: "a",
        kind: "rectangle",
        x: 20,
        y: 30,
        width: 50,
        height: 70,
        color: "#123456",
        fill: "#ffffff",
        borderWidth: 3,
      },
      {
        id: "b",
        kind: "text",
        text: "Top",
        x: 20,
        y: 30,
        size: 12,
        color: "#000000",
      },
    ];
    const dup = duplicateItems(p, [], [], ["a"], () => "copy");
    expect(dup.page.annotations[2]).toMatchObject({
      id: "copy",
      fill: "#ffffff",
      borderWidth: 3,
      x: 32,
      y: 18,
    });
    expect(p.annotations).toHaveLength(2);
    expect(
      reorderItems(p, [], ["a"], true).annotations.map((a) => a.id),
    ).toEqual(["b", "a"]);
    expect(
      reorderItems(dup.page, [], ["a"], true, true).annotations.map(
        (a) => a.id,
      ),
    ).toEqual(["b", "a", "copy"]);
    expect(
      reorderItems(dup.page, [], ["copy"], false, true).annotations.map(
        (a) => a.id,
      ),
    ).toEqual(["a", "copy", "b"]);
    const locked = {
      ...p,
      annotations: p.annotations.map((a) => ({ ...a, locked: true })),
    };
    expect(() => updateShape(locked, "a", { width: 90 })).toThrow("Unlock");
    expect(updateShape(p, "a", { width: 90 }).annotations[0]).toMatchObject({
      width: 90,
    });
  });
  it("duplicates joined paragraphs with their independent continuous-text recipe", () => {
    const p = model();
    p.annotations = [
      {
        id: "line1",
        kind: "text",
        text: "One",
        x: 20,
        y: 100,
        size: 12,
        color: "#000000",
      },
      {
        id: "line2",
        kind: "text",
        text: "Two",
        x: 20,
        y: 84,
        size: 12,
        color: "#000000",
      },
    ];
    p.textGroups = [{ id: "joined:p", runIds: ["added:line1", "added:line2"] }];
    p.paragraphs = [
      {
        groupId: "joined:p",
        text: "One Two",
        x: 20,
        y: 100,
        width: 80,
        font: "Helvetica",
        size: 12,
        color: "#000000",
        lineHeight: 1.3,
        align: "left",
      },
    ];
    let n = 0;
    const duplicate = duplicateItems(p, [], ["joined:p"], [], () =>
      String(n++),
    );
    expect(duplicate.page.paragraphs).toHaveLength(2);
    expect(duplicate.page.paragraphs![1]).toMatchObject({
      text: "One Two",
      x: 32,
      y: 88,
      groupId: duplicate.page.textGroups![1].id,
    });
    expect(duplicate.page.paragraphs![1]).not.toBe(p.paragraphs[0]);
  });
});
