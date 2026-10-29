import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { EditorPage } from "./pdf";
import { exportPdf } from "./pdf";
import { inspectEditableText } from "./text-edit";
import type { EditableRun } from "./text-edit";
import { bounds, transform } from "./geometry";
import type { Matrix } from "./geometry";
import {
  getTextBoxes,
  joinTextBoxes,
  moveTextBoxes,
  ungroupTextBoxes,
} from "./text-boxes";
import {
  alignToReferences,
  planReferenceAlignment,
} from "./reference-alignment";
import type { ReferenceAlignmentOptions } from "./reference-alignment";
const page = (): EditorPage => ({
  id: "p",
  sourceId: "s",
  index: 0,
  annotations: [],
});
const run = (id: string, x: number, y: number, width = 30): EditableRun => ({
  id,
  text: id,
  font: "Helvetica",
  characters: "abc",
  geometry: {
    baseline: { x, y },
    quad: [
      { x, y: y - 2 },
      { x: x + width, y: y - 2 },
      { x: x + width, y: y + 8 },
      { x, y: y + 8 },
    ],
  },
});
const view: Matrix = [1, 0, 0, -1, 0, 500];
const runs = [
  run("0:1", 10, 300),
  run("0:2", 100, 350, 50),
  run("0:3", 180, 350, 40),
  run("0:4", 50, 280, 20),
];
const refs = { runIds: ["0:2", "0:3"], shapeIds: [] };
const area = (p: EditorPage, id: string, matrix = view) =>
  bounds(
    getTextBoxes(p, runs)
      .find((b) => b.id === id)!
      .points.map((point) => transform(matrix, point)),
  );
