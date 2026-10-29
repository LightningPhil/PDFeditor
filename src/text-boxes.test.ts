import { describe, expect, it } from "vitest";
import type { EditorPage } from "./pdf";
import type { EditableRun } from "./text-edit";
import {
  assertTextGroups,
  getAllTextRuns,
  getTextBoxes,
  joinTextBoxes,
  moveTextBoxes,
  ungroupTextBoxes,
} from "./text-boxes";

const page = (): EditorPage => ({
  id: "page",
  sourceId: "source",
  index: 0,
  annotations: [],
});
const run = (id: string, x = 0, y = 100): EditableRun => ({
  id,
  text: id,
  font: "Helvetica",
  characters: "abc",
  geometry: {
    baseline: { x, y },
    quad: [
      { x, y: y - 2 },
      { x: x + 8, y: y - 2 },
      { x: x + 8, y: y + 8 },
      { x, y: y + 8 },
    ],
  },
});
describe("join invariants", () => {
  it("rejects an overflowing mixed-group movement atomically", () => {
    const runs = [run("0:1")];
    const source = {
      ...page(),
      annotations: [
        {
          id: "note",
          kind: "text" as const,
          text: "Note",
          x: 9e307,
          y: 100,
          size: 12,
          color: "#297768",
        },
      ],
    };
    const joined = joinTextBoxes(source, runs, ["0:1", "added:note"], "group");
    const snapshot = JSON.stringify(joined);
    expect(() => moveTextBoxes(joined, runs, ["group"], 9e307, 0)).toThrow(
      "out of range",
    );
    expect(JSON.stringify(joined)).toBe(snapshot);
  });
  it("retains source ordering when merging an interleaved group with its neighbour", () => {
    const runs = ["0:1", "0:2", "0:3", "0:4"].map((id, i) => run(id, i * 10));
    const first = joinTextBoxes(page(), runs, ["0:1", "0:3"], "first");
    const next = joinTextBoxes(first, runs, ["first", "0:2"], "next");
    expect(next.textGroups).toEqual([
      { id: "next", runIds: ["0:1", "0:2", "0:3"] },
    ]);
  });
  it("rejects stale selections and colliding or reserved group identifiers", () => {
    const runs = ["0:1", "0:2", "0:3"].map((id) => run(id));
    expect(() =>
      joinTextBoxes(page(), runs, ["0:1", "0:2", "missing"], "g"),
    ).toThrow();
    expect(() => joinTextBoxes(page(), runs, ["0:1", "0:2"], "0:3")).toThrow();
    expect(() =>
      joinTextBoxes(page(), runs, ["0:1", "0:2"], "added:note"),
    ).toThrow();
    expect(() => joinTextBoxes(page(), runs, ["0:1", "0:2"], "")).toThrow();
  });
  it("never exposes the same piece in two boxes or moves it twice after malformed grouping", () => {
    const runs = ["0:1", "0:2", "0:3"].map((id) => run(id));
    const malformed = {
      ...page(),
      textGroups: [
        { id: "a", runIds: ["0:1", "0:2", "0:1"] },
        { id: "b", runIds: ["0:2", "0:3"] },
      ],
    };
    const boxes = getTextBoxes(malformed, runs);
    const ids = boxes.flatMap((box) => box.runs.map((run) => run.id));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const moved = moveTextBoxes(
      malformed,
      runs,
      boxes.map((box) => box.id),
      1,
      2,
    );
    expect(moved.textOffsets?.map((offset) => [offset.dx, offset.dy])).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
  });
  it("handles very large groups without argument-spread limits or dropped pieces", () => {
    const runs = Array.from({ length: 20000 }, (_, i) => run(`0:${i}`, i));
    const joined = joinTextBoxes(
      page(),
      runs,
      runs.map((run) => run.id),
      "large",
    );
    expect(getTextBoxes(joined, runs)[0].runs).toHaveLength(runs.length);
  });
  it("maintains ownership and immutability through 1000 deterministic random join/move/split operations", () => {
    let seed = 0x73471;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const runs = Array.from({ length: 24 }, (_, i) => run(`0:${i}`, i * 10));
    let state = page();
    state.annotations = [
      {
        id: "one",
        kind: "text",
        text: "Added",
        x: 5,
        y: 80,
        size: 14,
        color: "#297768",
      },
      {
        id: "two",
        kind: "text",
        text: "More",
        x: 60,
        y: 80,
        size: 16,
        color: "#775522",
      },
    ];
    const positions = (value: EditorPage) =>
      JSON.stringify(
        getTextBoxes(value, runs)
          .flatMap((box) => box.pieces)
          .sort((a, b) => a.runId.localeCompare(b.runId)),
      );
    for (let index = 0; index < 1000; index++) {
      const before = state,
        snapshot = JSON.stringify(before),
        boxes = getTextBoxes(before, runs),
        operation = Math.floor(random() * 3);
      if (operation === 0 && boxes.length > 1) {
        const shuffled = [...boxes];
        for (let n = shuffled.length - 1; n > 0; n--) {
          const other = Math.floor(random() * (n + 1));
          [shuffled[n], shuffled[other]] = [shuffled[other], shuffled[n]];
        }
        const chosen = shuffled
          .slice(0, 2 + Math.floor(random() * Math.min(4, boxes.length - 1)))
          .map((box) => box.id);
        state = joinTextBoxes(before, runs, chosen, `group:${index}`);
        expect(positions(state)).toBe(positions(before));
        expect(state.annotations).toBe(before.annotations);
        expect(state.textOffsets).toBe(before.textOffsets);
      } else if (operation === 1 && boxes.some((box) => box.joined)) {
        state = ungroupTextBoxes(before, [boxes.find((box) => box.joined)!.id]);
        expect(positions(state)).toBe(positions(before));
      } else {
        const selected = boxes[Math.floor(random() * boxes.length)];
        state = moveTextBoxes(
          before,
          runs,
          [selected.id],
          Math.floor(random() * 9) - 4,
          Math.floor(random() * 9) - 4,
        );
      }
      expect(JSON.stringify(before)).toBe(snapshot);
      const pieces = getTextBoxes(state, runs).flatMap((box) =>
        box.runs.map((run) => run.id),
      );
      expect(pieces.length).toBe(26);
      expect(new Set(pieces).size).toBe(26);
      expect(() =>
        assertTextGroups(
          state.textGroups ?? [],
          getAllTextRuns(state, runs).map((run) => run.id),
        ),
      ).not.toThrow();
    }
  });
});
