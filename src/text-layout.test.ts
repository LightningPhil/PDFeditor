/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts, degrees } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "node:url";
import { exportPdf } from "./pdf";
import type { EditorPage } from "./pdf";
import { inspectEditableText } from "./text-edit";
import {
  getTextBoxes,
  joinTextBoxes,
  moveTextBoxes,
  ungroupTextBoxes,
} from "./text-boxes";
import { bounds } from "./geometry";
import { readDocumentTextGroups } from "./text-group-storage";

const fontUrl = fileURLToPath(
  new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
).replaceAll("\\", "/");
async function fixture(variant = "plain") {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 500]);
  const regular = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.CourierBold);
  page.drawText("seed", { font: regular });
  page.drawText("seed", { font: bold });
  const keys = page.node
    .Resources()!
    .lookup(PDFName.of("Font"))!
    .toString()
    .match(/\/(?:Helvetica|Courier-Bold)-[^ ]+/g)!;
  const first = keys.find((key) => key.startsWith("/Helvetica"))!,
    second = keys.find((key) => key.startsWith("/Courier"))!;
  const cm =
    variant === "transformed" ? "0.8 0.15 -0.1 1.1 25 15 cm" : "1 0 0 1 0 0 cm";
  const matrix =
    variant === "rotated" ? "0 1 -1 0 300 100" : "1 0.1 0.05 1 60 350";
  const content = `q ${cm} BT ${first} 20 Tf 85 Tz 3 Ts 0.5 Tc 2 Tw ${matrix} Tm [(Al) -70 (pha)] TJ ${second} 18 Tf (Beta) Tj 1 0 0 1 60 200 Tm 0 Ts 100 Tz 0 Tc 0 Tw ${first} 16 Tf (Unmoved) Tj ET Q`;
  page.node.set(
    PDFName.of("Contents"),
    doc.context.register(doc.context.flateStream(content)),
  );
  if (variant === "page-rotation") {
    page.setRotation(degrees(90));
    page.setCropBox(20, 30, 400, 430);
    page.node.set(PDFName.of("UserUnit"), doc.context.obj(2));
  }
  return doc.save();
}
const model = (): EditorPage => ({
  id: "page",
  sourceId: "source",
  index: 0,
  annotations: [],
});
async function exported(bytes: Uint8Array, page: EditorPage) {
  return exportPdf([{ id: "source", name: "fixture.pdf", bytes }], [page]);
}
async function inspect(bytes: Uint8Array) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl: fontUrl,
  });
  try {
    const page = await (await task.promise).getPage(1),
      view = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: view,
    }).promise;
    const items = (await page.getTextContent()).items.flatMap((item) =>
      "str" in item && item.str.trim() ? [item] : [],
    );
    return {
      hash: createHash("sha256")
        .update(
          canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data,
        )
        .digest("hex"),
      items,
    };
  } finally {
    await task.destroy();
  }
}

