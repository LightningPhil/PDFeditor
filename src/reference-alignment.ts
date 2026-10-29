import type { EditorPage } from "./pdf";
import type { EditableRun } from "./text-edit";
import { getTextBoxes, moveTextBoxes } from "./text-boxes";
import { bounds, inverseVector, transform } from "./geometry";
import type { Matrix, Point } from "./geometry";

/** Piece anchors survive joining, splitting and undo; shapes have stable IDs. */
export interface AlignmentReferences {
  runIds: string[];
  shapeIds: string[];
}
export const emptyReferences: AlignmentReferences = {
  runIds: [],
  shapeIds: [],
};
export type Anchor = "min" | "center" | "max" | "baseline";
export interface AxisAlignment {
  moving: Anchor;
  reference: Anchor;
  offset: number;
}
export interface ReferenceAlignmentOptions {
  x?: AxisAlignment;
  y?: AxisAlignment;
  asBlock: boolean;
}
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
  baseline?: number;
}
interface Geometry {
  points: Point[];
  baselines: number[];
  horizontal: boolean;
}
const almost = (a: number, b: number) => Math.abs(a - b) <= 1e-5;
function area(geometry: Geometry): Area {
  const box = bounds(geometry.points),
    first = geometry.baselines[0];
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite))
    throw new Error("An alignment item has no usable position.");
  return {
    ...box,
    baseline:
      geometry.horizontal &&
      first !== undefined &&
      geometry.baselines.every((y) => almost(y, first))
        ? first
        : undefined,
  };
}
function union(items: Geometry[]): Geometry {
  return {
    points: items.flatMap((item) => item.points),
    baselines: items.flatMap((item) => item.baselines),
    horizontal: items.every((item) => item.horizontal),
  };
}
function anchor(box: Area, value: Anchor, axis: "x" | "y"): number {
  if (value === "baseline") {
    if (axis !== "y" || box.baseline === undefined)
      throw new Error(
        "Baseline alignment needs horizontal text on one baseline. Select a single line, align boxes independently, or use an edge or centre.",
      );
    return box.baseline;
  }
  if (!["min", "center", "max"].includes(value))
    throw new Error("Choose an alignment edge.");
  return (
    box[axis] +
    (value === "min"
      ? 0
      : (axis === "x" ? box.width : box.height) *
        (value === "center" ? 0.5 : 1))
  );
}
export function planReferenceAlignment(
  page: EditorPage,
  runs: EditableRun[],
  movingIds: string[],
  references: AlignmentReferences,
  viewport: Matrix,
  options: ReferenceAlignmentOptions,
) {
  if (!options.x && !options.y)
    throw new Error("Choose a horizontal or vertical alignment.");
  inverseVector(viewport, { x: 0, y: 0 });
  const boxes = getTextBoxes(page, runs),
    wanted = new Set(movingIds),
    moving = boxes.filter((box) => wanted.has(box.id));
  if (
    !moving.length ||
    moving.length !== wanted.size ||
    moving.some((box) => !box.movable || box.locked)
  )
    throw new Error("Select the text boxes to move.");
  const refRuns = new Set(references.runIds),
    refShapes = new Set(references.shapeIds);
  if (!refRuns.size && !refShapes.size)
    throw new Error("Pin one or more reference items first.");
  if (moving.some((box) => box.runs.some((run) => refRuns.has(run.id))))
    throw new Error(
      "Moving text and reference text must be separate. Select only the text you want to move.",
    );
  const offsets = new Map(
    (page.textOffsets ?? []).map((offset) => [offset.runId, offset]),
  );
  const replacements = new Map(
    (page.textReplacements ?? []).map((edit) => [edit.runId, edit.replacement]),
  );
  const byId = new Map(
    boxes.flatMap((box) => box.runs.map((run) => [run.id, run] as const)),
  );
  const pieces = new Map(
    boxes.flatMap((box) =>
      box.pieces.map(
        (piece) =>
          [piece.runId, { piece, run: byId.get(piece.runId)! }] as const,
      ),
    ),
  );
  const pieceGeometry = (id: string): Geometry => {
    const entry = pieces.get(id);
    if (!entry || !(replacements.get(id) ?? entry.run.text).trim())
      throw new Error(
        "A pinned text item was removed or has no usable position. Choose your references again.",
      );
    const { piece, run } = entry,
      offset = offsets.get(id);
    if (offset && offset.original !== run.text)
      throw new Error(
        "A text position is stale. Undo the move or reopen the document.",
      );
    const points = piece.quad.map((p) => transform(viewport, p)),
      baseline = transform(viewport, piece.baseline);
    return {
      points,
      baselines: [baseline.y],
      horizontal: almost(points[0].y, points[1].y),
    };
  };
  const refs: Geometry[] = [...refRuns].map(pieceGeometry);
  for (const id of refShapes) {
    const shape = page.annotations.find(
      (a) => a.id === id && a.kind === "rectangle",
    );
    if (
      !shape ||
      shape.kind !== "rectangle" ||
      ![shape.x, shape.y, shape.width, shape.height].every(Number.isFinite) ||
      shape.width <= 0 ||
      shape.height <= 0
    )
      throw new Error(
        "A pinned rectangle was removed or has no usable position. Choose your references again.",
      );
    refs.push({
      points: [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.width, y: shape.y },
        { x: shape.x + shape.width, y: shape.y + shape.height },
        { x: shape.x, y: shape.y + shape.height },
      ].map((p) => transform(viewport, p)),
      baselines: [],
      horizontal: false,
    });
  }
  const reference = area(union(refs));
  const visibleGeometry = (box: (typeof boxes)[number]) =>
    box.runs
      .filter((run) => (replacements.get(run.id) ?? run.text).trim())
      .map((run) => pieceGeometry(run.id));
  const groups = options.asBlock
    ? [
        {
          ids: moving.map((box) => box.id),
          geometry: union(moving.flatMap(visibleGeometry)),
        },
      ]
    : moving.map((box) => ({
        ids: [box.id],
        geometry: union(visibleGeometry(box)),
      }));
  const moves = groups.map((group) => {
    const movingArea = area(group.geometry);
    const delta = (axis: "x" | "y") => {
      const rule = options[axis];
      if (!rule) return 0;
      if (!Number.isFinite(rule.offset))
        throw new Error("Enter a finite alignment offset.");
      return (
        anchor(reference, rule.reference, axis) -
        anchor(movingArea, rule.moving, axis) +
        rule.offset
      );
    };
    const stable = (value: number) => (Math.abs(value) < 1e-7 ? 0 : value);
    const dx = stable(delta("x")),
      dy = stable(delta("y")),
      native = inverseVector(viewport, { x: dx, y: dy });
    if (![dx, dy, native.x, native.y].every(Number.isFinite))
      throw new Error("Alignment is out of range.");
    return { ids: group.ids, dx, dy, native };
  });
  return { reference, moves };
}
export function alignToReferences(
  page: EditorPage,
  runs: EditableRun[],
  movingIds: string[],
  references: AlignmentReferences,
  viewport: Matrix,
  options: ReferenceAlignmentOptions,
): EditorPage {
  const plan = planReferenceAlignment(
    page,
    runs,
    movingIds,
    references,
    viewport,
    options,
  );
  let next = page;
  for (const move of plan.moves)
    next = moveTextBoxes(next, runs, move.ids, move.native.x, move.native.y);
  return next;
}
