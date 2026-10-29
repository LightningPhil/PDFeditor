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
  movable: boolean;
  text: string;
  pieces: { runId: string; quad: Point[]; baseline: Point }[];
}
const metrics = Font.load(FontNames.Helvetica);
const annotationCharacters = Encodings.WinAnsi.supportedCodePoints
  .map((code) => String.fromCodePoint(code))
  .join("");
export function isGroupId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    !!id.trim() &&
    id.length <= 512 &&
    !/^\d+:\d+$/.test(id) &&
    !id.startsWith("added:")
  );
}
export function hasTextGeometry(run: EditableRun): boolean {
  return (
    !!run.geometry &&
    run.geometry.quad.length === 4 &&
    [run.geometry.baseline, ...run.geometry.quad].every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    )
  );
}
/** Every piece has exactly one owner. Reject a damaged group as a whole. */
export function normalizeTextGroups(
  groups: TextGroup[],
  ids: string[],
): TextGroup[] {
  const available = new Set(ids),
    claimed = new Set<string>(),
    groupIds = new Set<string>(),
    order = new Map(ids.map((id, index) => [id, index]));
  const result: TextGroup[] = [];
  for (const group of groups) {
    if (
      !group ||
      !isGroupId(group.id) ||
      groupIds.has(group.id) ||
      !Array.isArray(group.runIds)
    )
      continue;
    const members = [...new Set(group.runIds)];
    if (
      !members.length ||
      members.some((id) => !available.has(id) || claimed.has(id))
    )
      continue;
    members.sort((a, b) => order.get(a)! - order.get(b)!);
    members.forEach((id) => claimed.add(id));
    groupIds.add(group.id);
    result.push({ id: group.id, runIds: members });
  }
  return result;
}
export function assertTextGroups(
  groups: TextGroup[],
  ids: string[],
): TextGroup[] {
  const normalized = normalizeTextGroups(groups, ids),
    byId = new Map(normalized.map((group) => [group.id, group]));
  if (
    normalized.length !== groups.length ||
    groups.some(
      (group) => byId.get(group.id)?.runIds.length !== group.runIds.length,
    )
  )
    throw new Error(
      "A joined text box has stale or overlapping pieces. Ungroup it before exporting.",
    );
  return normalized;
}

/** Joining is a structural operation. Never concatenate or re-typeset PDF glyphs. */
export function getAllTextRuns(
  page: EditorPage,
  runs: EditableRun[],
): EditableRun[] {
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
        characters: annotationCharacters,
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
  return [...new Map([...runs, ...added].map((run) => [run.id, run])).values()];
}
export function getTextBoxes(page: EditorPage, runs: EditableRun[]): TextBox[] {
  runs = getAllTextRuns(page, runs);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const grouped = new Set<string>();
  const result: TextBox[] = [];
  const offsets = new Map(
    (page.textOffsets ?? []).map((offset) => [offset.runId, offset]),
  );
  const replacements = new Map(
    (page.textReplacements ?? []).map((edit) => [edit.runId, edit.replacement]),
  );
  const makeBox = (id: string, members: EditableRun[], joined = false) => {
    const pieces = members.flatMap((run) => {
      if (!hasTextGeometry(run)) return [];
      const offset = offsets.get(run.id),
        dx = offset?.dx ?? 0,
        dy = offset?.dy ?? 0;
      if (![dx, dy].every(Number.isFinite)) return [];
      const shift = (point: Point) => ({ x: point.x + dx, y: point.y + dy });
      return [
        {
          runId: run.id,
          quad: run.geometry!.quad.map(shift),
          baseline: shift(run.geometry!.baseline),
        },
      ];
    });
    return {
      id,
      joined,
      runs: members,
      movable: pieces.length === members.length,
      text: members.map((run) => replacements.get(run.id) ?? run.text).join(""),
      pieces,
      points: pieces.flatMap((piece) => piece.quad),
    };
  };
  for (const group of normalizeTextGroups(
    page.textGroups ?? [],
    runs.map((run) => run.id),
  )) {
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
      a.runs.reduce((min, run) => Math.min(min, order.get(run.id)!), Infinity) -
      b.runs.reduce((min, run) => Math.min(min, order.get(run.id)!), Infinity),
  );
}
function selectedBoxes(
  page: EditorPage,
  runs: EditableRun[],
  selected: string[],
) {
  const wanted = new Set(selected),
    boxes = getTextBoxes(page, runs).filter((box) => wanted.has(box.id));
  if (wanted.size !== boxes.length)
    throw new Error("The text selection changed. Select the boxes again.");
  return boxes;
}

export function joinTextBoxes(
  page: EditorPage,
  runs: EditableRun[],
  selected: string[],
  id: string,
): EditorPage {
  const boxes = selectedBoxes(page, runs, selected);
  if (boxes.length < 2)
    throw new Error("Select at least two text boxes to join.");
  if (boxes.some((box) => !box.movable))
    throw new Error(
      "All selected text must have a supported position before joining.",
    );
  const members = new Set(
    boxes.flatMap((box) => box.runs.map((run) => run.id)),
  );
  const all = getAllTextRuns(page, runs);
  const normalized = normalizeTextGroups(
    page.textGroups ?? [],
    all.map((run) => run.id),
  );
  if (
    !isGroupId(id) ||
    all.some((run) => run.id === id) ||
    normalized.some((group) => group.id === id && !selected.includes(id))
  )
    throw new Error("Choose a unique text box identifier.");
  const ordered = all.filter((run) => members.has(run.id)).map((run) => run.id);
  return {
    ...page,
    textGroups: [
      ...normalized.filter((group) => !selected.includes(group.id)),
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
  const members = [
    ...new Map(
      selectedBoxes(page, runs, selected)
        .flatMap((box) => box.runs)
        .map((run) => [run.id, run]),
    ).values(),
  ];
  if (!members.length || members.some((run) => !hasTextGeometry(run)))
    throw new Error("Select movable text first.");
  if (dx === 0 && dy === 0) return page;
  const offsets = new Map(
    (page.textOffsets ?? []).map((offset) => [offset.runId, offset]),
  );
  for (const run of members) {
    if (run.id.startsWith("added:")) continue;
    const previous = offsets.get(run.id);
    if (
      previous &&
      (previous.original !== run.text ||
        ![previous.dx, previous.dy].every(Number.isFinite))
    )
      throw new Error(
        "This text has a stale position. Undo the move or reopen the PDF.",
      );
    const offset: TextOffset = {
      runId: run.id,
      original: run.text,
      dx: (previous?.dx ?? 0) + dx,
      dy: (previous?.dy ?? 0) + dy,
    };
    if (![offset.dx, offset.dy].every(Number.isFinite))
      throw new Error("Text movement is out of range.");
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