describe("joining and moving original text", () => {
  it("retains a joined box after export, reimport and another export, including mixed added text", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0),
      page = model();
    page.annotations = [
      {
        id: "note",
        kind: "text",
        text: "Note",
        size: 14,
        x: 175,
        y: 350,
        color: "#297768",
      },
    ];
    page.textReplacements = [
      { runId: runs[0].id, original: runs[0].text, replacement: "Gamma" },
    ];
    const joined = joinTextBoxes(
      page,
      runs,
      [runs[0].id, runs[1].id, "added:note"],
      "persisted",
    );
    const moved = moveTextBoxes(joined, runs, ["persisted"], 12, -8);
    const saved = await exported(bytes, moved),
      groups = await readDocumentTextGroups(saved);
    expect(groups[0]).toHaveLength(1);
    expect(groups[0][0].id).toBe("persisted");
    const imported = { ...model(), textGroups: groups[0] },
      importedRuns = await inspectEditableText(saved, 0);
    expect(
      getTextBoxes(imported, importedRuns)[0].runs.map((run) => run.text),
    ).toEqual(["Gamma", "Beta", "Note"]);
    expect((await inspect(await exported(saved, imported))).hash).toBe(
      (await inspect(saved)).hash,
    );
    const deleted = {
      ...moved,
      textReplacements: [
        { runId: runs[0].id, original: runs[0].text, replacement: "" },
      ],
    };
    const savedWithoutPart = await exported(bytes, deleted);
    expect(
      (await readDocumentTextGroups(savedWithoutPart))[0][0].runIds,
    ).toHaveLength(2);
  });
  it("joins edited and already-moved pieces without changing a single rendered pixel", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0);
    let page = model();
    page.textReplacements = [
      { runId: runs[0].id, original: runs[0].text, replacement: "Gamma" },
    ];
    page = moveTextBoxes(page, runs, [runs[0].id], 12, -5);
    const before = await exported(bytes, page);
    const joined = joinTextBoxes(
      page,
      runs,
      [runs[0].id, runs[1].id],
      "joined",
    );
    const after = await exported(bytes, joined);
    expect((await inspect(after)).hash).toEqual((await inspect(before)).hash);
    expect(joined.textOffsets).toEqual(page.textOffsets);
    expect(joined.textReplacements).toEqual(page.textReplacements);
    expect(getTextBoxes(joined, runs)[0].runs.map((run) => run.id)).toEqual([
      runs[0].id,
      runs[1].id,
    ]);
    const separated = ungroupTextBoxes(joined, ["joined"]);
    expect((await inspect(await exported(bytes, separated))).hash).toEqual(
      (await inspect(before)).hash,
    );
  });
  for (const variant of ["plain", "transformed", "rotated", "page-rotation"]) {
    it(`moves mixed-font pieces by the same page displacement and leaves their neighbour fixed (${variant})`, async () => {
      const bytes = await fixture(variant),
        runs = await inspectEditableText(bytes, 0);
      expect(runs.map((run) => run.text)).toEqual(["Alpha", "Beta", "Unmoved"]);
      const original = await inspect(bytes);
      const joined = joinTextBoxes(
        model(),
        runs,
        [runs[0].id, runs[1].id],
        "joined",
      );
      const moved = moveTextBoxes(joined, runs, ["joined"], 18, -11);
      const result = await exported(bytes, moved),
        after = await inspect(result);

      for (const text of ["Alpha", "Beta", "Unmoved"]) {
        const a = original.items.find((item) => item.str.trim() === text)!,
          b = after.items.find((item) => item.str.trim() === text)!;
        expect(a, `${text} original`).toBeDefined();
        expect(b, `${text} moved`).toBeDefined();
        expect(b.transform[4] - a.transform[4], text + " dx").toBeCloseTo(
          text === "Unmoved" ? 0 : 18,
          6,
        );
        expect(b.transform[5] - a.transform[5], text + " dy").toBeCloseTo(
          text === "Unmoved" ? 0 : -11,
          6,
        );
        expect(b.transform.slice(0, 4)).toEqual(a.transform.slice(0, 4));
        expect(b.fontName.replace(/g_d\d+/, "doc")).toBe(
          a.fontName.replace(/g_d\d+/, "doc"),
        );
      }
      const restored = moveTextBoxes(moved, runs, ["joined"], -18, 11);
      expect(restored.textOffsets).toEqual([]);
      expect((await inspect(await exported(bytes, restored))).hash).toEqual(
        original.hash,
      );
    });
  }
  it("can merge groups repeatedly and split them without losing offsets or membership", async () => {
    const runs = await inspectEditableText(await fixture(), 0);
    const first = joinTextBoxes(model(), runs, [runs[0].id, runs[1].id], "g1");
    const moved = moveTextBoxes(first, runs, ["g1"], 6, 8);
    const second = joinTextBoxes(moved, runs, ["g1", runs[2].id], "g2");
    expect(second.textGroups).toEqual([
      { id: "g2", runIds: runs.map((run) => run.id) },
    ]);
    const boxes = getTextBoxes(second, runs);
    expect(boxes).toHaveLength(1);
    expect(bounds(boxes[0].points).width).toBeGreaterThan(0);
    expect(ungroupTextBoxes(second, ["g2"]).textOffsets).toEqual(
      moved.textOffsets,
    );
    expect(first.textOffsets).toBeUndefined(); // Earlier undo snapshots are immutable.
  });
  it("joins newly added text with original text and moves both without flattening their styling", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0);
    const page = model();
    page.annotations = [
      {
        id: "note",
        kind: "text",
        text: "Note",
        size: 14,
        x: 175,
        y: 350,
        color: "#297768",
      },
    ];
    const joined = joinTextBoxes(
      page,
      runs,
      [runs[0].id, "added:note"],
      "mixed",
    );
    expect((await inspect(await exported(bytes, joined))).hash).toBe(
      (await inspect(await exported(bytes, page))).hash,
    );
    const moved = moveTextBoxes(joined, runs, ["mixed"], 10, 6);
    expect(moved.annotations[0]).toMatchObject({
      x: 185,
      y: 356,
      color: "#297768",
      size: 14,
    });
    expect(moved.textOffsets).toEqual([
      { runId: runs[0].id, original: "Alpha", dx: 10, dy: 6 },
    ]);
    expect(page.annotations[0]).toMatchObject({ x: 175, y: 350 });
    const before = await inspect(await exported(bytes, page)),
      after = await inspect(await exported(bytes, moved));
    for (const text of ["Alpha", "Note"]) {
      const a = before.items.find((item) => item.str.trim() === text)!,
        b = after.items.find((item) => item.str.trim() === text)!;
      expect(b.transform[4] - a.transform[4]).toBeCloseTo(10, 6);
      expect(b.transform[5] - a.transform[5]).toBeCloseTo(6, 6);
    }
  });
});