describe("reference alignment", () => {
  it("aligns text to multiple fixed references with independent offsets on both axes", () => {
    const original = page(),
      snapshot = JSON.stringify(original);
    const next = alignToReferences(original, runs, ["0:1"], refs, view, {
      asBlock: true,
      x: { moving: "center", reference: "center", offset: 5 },
      y: { moving: "baseline", reference: "baseline", offset: 2 },
    });
    expect(next.textOffsets).toEqual([
      { runId: "0:1", original: "0:1", dx: 140, dy: 48 },
    ]);
    expect(
      getTextBoxes(next, runs).find((b) => b.id === "0:2")!.pieces,
    ).toEqual(getTextBoxes(original, runs).find((b) => b.id === "0:2")!.pieces);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  it("preserves internal spacing when moving a selection as a block, or aligns each box independently", () => {
    const options: ReferenceAlignmentOptions = {
      asBlock: true,
      x: { moving: "min", reference: "min", offset: 0 },
    };
    const block = alignToReferences(
      page(),
      runs,
      ["0:1", "0:4"],
      refs,
      view,
      options,
    );
    expect(block.textOffsets?.map((o) => o.dx)).toEqual([90, 90]);
    const individual = alignToReferences(
      page(),
      runs,
      ["0:1", "0:4"],
      refs,
      view,
      { ...options, asBlock: false },
    );
    expect(individual.textOffsets?.map((o) => o.dx)).toEqual([90, 50]);
    expect(area(block, "0:4").x - area(block, "0:1").x).toBe(40);
  });
  it("places text outside a rectangle using an exact visual gap, without moving the rectangle", () => {
    const original = {
      ...page(),
      annotations: [
        {
          id: "rect",
          kind: "rectangle" as const,
          x: 250,
          y: 200,
          width: 40,
          height: 50,
          color: "#000000",
        },
      ],
    };
    for (const [moving, reference, offset, expected] of [
      ["max", "min", -8, 242],
      ["min", "max", 8, 298],
    ] as const) {
      const next = alignToReferences(
        original,
        runs,
        ["0:1"],
        { runIds: [], shapeIds: ["rect"] },
        view,
        { asBlock: true, x: { moving, reference, offset } },
      );
      const a = area(next, "0:1");
      expect(moving === "max" ? a.x + a.width : a.x).toBe(expected);
      expect(next.annotations).toEqual(original.annotations);
    }
    const below = alignToReferences(
      original,
      runs,
      ["0:1"],
      { runIds: [], shapeIds: ["rect"] },
      view,
      { asBlock: true, y: { moving: "min", reference: "max", offset: 12 } },
    );
    expect(area(below, "0:1").y).toBe(312);
  });
  it("uses the combined bounds of text and rectangle references", () => {
    const original = {
      ...page(),
      annotations: [
        {
          id: "rect",
          kind: "rectangle" as const,
          x: 250,
          y: 200,
          width: 40,
          height: 50,
          color: "#000000",
        },
      ],
    };
    const plan = planReferenceAlignment(
      original,
      runs,
      ["0:1"],
      { runIds: ["0:2"], shapeIds: ["rect"] },
      view,
      {
        asBlock: true,
        x: { moving: "center", reference: "center", offset: 0 },
      },
    );
    expect(plan.reference).toMatchObject({
      x: 100,
      y: 142,
      width: 190,
      height: 158,
    });
    expect(plan.moves[0].dx).toBe(170);
  });
  for (const matrix of [
    view,
    [0, 1, 1, 0, 0, 0],
    [-1, 0, 0, 1, 400, 0],
    [0, -1, -1, 0, 500, 400],
    [2, 0, 0, -2, -40, 900],
    [0.8, 0.1, 0.1, -1.2, 30, 500],
  ] as Matrix[])
    it(`honours visual edges with rotation, crop, scaling and skew (${matrix.join(",")})`, () => {
      const before = area(page(), "0:2", matrix);
      const next = alignToReferences(
        page(),
        runs,
        ["0:1"],
        { runIds: ["0:2"], shapeIds: [] },
        matrix,
        {
          asBlock: true,
          x: { moving: "max", reference: "min", offset: -7 },
          y: { moving: "min", reference: "max", offset: 11 },
        },
      );
      const after = area(next, "0:1", matrix);
      expect(after.x + after.width).toBeCloseTo(before.x - 7, 8);
      expect(after.y).toBeCloseTo(before.y + before.height + 11, 8);
      expect(
        alignToReferences(
          next,
          runs,
          ["0:1"],
          { runIds: ["0:2"], shapeIds: [] },
          matrix,
          {
            asBlock: true,
            x: { moving: "max", reference: "min", offset: -7 },
            y: { moving: "min", reference: "max", offset: 11 },
          },
        ),
      ).toBe(next);
    });
  it("keeps pinned piece anchors through joins, splits and prior movement", () => {
    let p = joinTextBoxes(page(), runs, ["0:2", "0:3"], "references");
    p = moveTextBoxes(p, runs, ["references"], 10, 20);
    p = ungroupTextBoxes(p, ["references"]);
    const next = alignToReferences(p, runs, ["0:1"], refs, view, {
      asBlock: true,
      x: { moving: "min", reference: "min", offset: 0 },
    });
    expect(area(next, "0:1").x).toBe(110);
    expect(
      next.textOffsets?.filter((o) => refs.runIds.includes(o.runId)),
    ).toEqual(p.textOffsets);
  });
  it("rejects target/reference overlap, stale references and partial selections without mutating state", () => {
    const original = joinTextBoxes(page(), runs, ["0:1", "0:2"], "mixed"),
      snapshot = JSON.stringify(original),
      options = {
        asBlock: true,
        x: { moving: "min", reference: "min", offset: 0 },
      } as ReferenceAlignmentOptions;
    expect(() =>
      alignToReferences(original, runs, ["mixed"], refs, view, options),
    ).toThrow("separate");
    expect(() =>
      alignToReferences(page(), runs, ["0:1", "missing"], refs, view, options),
    ).toThrow("Select");
    expect(() =>
      alignToReferences(
        page(),
        runs,
        ["0:1"],
        { runIds: ["0:2", "missing"], shapeIds: [] },
        view,
        options,
      ),
    ).toThrow("pinned");
    expect(() =>
      alignToReferences(
        page(),
        runs,
        ["0:1"],
        { runIds: [], shapeIds: ["missing"] },
        view,
        options,
      ),
    ).toThrow("pinned");
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  it("refuses ambiguous or angled baselines and invalid coordinates", () => {
    const options: ReferenceAlignmentOptions = {
      asBlock: true,
      y: { moving: "baseline", reference: "baseline", offset: 0 },
    };
    expect(() =>
      alignToReferences(
        page(),
        runs,
        ["0:1"],
        { runIds: ["0:2", "0:4"], shapeIds: [] },
        view,
        options,
      ),
    ).toThrow("one baseline");
    expect(() =>
      alignToReferences(
        page(),
        runs,
        ["0:1"],
        refs,
        [0, 1, 1, 0, 0, 0],
        options,
      ),
    ).toThrow("horizontal");
    expect(() =>
      alignToReferences(page(), runs, ["0:1"], refs, view, {
        asBlock: true,
        x: { moving: "min", reference: "min", offset: NaN },
      }),
    ).toThrow("finite");
    expect(() =>
      alignToReferences(
        page(),
        runs,
        ["0:1"],
        refs,
        [0, 0, 0, 0, 0, 0],
        options,
      ),
    ).toThrow("invertible");
  });
  it("exports native text at the aligned position while reference glyphs stay fixed", async () => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica),
      p = doc.addPage([400, 500]);
    p.drawText("Move", { font, x: 20, y: 300, size: 16 });
    p.drawText("Reference", { font, x: 180, y: 400, size: 16 });
    const bytes = await doc.save(),
      native = await inspectEditableText(bytes, 0);
    const next = alignToReferences(
      page(),
      native,
      [native[0].id],
      { runIds: [native[1].id], shapeIds: [] },
      view,
      {
        asBlock: true,
        x: { moving: "min", reference: "min", offset: 9 },
        y: { moving: "baseline", reference: "baseline", offset: 0 },
      },
    );
    const saved = await exportPdf(
        [{ id: "s", name: "alignment.pdf", bytes }],
        [next],
      ),
      actual = await inspectEditableText(saved, 0);
    expect(actual[0].geometry!.baseline).toEqual({ x: 189, y: 400 });
    expect(actual[1].geometry).toEqual(native[1].geometry);
    expect(actual.map((r) => r.text)).toEqual(["Move", "Reference"]);
  });
});
