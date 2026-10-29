import { bounds } from "./geometry";
import type { TextBox } from "./text-boxes";
import { getTextBoxes, moveTextBoxes } from "./text-boxes";
import type { EditableRun } from "./text-edit";
import type { EditorPage } from "./pdf";
export type Alignment =
  | "left"
  | "center"
  | "right"
  | "top"
  | "baseline"
  | "bottom"
  | "horizontal"
  | "vertical";
export function alignText(
  page: EditorPage,
  runs: EditableRun[],
  ids: string[],
  mode: Alignment,
): EditorPage {
  const boxes = getTextBoxes(page, runs).filter((b) => ids.includes(b.id));
  if (boxes.length < 2 || boxes.some((b) => !b.movable))
    throw new Error("Select at least two movable boxes.");
  const areas = boxes.map((box) => ({
    id: box.id,
    ...bounds(box.points),
    baseline: box.pieces[0].baseline.y,
  }));
  const all = bounds(boxes.flatMap((b) => b.points));
  let next = page;
  if (mode === "horizontal" || mode === "vertical") {
    if (areas.length < 3)
      throw new Error("Select at least three boxes to distribute.");
    const horizontal = mode === "horizontal",
      start = horizontal ? "x" : "y",
      size = horizontal ? "width" : "height";
    areas.sort((a, b) => a[start] - b[start]);
    const span = areas.at(-1)![start] + areas.at(-1)![size] - areas[0][start];
    const gap =
      (span - areas.reduce((sum, a) => sum + a[size], 0)) / (areas.length - 1);
    let cursor = areas[0][start];
    for (const a of areas) {
      next = moveTextBoxes(
        next,
        runs,
        [a.id],
        horizontal ? cursor - a.x : 0,
        horizontal ? 0 : cursor - a.y,
      );
      cursor += a[size] + gap;
    }
  } else
    for (const a of areas) {
      const dx =
        mode === "left"
          ? all.x - a.x
          : mode === "right"
            ? all.x + all.width - a.x - a.width
            : mode === "center"
              ? all.x + all.width / 2 - a.x - a.width / 2
              : 0;
      const dy =
        mode === "bottom"
          ? all.y - a.y
          : mode === "top"
            ? all.y + all.height - a.y - a.height
            : mode === "baseline"
              ? areas[0].baseline - a.baseline
              : 0;
      next = moveTextBoxes(next, runs, [a.id], dx, dy);
    }
  return next;
}
export interface MoveGuide {
  axis: "x" | "y";
  value: number;
}
export function snapTextMove(
  boxes: TextBox[],
  ids: string[],
  dx: number,
  dy: number,
  tolerance = 4,
): { dx: number; dy: number; guides: MoveGuide[] } {
  const selected = new Set(ids),
    moving = boxes.filter((b) => selected.has(b.id));
  if (!moving.length) return { dx, dy, guides: [] };
  const area = bounds(moving.flatMap((b) => b.points));
  const x = [
      area.x + dx,
      area.x + area.width / 2 + dx,
      area.x + area.width + dx,
    ],
    y = [
      area.y + dy,
      area.y + area.height / 2 + dy,
      area.y + area.height + dy,
      ...moving.flatMap((b) => b.pieces.map((p) => p.baseline.y + dy)),
    ];
  let bestX = tolerance + 1,
    bestY = tolerance + 1,
    correctionX = 0,
    correctionY = 0;
  const guides: MoveGuide[] = [];
  let guideX: number | undefined, guideY: number | undefined;
  for (const box of boxes) {
    if (selected.has(box.id) || !box.movable) continue;
    const b = bounds(box.points);
    for (const target of [b.x, b.x + b.width / 2, b.x + b.width])
      for (const source of x)
        if (Math.abs(target - source) < bestX) {
          bestX = Math.abs(target - source);
          correctionX = target - source;
          guideX = target;
        }
    for (const target of [
      b.y,
      b.y + b.height / 2,
      b.y + b.height,
      ...box.pieces.map((p) => p.baseline.y),
    ])
      for (const source of y)
        if (Math.abs(target - source) < bestY) {
          bestY = Math.abs(target - source);
          correctionY = target - source;
          guideY = target;
        }
  }
  if (bestX <= tolerance && guideX !== undefined) {
    dx += correctionX;
    guides.push({ axis: "x", value: guideX });
  }
  if (bestY <= tolerance && guideY !== undefined) {
    dy += correctionY;
    guides.push({ axis: "y", value: guideY });
  }
  return { dx, dy, guides };
}
