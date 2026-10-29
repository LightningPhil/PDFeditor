import type { TextBox } from "./text-boxes";
import { transform } from "./geometry";
import type { Matrix, Point } from "./geometry";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Anchor selection to pieces so joins, splits and undo keep it meaningful. */
export function selectedTextBoxIds(
  boxes: TextBox[],
  members: string[],
): string[] {
  const selected = new Set(members);
  return boxes
    .filter((box) => box.runs.some((run) => selected.has(run.id)))
    .map((box) => box.id);
}
export function textMembersForBoxes(boxes: TextBox[], ids: string[]): string[] {
  const selected = new Set(ids);
  return [
    ...new Set(
      boxes
        .filter((box) => selected.has(box.id))
        .flatMap((box) => box.runs.map((run) => run.id)),
    ),
  ];
}
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function pointInPolygon(point: Point, quad: Point[]): boolean {
  const area = Math.abs(
    quad.reduce(
      (sum, p, i) =>
        sum +
        p.x * quad[(i + 1) % quad.length].y -
        p.y * quad[(i + 1) % quad.length].x,
      0,
    ),
  );
  if (area < 1e-8)
    return quad.some((p, i) => {
      const q = quad[(i + 1) % quad.length];
      return (
        Math.abs(cross(p, q, point)) < 1e-8 &&
        (point.x - p.x) * (point.x - q.x) + (point.y - p.y) * (point.y - q.y) <=
          1e-8
      );
    });
  let positive = false,
    negative = false;
  for (let i = 0; i < quad.length; i++) {
    const value = cross(quad[i], quad[(i + 1) % quad.length], point);
    positive ||= value > 1e-8;
    negative ||= value < -1e-8;
  }
  return !(positive && negative);
}
/** Text wins over a group's empty outline; return stacked targets top first. */
export function boxesAtPoint(
  boxes: TextBox[],
  viewport: Matrix,
  point: Point,
): string[] {
  return boxes
    .filter(
      (box) =>
        box.movable &&
        box.pieces.some((piece) =>
          pointInPolygon(
            point,
            piece.quad.map((p) => transform(viewport, p)),
          ),
        ),
    )
    .map((box) => box.id)
    .reverse();
}
export function cycleTextTarget(
  hits: string[],
  selected: string[],
): string | undefined {
  if (!hits.length) return;
  const index = selected.length === 1 ? hits.indexOf(selected[0]) : -1;
  return hits[(index + 1) % hits.length];
}
function intersects(quad: Point[], rect: Rectangle): boolean {
  const inside = (point: Point) =>
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
  if (quad.some(inside)) return true;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  if (corners.some((point) => pointInPolygon(point, quad))) return true;
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++) {
      const p = quad[a],
        q = quad[(a + 1) % 4],
        r = corners[b],
        s = corners[(b + 1) % 4];
      if (
        cross(p, q, r) * cross(p, q, s) < 0 &&
        cross(r, s, p) * cross(r, s, q) < 0
      )
        return true;
    }
  return false;
}
/** Select actual pieces, never the empty interior of a joined bounding box. */
export function boxesInRectangle(
  boxes: TextBox[],
  viewport: Matrix,
  rect: Rectangle,
): string[] {
  if (rect.width <= 0 || rect.height <= 0) return [];
  return boxes
    .filter(
      (box) =>
        box.movable &&
        box.pieces.some((piece) =>
          intersects(
            piece.quad.map((point) => transform(viewport, point)),
            rect,
          ),
        ),
    )
    .map((box) => box.id);
}

/** Find a connected line of neighbours; large column gutters stop expansion. */
export function neighbouringLine(
  boxes: TextBox[],
  selectedId: string,
): string[] {
  const seed = boxes.find((box) => box.id === selectedId);
  if (!seed?.movable || !seed.pieces.length) return [];
  const first = seed.pieces.reduce((a, b) =>
    Math.hypot(b.quad[1].x - b.quad[0].x, b.quad[1].y - b.quad[0].y) >
    Math.hypot(a.quad[1].x - a.quad[0].x, a.quad[1].y - a.quad[0].y)
      ? b
      : a,
  );
  const edge = {
      x: first.quad[1].x - first.quad[0].x,
      y: first.quad[1].y - first.quad[0].y,
    },
    length = Math.hypot(edge.x, edge.y);
  if (length < 1e-9) return [seed.id];
  const u = { x: edge.x / length, y: edge.y / length },
    n = { x: -u.y, y: u.x };
  const seedBand = first.quad.map((point) => dot(point, n)),
    bottom = Math.min(...seedBand),
    top = Math.max(...seedBand),
    height = top - bottom,
    baseline = dot(first.baseline, n);
  if (height < 1e-9) return [seed.id];
  const compatible = (piece: TextBox["pieces"][number]) => {
    const axis = {
        x: piece.quad[1].x - piece.quad[0].x,
        y: piece.quad[1].y - piece.quad[0].y,
      },
      width = Math.hypot(axis.x, axis.y);
    const band = piece.quad.map((point) => dot(point, n)),
      low = Math.min(...band),
      high = Math.max(...band),
      h = high - low;
    return (
      (!width ||
        Math.abs(dot(axis, u)) / width >= Math.cos((7 * Math.PI) / 180)) &&
      h >= height * 0.3 &&
      h <= height * 2.5 &&
      Math.abs(dot(piece.baseline, n) - baseline) <=
        Math.max(height, h) * 0.6 &&
      Math.min(high, top) - Math.max(low, bottom) >= Math.min(height, h) * 0.1
    );
  };
  if (!seed.pieces.every(compatible)) return [seed.id];
  const eligible = boxes.filter(
    (box) => box.movable && box.pieces.every(compatible),
  );
  const parents = new Map(eligible.map((box) => [box.id, box.id]));
  function root(id: string): string {
    let next = parents.get(id)!;
    while (next !== parents.get(next)) next = parents.get(next)!;
    parents.set(id, next);
    return next;
  }
  const intervals = eligible
    .flatMap((box) =>
      box.pieces.map((piece) => {
        const values = piece.quad.map((point) => dot(point, u));
        return {
          id: box.id,
          start: Math.min(...values),
          end: Math.max(...values),
        };
      }),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let previous: (typeof intervals)[number] | undefined;
  for (const interval of intervals) {
    if (previous && interval.start - previous.end <= height * 1.15) {
      parents.set(root(interval.id), root(previous.id));
      if (interval.end > previous.end) previous = interval;
    } else previous = interval;
  }
  const target = root(seed.id);
  return boxes
    .filter((box) => parents.has(box.id) && root(box.id) === target)
    .map((box) => box.id);
}
