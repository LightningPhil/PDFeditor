import { useRef, useState, useEffect } from "react";
import type { EditorPage } from "./pdf";
import { inverseVector, transform } from "./geometry";
import type { Matrix, Point } from "./geometry";
export function ShapeOverlay({
  page,
  viewport,
  width,
  height,
  selected,
  disabled,
  onSelect,
  onChange,
}: {
  page: EditorPage;
  viewport: Matrix;
  width: number;
  height: number;
  selected: string[];
  disabled: boolean;
  onSelect: (id: string, extend: boolean) => void;
  onChange: (page: EditorPage) => void;
}) {
  const svg = useRef<SVGSVGElement>(null),
    gesture = useRef<{
      id: string;
      start: Point;
      corner?: number;
      ids: string[];
    } | null>(null),
    [preview, setPreview] = useState<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>(null);
  const shapes = page.annotations.filter((a) => a.kind === "rectangle");
  const point = (event: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return inverseVector(viewport, {
      x: ((event.clientX - r.left) * width) / r.width - viewport[4],
      y: ((event.clientY - r.top) * height) / r.height - viewport[5],
    });
  };
  function cancel() {
    gesture.current = null;
    setPreview(null);
  }
  useEffect(() => cancel(), [page.id, page.annotations, viewport, disabled]);
  return (
    <svg
      ref={svg}
      className="shape-layer"
      viewBox={`0 0 ${width} ${height}`}
      aria-label="Added rectangles"
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g) return;
        const a = shapes.find((a) => a.id === g.id)!;
        if (a.kind !== "rectangle") return;
        const p = point(e);
        if (g.corner === undefined)
          setPreview({
            id: a.id,
            x: a.x + p.x - g.start.x,
            y: a.y + p.y - g.start.y,
            width: a.width,
            height: a.height,
          });
        else {
          const corners = [
              { x: a.x, y: a.y },
              { x: a.x + a.width, y: a.y },
              { x: a.x + a.width, y: a.y + a.height },
              { x: a.x, y: a.y + a.height },
            ],
            opposite = corners[(g.corner + 2) % 4];
          setPreview({
            id: a.id,
            x: Math.min(p.x, opposite.x),
            y: Math.min(p.y, opposite.y),
            width: Math.max(1, Math.abs(p.x - opposite.x)),
            height: Math.max(1, Math.abs(p.y - opposite.y)),
          });
        }
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        cancel();
        if (svg.current!.hasPointerCapture(e.pointerId))
          svg.current!.releasePointerCapture(e.pointerId);
        if (!g) return;
        const original = shapes.find((a) => a.id === g.id)!;
        if (original.kind !== "rectangle") return;
        const p = point(e);
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) < 0.5) return;
        const corners = [
            { x: original.x, y: original.y },
            { x: original.x + original.width, y: original.y },
            { x: original.x + original.width, y: original.y + original.height },
            { x: original.x, y: original.y + original.height },
          ],
          opposite = corners[((g.corner ?? 0) + 2) % 4];
        const current =
          g.corner === undefined
            ? {
                x: original.x + p.x - g.start.x,
                y: original.y + p.y - g.start.y,
                width: original.width,
                height: original.height,
              }
            : {
                x: Math.min(p.x, opposite.x),
                y: Math.min(p.y, opposite.y),
                width: Math.max(1, Math.abs(p.x - opposite.x)),
                height: Math.max(1, Math.abs(p.y - opposite.y)),
              };
        onChange({
          ...page,
          annotations: page.annotations.map((a) => {
            if (a.kind !== "rectangle" || !g.ids.includes(a.id) || a.locked)
              return a;
            return g.corner !== undefined && a.id === g.id
              ? {
                  ...a,
                  x: current.x,
                  y: current.y,
                  width: current.width,
                  height: current.height,
                }
              : g.corner === undefined
                ? {
                    ...a,
                    x: a.x + current.x - original.x,
                    y: a.y + current.y - original.y,
                  }
                : a;
          }),
        });
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    >
      {shapes.map((a, index) => {
        if (a.kind !== "rectangle") return null;
        const current = preview?.id === a.id ? preview : a;
        const corners = [
          { x: current.x, y: current.y },
          { x: current.x + current.width, y: current.y },
          { x: current.x + current.width, y: current.y + current.height },
          { x: current.x, y: current.y + current.height },
        ].map((p) => transform(viewport, p));
        const chosen = selected.includes(a.id);
        const begin = (e: React.PointerEvent, corner?: number) => {
          if (disabled || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const extend = e.shiftKey || e.ctrlKey || e.metaKey;
          onSelect(a.id, extend);
          if (
            extend ||
            a.locked ||
            shapes.some((shape) => selected.includes(shape.id) && shape.locked)
          )
            return;
          gesture.current = {
            id: a.id,
            start: point(e),
            corner,
            ids: corner === undefined && chosen ? selected : [a.id],
          };
          svg.current!.setPointerCapture(e.pointerId);
        };
        return (
          <g
            key={a.id}
            className={`shape-hit ${chosen ? "selected" : ""} ${a.locked ? "locked" : ""}`}
          >
            <polygon
              role="button"
              aria-label={`Select rectangle ${index + 1}`}
              points={corners.map((p) => `${p.x},${p.y}`).join(" ")}
              onPointerDown={(e) => begin(e)}
            />
            {chosen &&
              !a.locked &&
              corners.map((p, i) => (
                <rect
                  key={i}
                  role="button"
                  aria-label={`Resize rectangle ${index + 1} corner ${i + 1}`}
                  x={p.x - 5}
                  y={p.y - 5}
                  width="10"
                  height="10"
                  onPointerDown={(e) => begin(e, i)}
                />
              ))}
          </g>
        );
      })}
    </svg>
  );
}
