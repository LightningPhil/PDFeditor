import { useEffect, useMemo, useRef, useState } from "react";
import { bounds, inverseVector, transform } from "./geometry";
import type { Matrix, Point } from "./geometry";
import type { TextBox } from "./text-boxes";
import {
  boxesInRectangle,
  boxesAtPoint,
  cycleTextTarget,
} from "./text-selection";
import type { Rectangle } from "./text-selection";
import type { PointerEvent } from "react";
import { snapTextMove } from "./text-alignment";
import type { MoveGuide } from "./text-alignment";

type Gesture =
  | {
      kind: "move";
      ids: string[];
      members: Set<string>;
      start: Point;
      pointerId: number;
    }
  | { kind: "select"; base: string[]; start: Point; pointerId: number };
export function TextBoxOverlay({
  disabled,
  positionReady,
  boxes,
  selected,
  viewport,
  width,
  height,
  onSelect,
  onSelection,
  onMove,
  snapEnabled,
}: {
  disabled: boolean;
  positionReady: boolean;
  boxes: TextBox[];
  selected: string[];
  viewport: Matrix;
  width: number;
  height: number;
  onSelect: (id: string | null, extend?: boolean) => void;
  onSelection: (ids: string[]) => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
  snapEnabled: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null),
    gesture = useRef<Gesture | null>(null);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 }),
    [marquee, setMarquee] = useState<Rectangle | null>(null);
  const [guides, setGuides] = useState<MoveGuide[]>([]);
  function snapped(ids: string[], dx: number, dy: number) {
    const native = inverseVector(viewport, { x: dx, y: dy });
    return snapEnabled
      ? snapTextMove(boxes, ids, native.x, native.y)
      : { ...native, dx: native.x, dy: native.y, guides: [] };
  }
  function point(event: PointerEvent) {
    const rect = svg.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
    };
  }
  function cancel() {
    const current = gesture.current;
    gesture.current = null;
    setDelta({ x: 0, y: 0 });
    setMarquee(null);
    setGuides([]);
    if (current && svg.current?.hasPointerCapture(current.pointerId))
      svg.current.releasePointerCapture(current.pointerId);
  }
  useEffect(() => {
    cancel();
  }, [disabled, viewport, width, height]);
  function rectangle(a: Point, b: Point): Rectangle {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }
  function finish(event: PointerEvent) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const end = point(event);
    gesture.current = null;
    setDelta({ x: 0, y: 0 });
    setMarquee(null);
    setGuides([]);
    if (svg.current?.hasPointerCapture(event.pointerId))
      svg.current.releasePointerCapture(event.pointerId);
    if (current.kind === "move") {
      if (Math.hypot(end.x - current.start.x, end.y - current.start.y) > 1) {
        const native = snapped(
          current.ids,
          end.x - current.start.x,
          end.y - current.start.y,
        );
        onMove(current.ids, native.dx, native.dy);
      }
    } else {
      const hits = boxesInRectangle(
        boxes,
        viewport,
        rectangle(current.start, end),
      );
      onSelection([...new Set([...current.base, ...hits])]);
    }
  }
  return (
    <svg
      ref={svg}
      className={`text-box-layer ${disabled ? "is-rendering" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      tabIndex={0}
      aria-label="Text boxes. Drag empty space to select. Use arrow keys to move selected text."
      onPointerDown={(event) => {
        if (disabled || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        svg.current?.focus({ preventScroll: true });
        const base =
          event.shiftKey || event.ctrlKey || event.metaKey ? selected : [];
        gesture.current = {
          kind: "select",
          base,
          start: point(event),
          pointerId: event.pointerId,
        };
        setMarquee(null);
        if (!base.length) onSelection([]);
        svg.current!.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const end = point(event);
        if (current.kind === "move") {
          const next = snapped(
            current.ids,
            end.x - current.start.x,
            end.y - current.start.y,
          );
          setDelta({
            x: viewport[0] * next.dx + viewport[2] * next.dy,
            y: viewport[1] * next.dx + viewport[3] * next.dy,
          });
          setGuides(next.guides);
        } else setMarquee(rectangle(current.start, end));
      }}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (gesture.current) cancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          onSelection([]);
          return;
        }
        const step = event.shiftKey ? 10 : 1,
          direction: Record<string, Point> = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step },
          };
        if (direction[event.key] && selected.length) {
          event.preventDefault();
          if (!positionReady || gesture.current) return;
          const native = inverseVector(viewport, direction[event.key]);
          onMove(selected, native.x, native.y);
        }
      }}
    >
      {boxes
        .filter((box) => box.movable && box.points.length)
        .map((box) => {
          const area = bounds(
              box.points.map((point) => transform(viewport, point)),
            ),
            moving =
              gesture.current?.kind === "move" &&
              gesture.current.members.has(box.id),
            isSelected = selectedIds.has(box.id);
          return (
            <g
              key={box.id}
              data-text-box={box.id}
              transform={
                moving ? `translate(${delta.x} ${delta.y})` : undefined
              }
              className={`text-hitbox ${isSelected ? "is-selected" : ""} ${box.joined ? "is-joined" : ""}`}
              role="button"
              tabIndex={-1}
              aria-pressed={isSelected}
              aria-label={`Select text: ${box.text}`}
              onPointerDown={(event) => {
                if (disabled || event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.stopPropagation();
                svg.current?.focus({ preventScroll: true });
                const hits = boxesAtPoint(boxes, viewport, point(event));
                const target =
                  (event.altKey ? cycleTextTarget(hits, selected) : hits[0]) ??
                  box.id;
                if (event.altKey) {
                  onSelect(target);
                  return;
                }
                if (event.shiftKey || event.ctrlKey || event.metaKey) {
                  onSelect(target, true);
                  return;
                }
                const ids = selectedIds.has(target) ? selected : [target];
                if (!selectedIds.has(target)) onSelect(target);
                gesture.current = {
                  kind: "move",
                  ids,
                  members: new Set(ids),
                  start: point(event),
                  pointerId: event.pointerId,
                };
                setDelta({ x: 0, y: 0 });
                svg.current!.setPointerCapture(event.pointerId);
              }}
            >
              {box.pieces.map((piece) => (
                <polygon
                  key={piece.runId}
                  className="text-piece-target"
                  points={piece.quad
                    .map((point) => {
                      const p = transform(viewport, point);
                      return p.x + "," + p.y;
                    })
                    .join(" ")}
                />
              ))}
              {isSelected && (
                <rect
                  className="text-drag-border"
                  x={area.x - 2}
                  y={area.y - 2}
                  width={Math.max(3, area.width) + 4}
                  height={Math.max(3, area.height) + 4}
                />
              )}
              <rect
                className="text-box-outline"
                x={area.x - 2}
                y={area.y - 2}
                width={Math.max(3, area.width) + 4}
                height={Math.max(3, area.height) + 4}
              />
            </g>
          );
        })}
      {marquee && (
        <rect
          className="text-marquee"
          x={marquee.x}
          y={marquee.y}
          width={marquee.width}
          height={marquee.height}
        />
      )}
      <g className="alignment-guides">
        {guides.map((guide, index) => {
          const a = transform(
              viewport,
              guide.axis === "x"
                ? { x: guide.value, y: -100000 }
                : { x: -100000, y: guide.value },
            ),
            b = transform(
              viewport,
              guide.axis === "x"
                ? { x: guide.value, y: 100000 }
                : { x: 100000, y: guide.value },
            );
          return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
    </svg>
  );
}
