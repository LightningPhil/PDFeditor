import type { EditorPage } from "./pdf";
import type { EditableRun, TextOffset } from "./text-edit";
import type { Point } from "./geometry";
import { Encodings, Font, FontNames } from "@pdf-lib/standard-fonts";

export interface TextGroup {
  id: string;
  runIds: string[];
}
export interface TextBox {
  id: string;
  runs: EditableRun[];
  points: Point[];
  joined: boolean;
}

/** Joining is a structural operation. Never concatenate or re-typeset PDF glyphs. */
export function getTextBoxes(page: EditorPage, runs: EditableRun[]): TextBox[] {
  const metrics = Font.load(FontNames.Helvetica);
  const added: EditableRun[] = page.annotations.flatMap((annotation) => {
    if (annotation.kind !== "text") return [];
    const width = Array.from(annotation.text).reduce((total, character) => {
      const code = character.codePointAt(0)!;
      return (
        total +
        ((Encodings.WinAnsi.canEncodeUnicodeCodePoint(code)
          ? (metrics.getWidthOfGlyph(
              Encodings.WinAnsi.encodeUnicodeCodePoint(code).name,
            ) ?? 500)
          : 500) *
          annotation.size) /
          1000
      );
    }, 0);
    return [
      {
        id: `added:${annotation.id}`,
        text: annotation.text,
        font: "Helvetica",
        characters: Encodings.WinAnsi.supportedCodePoints
          .map((code) => String.fromCodePoint(code))
          .join(""),
        geometry: {
          baseline: { x: annotation.x, y: annotation.y },
          quad: [
            { x: annotation.x, y: annotation.y - annotation.size * 0.2 },
            {
              x: annotation.x + width,
              y: annotation.y - annotation.size * 0.2,
            },
            {
              x: annotation.x + width,
              y: annotation.y + annotation.size * 0.8,
            },
            { x: annotation.x, y: annotation.y + annotation.size * 0.8 },
          ],
        },
      },
    ];
  });
  runs = [...runs, ...added];
  const byId = new Map(runs.map((run) => [run.id, run]));
  const grouped = new Set<string>();
  const result: TextBox[] = [];
  const makeBox = (id: string, members: EditableRun[], joined = false) => ({
    id,
    joined,
    runs: members,
    points: members.flatMap((run) => {
      const offset = page.textOffsets?.find(
        (offset) => offset.runId === run.id,
      );
      return (run.geometry?.quad ?? []).map((point) => ({
        x: point.x + (offset?.dx ?? 0),
        y: point.y + (offset?.dy ?? 0),
      }));
    }),
  });
  for (const group of page.textGroups ?? []) {
    const members = group.runIds
      .map((id) => byId.get(id))
      .filter((run): run is EditableRun => !!run);
    if (!members.length) continue;
    members.forEach((run) => grouped.add(run.id));
    result.push(makeBox(group.id, members, true));
  }
  for (const run of runs)
    if (!grouped.has(run.id)) result.push(makeBox(run.id, [run]));
  const order = new Map(runs.map((run, index) => [run.id, index]));
  return result.sort(
    (a, b) =>
      Math.min(...a.runs.map((run) => order.get(run.id)!)) -
      Math.min(...b.runs.map((run) => order.get(run.id)!)),
  );
}

export function joinTextBoxes(
  page: EditorPage,
  runs: EditableRun[],
  selected: string[],
  id: string,
): EditorPage {
  const boxes = getTextBoxes(page, runs).filter((box) =>
    selected.includes(box.id),
  );
  if (boxes.length < 2)
    throw new Error("Select at least two text boxes to join.");
  if (boxes.some((box) => box.runs.some((run) => !run.geometry)))
    throw new Error(
      "All selected text must have a supported position before joining.",
    );
  const members = new Set(
    boxes.flatMap((box) => box.runs.map((run) => run.id)),
  );
  const ordered = getTextBoxes(page, runs)
    .flatMap((box) => box.runs)
    .filter((run) => members.has(run.id))
    .map((run) => run.id);
  return {
    ...page,
    textGroups: [
      ...(page.textGroups ?? []).filter(
        (group) => !selected.includes(group.id),
      ),
      { id, runIds: [...new Set(ordered)] },
    ],
  };
}

export function ungroupTextBoxes(
  page: EditorPage,
  selected: string[],
): EditorPage {
  return {
    ...page,
    textGroups: (page.textGroups ?? []).filter(
      (group) => !selected.includes(group.id),
    ),
  };
}

export function moveTextBoxes(
  page: EditorPage,
  runs: EditableRun[],
  selected: string[],
  dx: number,
  dy: number,
): EditorPage {
  if (![dx, dy].every(Number.isFinite))
    throw new Error("Text position must be finite.");
  const members = getTextBoxes(page, runs)
    .filter((box) => selected.includes(box.id))
    .flatMap((box) => box.runs);
  if (!members.length || members.some((run) => !run.geometry))
    throw new Error("Select movable text first.");
  const offsets = new Map(
    (page.textOffsets ?? []).map((offset) => [offset.runId, offset]),
  );
  for (const run of members) {
    if (run.id.startsWith("added:")) continue;
    const previous = offsets.get(run.id);
    const offset: TextOffset = {
      runId: run.id,
      original: run.text,
      dx: (previous?.dx ?? 0) + dx,
      dy: (previous?.dy ?? 0) + dy,
    };
    if (Math.abs(offset.dx) < 1e-8 && Math.abs(offset.dy) < 1e-8)
      offsets.delete(run.id);
    else offsets.set(run.id, offset);
  }
  const addedIds = new Set(
    members
      .filter((run) => run.id.startsWith("added:"))
      .map((run) => run.id.slice(6)),
  );
  return {
    ...page,
    textOffsets: [...offsets.values()],
    annotations: page.annotations.map((annotation) =>
      annotation.kind === "text" && addedIds.has(annotation.id)
        ? { ...annotation, x: annotation.x + dx, y: annotation.y + dy }
        : annotation,
    ),
  };
}
