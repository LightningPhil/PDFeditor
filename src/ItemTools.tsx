import { useEffect, useState } from "react";
import type { EditorPage } from "./pdf";
import type { EditableRun } from "./text-edit";
import type { TextBox } from "./text-boxes";
import {
  duplicateItems,
  lockItems,
  rotateText,
  reorderItems,
  updateShape,
} from "./item-operations";
export function ItemTools({
  page,
  runs,
  boxes,
  selected,
  shapes,
  onSelectShape,
  onChange,
  onDuplicate,
  disabled,
}: {
  page: EditorPage;
  runs: EditableRun[];
  boxes: TextBox[];
  selected: string[];
  shapes: string[];
  onSelectShape: (id: string, extend: boolean) => void;
  onChange: (page: EditorPage) => void;
  onDuplicate: (result: ReturnType<typeof duplicateItems>) => void;
  disabled: boolean;
}) {
  const [angle, setAngle] = useState("90"),
    [error, setError] = useState("");
  const moving = boxes.filter((b) => selected.includes(b.id)),
    chosenShapes = page.annotations.filter(
      (a) => shapes.includes(a.id) && a.kind === "rectangle",
    ),
    shape = chosenShapes.length === 1 ? chosenShapes[0] : undefined;
  const locked =
      moving.some((b) => b.locked) || chosenShapes.some((a) => a.locked),
    any = !!(moving.length || chosenShapes.length),
    [draft, setDraft] = useState({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      color: "#297768",
      fill: "#ffffff",
      filled: false,
      borderWidth: 2,
    });
  const layerable =
    chosenShapes.length > 0 ||
    moving.some((b) => b.runs.some((r) => r.id.startsWith("added:")));
  useEffect(() => {
    if (shape?.kind === "rectangle")
      setDraft({
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        color: shape.color,
        fill: shape.fill ?? "#ffffff",
        filled: !!shape.fill,
        borderWidth: shape.borderWidth ?? 2,
      });
  }, [shape]);
  const perform = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="item-tools">
      <strong>Selection tools</strong>
      <fieldset disabled={disabled}>
        <div className="button-wrap">
          <button
            disabled={!any}
            onClick={() =>
              perform(() =>
                onDuplicate(
                  duplicateItems(page, runs, selected, shapes, () =>
                    crypto.randomUUID(),
                  ),
                ),
              )
            }
          >
            Duplicate selection
          </button>
          <button
            disabled={!any}
            onClick={() =>
              perform(() =>
                onChange(lockItems(page, runs, selected, shapes, !locked)),
              )
            }
          >
            {locked ? "Unlock selection" : "Lock selection"}
          </button>
        </div>
        <div className="compact-row">
          <label>
            Rotate text (degrees)
            <input
              aria-label="Text rotation degrees"
              type="number"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
            />
          </label>
          <button
            disabled={!moving.length || locked || !angle.trim()}
            onClick={() =>
              perform(() =>
                onChange(rotateText(page, runs, selected, Number(angle))),
              )
            }
          >
            Rotate text
          </button>
        </div>
        <div className="button-wrap">
          <button
            disabled={!layerable || locked}
            onClick={() =>
              perform(() =>
                onChange(
                  reorderItems(
                    page,
                    moving.flatMap((b) => b.runs.map((r) => r.id)),
                    shapes,
                    true,
                    true,
                  ),
                ),
              )
            }
          >
            Bring forward
          </button>
          <button
            disabled={!layerable || locked}
            onClick={() =>
              perform(() =>
                onChange(
                  reorderItems(
                    page,
                    moving.flatMap((b) => b.runs.map((r) => r.id)),
                    shapes,
                    false,
                    true,
                  ),
                ),
              )
            }
          >
            Send backward
          </button>
          <button
            disabled={!layerable || locked}
            onClick={() =>
              perform(() =>
                onChange(
                  reorderItems(
                    page,
                    moving.flatMap((b) => b.runs.map((r) => r.id)),
                    shapes,
                    true,
                  ),
                ),
              )
            }
          >
            Bring to front
          </button>
          <button
            disabled={!layerable || locked}
            onClick={() =>
              perform(() =>
                onChange(
                  reorderItems(
                    page,
                    moving.flatMap((b) => b.runs.map((r) => r.id)),
                    shapes,
                    false,
                  ),
                ),
              )
            }
          >
            Send to back
          </button>
        </div>
        <p className="hint">
          Layer order changes added text and shapes. Original PDF text retains
          its source drawing order. Locked items can be selected to unlock them.
        </p>
        <details>
          <summary>
            Added rectangles (
            {page.annotations.filter((a) => a.kind === "rectangle").length})
          </summary>
          {page.annotations
            .filter((a) => a.kind === "rectangle")
            .map((a, i) => (
              <label className="inline-check" key={a.id}>
                <input
                  aria-label={`Select added rectangle ${i + 1}`}
                  type="checkbox"
                  checked={shapes.includes(a.id)}
                  onChange={() => onSelectShape(a.id, true)}
                />{" "}
                Rectangle {i + 1}
                {a.locked ? " · locked" : ""}
              </label>
            ))}
        </details>
        {shape?.kind === "rectangle" && (
          <details open>
            <summary>Rectangle appearance & size</summary>
            <fieldset disabled={!!shape.locked}>
              <p className="hint">
                Drag its border to move it or use the corner handles to resize
                it. Coordinates and dimensions use native PDF points.
              </p>
              <div className="form-grid">
                {(["x", "y", "width", "height", "borderWidth"] as const).map(
                  (key) => (
                    <label key={key}>
                      {key === "borderWidth"
                        ? "Border thickness"
                        : key.charAt(0).toUpperCase() + key.slice(1)}
                      <input
                        type="number"
                        step="any"
                        aria-label={`Rectangle ${key}`}
                        value={Math.round(draft[key] * 100) / 100}
                        onChange={(e) =>
                          setDraft((s) => ({
                            ...s,
                            [key]: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                  ),
                )}
                <label>
                  Border colour
                  <input
                    aria-label="Rectangle border colour"
                    type="color"
                    value={draft.color}
                    onChange={(e) =>
                      setDraft((s) => ({ ...s, color: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Fill colour
                  <input
                    aria-label="Rectangle fill colour"
                    type="color"
                    value={draft.fill}
                    onChange={(e) =>
                      setDraft((s) => ({ ...s, fill: e.target.value }))
                    }
                  />
                </label>
              </div>
              <label className="inline-check">
                <input
                  aria-label="Fill rectangle"
                  type="checkbox"
                  checked={draft.filled}
                  onChange={(e) =>
                    setDraft((s) => ({ ...s, filled: e.target.checked }))
                  }
                />{" "}
                Fill rectangle
              </label>
              <button
                onClick={() =>
                  perform(() =>
                    onChange(
                      updateShape(page, shape.id, {
                        x: draft.x,
                        y: draft.y,
                        width: draft.width,
                        height: draft.height,
                        color: draft.color,
                        borderWidth: draft.borderWidth,
                        fill: draft.filled ? draft.fill : undefined,
                      }),
                    ),
                  )
                }
              >
                Apply rectangle changes
              </button>
            </fieldset>
          </details>
        )}
        {error && (
          <p role="alert" className="edit-error">
            {error}
          </p>
        )}
      </fieldset>
    </section>
  );
}
