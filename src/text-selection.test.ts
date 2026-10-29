import { describe, expect, it } from "vitest";
import { identity, transform } from "./geometry";
import type { Matrix } from "./geometry";
import type { EditableRun } from "./text-edit";
import type { EditorPage } from "./pdf";
import { getTextBoxes, joinTextBoxes } from "./text-boxes";
import {
  boxesInRectangle,
  neighbouringLine,
  pointInPolygon,
  selectedTextBoxIds,
  textMembersForBoxes,
} from "./text-selection";

const page: EditorPage = { id: "p", sourceId: "s", index: 0, annotations: [] };
function run(
  id: string,
  x: number,
  y: number,
  width = 10,
  height = 10,
): EditableRun {
  return {
    id,
    text: id,
    font: "Helvetica",
    characters: "abc",
    geometry: {
      baseline: { x, y },
      quad: [
        { x, y: y - height * 0.2 },
        { x: x + width, y: y - height * 0.2 },
        { x: x + width, y: y + height * 0.8 },
        { x, y: y + height * 0.8 },
      ],
    },
  };
}
describe("precise text selection", () => {
  it("preserves selection across join, split and history traversal", () => {
    const runs = [
      run("0:1", 10, 100),
      run("0:2", 24, 100),
      run("0:3", 40, 100),
    ];
    const original = getTextBoxes(page, runs);
    const members = textMembersForBoxes(original, ["0:1", "0:2"]);
    const joined = getTextBoxes(
      joinTextBoxes(page, runs, ["0:1", "0:2"], "joined:test"),
      runs,
    );
    expect(selectedTextBoxIds(joined, members)).toEqual(["joined:test"]);
    expect(selectedTextBoxIds(original, members)).toEqual(["0:1", "0:2"]);
    expect(textMembersForBoxes(joined, ["joined:test"])).toEqual(members);
    expect(selectedTextBoxIds(joined, members)).toEqual(["joined:test"]);
    expect(selectedTextBoxIds(original, ["missing"])).toEqual([]);
  });
  for (const matrix of [
    identity(),
    [0, 1, -1, 0, 300, 0],
    [1, 0.2, 0.1, 1, 0, 0],
  ] as Matrix[]) {
    it(`finds a connected line while excluding other lines and columns (${matrix.join(",")})`, () => {
      const runs = [
        run("0:1", 10, 100),
        run("0:2", 24, 100, 12, 12),
        run("0:3", 40, 104, 5, 5),
        run("0:4", 50, 100),
        run("0:5", 200, 100),
        run("0:6", 10, 82),
      ];
      const rotated = runs.map((run) => ({
        ...run,
        geometry: {
          quad: run.geometry!.quad.map((point) => transform(matrix, point)),
          baseline: transform(matrix, run.geometry!.baseline),
        },
      }));
      expect(neighbouringLine(getTextBoxes(page, rotated), "0:2")).toEqual([
        "0:1",
        "0:2",
        "0:3",
        "0:4",
      ]);
    });
  }
  it("does not select an unselected piece through the empty interior of a joined box", () => {
    const runs = [
      run("0:1", 0, 100),
      run("0:2", 50, 100),
      run("0:3", 100, 100),
    ];
    const joined = joinTextBoxes(page, runs, ["0:1", "0:3"], "wide");
    expect(
      boxesInRectangle(getTextBoxes(joined, runs), identity(), {
        x: 49,
        y: 97,
        width: 12,
        height: 12,
      }),
    ).toEqual(["0:2"]);
    expect(
      boxesInRectangle(getTextBoxes(joined, runs), identity(), {
        x: -1,
        y: 97,
        width: 12,
        height: 12,
      }),
    ).toEqual(["wide"]);
  });
  it("rejects a rotated bounding-box corner that does not touch the actual text quad", () => {
    const matrix: Matrix = [
      Math.SQRT1_2,
      Math.SQRT1_2,
      -Math.SQRT1_2,
      Math.SQRT1_2,
      100,
      0,
    ];
    const original = run("0:1", 0, 0, 20, 10),
      rotated = {
        ...original,
        geometry: {
          quad: original.geometry!.quad.map((point) =>
            transform(matrix, point),
          ),
          baseline: transform(matrix, original.geometry!.baseline),
        },
      };
    expect(
      boxesInRectangle(getTextBoxes(page, [rotated]), identity(), {
        x: 94,
        y: 17,
        width: 1,
        height: 1,
      }),
    ).toEqual([]);
  });
  it("does not mistake a deleted zero-width piece for an infinite hit target", () => {
    const quad = run("0:1", 10, 10, 0).geometry!.quad;
    expect(pointInPolygon({ x: 10, y: 1000 }, quad)).toBe(false);
    expect(pointInPolygon({ x: 10, y: 10 }, quad)).toBe(true);
  });
  it("never treats a multi-line joined box as one inferred line", () => {
    const runs = [run("0:1", 0, 100), run("0:2", 0, 80), run("0:3", 14, 100)];
    const joined = joinTextBoxes(page, runs, ["0:1", "0:2"], "paragraph");
    expect(neighbouringLine(getTextBoxes(joined, runs), "paragraph")).toEqual([
      "paragraph",
    ]);
  });
});
