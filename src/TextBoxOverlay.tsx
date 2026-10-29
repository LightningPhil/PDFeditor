import { useRef, useState } from "react";
import { bounds, inverseVector, transform } from "./geometry";
import type { Matrix, Point } from "./geometry";
import type { TextBox } from "./text-boxes";
import type { PointerEvent } from "react";

export function TextBoxOverlay({
  disabled,
  boxes,
  selected,
  viewport,
  width,
  height,
  onSelect,
  onMove,
}: {
  disabled: boolean;
  boxes: TextBox[];
  selected: string[];
  viewport: Matrix;
  width: number;
  height: number;
  onSelect: (id: string | null, extend?: boolean) => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ ids: string[]; start: Point } | null>(null);
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 });
  function point(event: PointerEvent) {
    const rect = svg.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
    };
  }
  function finish(event: PointerEvent) {
    if (!drag.current) return;
    const { ids, start } = drag.current;
    const end = point(event);
    drag.current = null;
    setDelta({ x: 0, y: 0 });
    if (Math.hypot(end.x - start.x, end.y - start.y) > 1) {
      const native = inverseVector(viewport, {
        x: end.x - start.x,
        y: end.y - start.y,
      });
      onMove(ids, native.x, native.y);
    }
  }
  return (
    <svg
      ref={svg}
      className={`text-box-layer ${disabled ? "is-rendering" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      tabIndex={0}
      aria-label="Text boxes. Select text, then use arrow keys to move it."
      onPointerMove={(event) => {
        if (drag.current) {
          const end = point(event);
          setDelta({
            x: end.x - drag.current.start.x,
            y: end.y - drag.current.start.y,
          });
        }
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        drag.current = null;
        setDelta({ x: 0, y: 0 });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          drag.current = null;
          setDelta({ x: 0, y: 0 });
          onSelect(null);
          return;
        }
        const step = event.shiftKey ? 10 : 1;
        const direction: Record<string, Point> = {
          ArrowLeft: { x: -step, y: 0 },
          ArrowRight: { x: step, y: 0 },
          ArrowUp: { x: 0, y: -step },
          ArrowDown: { x: 0, y: step },
        };
        if (direction[event.key] && selected.length) {
          event.preventDefault();
          if (disabled) return;
          const native = inverseVector(viewport, direction[event.key]);
          onMove(selected, native.x, native.y);
        }
      }}
    >
      {boxes
        .filter(
          (box) => box.points.length && box.runs.every((run) => run.geometry),
        )
        .map((box) => {
          const area = bounds(
            box.points.map((point) => transform(viewport, point)),
          );
          const moving = drag.current?.ids.includes(box.id);
          return (
            <rect
              key={box.id}
              x={area.x - 2}
              y={area.y - 2}
              width={Math.max(3, area.width) + 4}
              height={Math.max(3, area.height) + 4}
              transform={
                moving ? `translate(${delta.x} ${delta.y})` : undefined
              }
              className={`text-hitbox ${selected.includes(box.id) ? "is-selected" : ""} ${box.joined ? "is-joined" : ""}`}
              role="button"
              tabIndex={-1}
              aria-label={`Select text: ${box.runs.map((run) => run.text).join("")}`}
              onPointerDown={(event) => {
                if (disabled || event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                svg.current?.focus({ preventScroll: true });
                if (event.shiftKey || event.ctrlKey || event.metaKey) {
                  onSelect(box.id, true);
                  return;
                }
                const ids = selected.includes(box.id) ? selected : [box.id];
                if (!selected.includes(box.id)) onSelect(box.id);
                drag.current = { ids, start: point(event) };
                setDelta({ x: 0, y: 0 });
                svg.current!.setPointerCapture(event.pointerId);
              }}
            />
          );
        })}
    </svg>
  );
}
