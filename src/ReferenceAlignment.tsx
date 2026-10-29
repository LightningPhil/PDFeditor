import { useMemo, useState } from "react";
import type { EditorPage } from "./pdf";
import type { EditableRun } from "./text-edit";
import type { TextBox } from "./text-boxes";
import type { Matrix } from "./geometry";
import {
  alignToReferences,
  planReferenceAlignment,
} from "./reference-alignment";
import type {
  AlignmentReferences,
  Anchor,
  ReferenceAlignmentOptions,
} from "./reference-alignment";

export function ReferenceAlignment({
  page,
  runs,
  boxes,
  selected,
  references,
  viewport,
  disabled,
  onReferences,
  onPin,
  onChange,
}: {
  page: EditorPage;
  runs: EditableRun[];
  boxes: TextBox[];
  selected: string[];
  references: AlignmentReferences;
  viewport: Matrix;
  disabled: boolean;
  onReferences: (refs: AlignmentReferences) => void;
  onPin: () => void;
  onChange: (page: EditorPage) => void;
}) {
  const [x, setX] = useState<Anchor | "">("min"),
    [rx, setRx] = useState<Anchor>("min"),
    [y, setY] = useState<Anchor | "">(""),
    [ry, setRy] = useState<Anchor>("min");
  const [offsetX, setOffsetX] = useState("0"),
    [offsetY, setOffsetY] = useState("0"),
    [gap, setGap] = useState("8"),
    [asBlock, setAsBlock] = useState(true),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const runSet = useMemo(() => new Set(references.runIds), [references.runIds]);
  const shapeSet = useMemo(
    () => new Set(references.shapeIds),
    [references.shapeIds],
  );
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const replacements = useMemo(
    () =>
      new Map(
        (page.textReplacements ?? []).map((edit) => [
          edit.runId,
          edit.replacement,
        ]),
      ),
    [page.textReplacements],
  );
  const moving = boxes.filter((box) => selectedIds.has(box.id));
  const pinned = boxes.filter((box) =>
    box.runs.some((run) => runSet.has(run.id)),
  );
  const shapes = page.annotations.filter((a) => a.kind === "rectangle");
  const overlap = moving.some((box) =>
    box.runs.some((run) => runSet.has(run.id)),
  );
  const available = new Set(
    boxes.flatMap((box) => box.runs.map((run) => run.id)),
  );
  const visibleRunIds = (box: TextBox) =>
    box.runs
      .filter((run) => (replacements.get(run.id) ?? run.text).trim())
      .map((run) => run.id);
  const missing =
    references.runIds.some((id) => !available.has(id)) ||
    references.shapeIds.some((id) => !shapes.some((a) => a.id === id));
  const options: ReferenceAlignmentOptions = {
    asBlock,
    x: x
      ? {
          moving: x,
          reference: rx,
          offset: offsetX.trim() ? Number(offsetX) : NaN,
        }
      : undefined,
    y: y
      ? {
          moving: y,
          reference: ry,
          offset: offsetY.trim() ? Number(offsetY) : NaN,
        }
      : undefined,
  };
  let preview = "",
    problem = "";
  if (
    moving.length &&
    (references.runIds.length || references.shapeIds.length) &&
    !disabled
  )
    try {
      const plan = planReferenceAlignment(
        page,
        runs,
        selected,
        references,
        viewport,
        options,
      );
      preview = plan.moves.every((move) => move.dx === 0 && move.dy === 0)
        ? "Already aligned."
        : plan.moves.length === 1
          ? `Move ${plan.moves[0].dx.toFixed(2)} pt right, ${plan.moves[0].dy.toFixed(2)} pt down.`
          : `Align ${plan.moves.length} boxes independently to the same reference bounds.`;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  function toggleText(box: TextBox, checked: boolean) {
    const ids = new Set(references.runIds);
    (checked ? visibleRunIds(box) : box.runs.map((run) => run.id)).forEach(
      (id) => (checked ? ids.add(id) : ids.delete(id)),
    );
    onReferences({ ...references, runIds: [...ids] });
  }
  function apply(next: ReferenceAlignmentOptions) {
    try {
      onChange(
        alignToReferences(page, runs, selected, references, viewport, next),
      );
      setX(next.x?.moving ?? "");
      setRx(next.x?.reference ?? "min");
      setY(next.y?.moving ?? "");
      setRy(next.y?.reference ?? "min");
      setOffsetX(String(next.x?.offset ?? 0));
      setOffsetY(String(next.y?.offset ?? 0));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const filtered = boxes
    .map((box, index) => ({ box, index }))
    .filter(({ box, index }) =>
      `${index + 1} ${box.text}`.toLowerCase().includes(query.toLowerCase()),
    );
  const choices = (axis: "x" | "y") =>
    axis === "x"
      ? [
          ["min", "Left"],
          ["center", "Centre"],
          ["max", "Right"],
        ]
      : [
          ["min", "Top"],
          ["center", "Middle"],
          ["max", "Bottom"],
          ["baseline", "Baseline"],
        ];
  return (
    <details className="reference-alignment" open>
      <summary>Align to other items</summary>
      <fieldset disabled={disabled}>
        <p className="hint">
          1. Pin reference items. 2. Select the text to move. References stay
          fixed. Purple outlines mark references; multiple items use their
          combined bounds.
        </p>
        <div className="button-wrap">
          <button
            disabled={!moving.length || moving.some((box) => !box.movable)}
            onClick={onPin}
          >
            Pin selection as references
          </button>
          <button
            disabled={!references.runIds.length && !references.shapeIds.length}
            onClick={() => onReferences({ runIds: [], shapeIds: [] })}
          >
            Clear references
          </button>
        </div>
        <p className="reference-summary" role="status">
          {pinned.length} text {pinned.length === 1 ? "box" : "boxes"} +{" "}
          {references.shapeIds.length} rectangles pinned · {moving.length} text{" "}
          {moving.length === 1 ? "box" : "boxes"} to move
        </p>
        {!!pinned.length && (
          <div className="reference-chips">
            {pinned.map((box) => (
              <button
                key={box.id}
                title={box.text}
                onClick={() => toggleText(box, false)}
              >
                Unpin: {box.text.slice(0, 35)} ×
              </button>
            ))}
          </div>
        )}
        <details className="reference-picker">
          <summary>Choose reference items…</summary>
          <label>
            Filter text boxes
            <input
              aria-label="Filter alignment references"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="reference-list">
            {filtered.slice(0, 60).map(({ box, index }) => (
              <label key={box.id}>
                <input
                  type="checkbox"
                  aria-label={`Reference text box ${index + 1}`}
                  checked={visibleRunIds(box).every((id) => runSet.has(id))}
                  disabled={!box.movable || selectedIds.has(box.id)}
                  onChange={(e) => toggleText(box, e.target.checked)}
                />
                <span>
                  Text {index + 1}: {box.text.slice(0, 80)}
                  {visibleRunIds(box).some((id) => runSet.has(id)) &&
                  !visibleRunIds(box).every((id) => runSet.has(id))
                    ? " (part pinned)"
                    : ""}
                </span>
              </label>
            ))}
            {filtered.length > 60 && (
              <p className="hint">Showing 60 boxes. Filter to find others.</p>
            )}
            {shapes.map((shape, index) => (
              <label key={shape.id}>
                <input
                  type="checkbox"
                  aria-label={`Reference rectangle ${index + 1}`}
                  checked={shapeSet.has(shape.id)}
                  onChange={(e) =>
                    onReferences({
                      ...references,
                      shapeIds: e.target.checked
                        ? [...new Set([...references.shapeIds, shape.id])]
                        : references.shapeIds.filter((id) => id !== shape.id),
                    })
                  }
                />
                <span>Rectangle {index + 1}</span>
              </label>
            ))}
          </div>
        </details>
        {missing && (
          <p role="alert" className="edit-error">
            A pinned item no longer exists. Clear or choose your references
            again.
          </p>
        )}
        {overlap && (
          <p className="hint">
            The selection includes pinned text. Select only the text you want to
            move.
          </p>
        )}
        <label className="reference-block">
          <input
            type="checkbox"
            checked={asBlock}
            onChange={(e) => setAsBlock(e.target.checked)}
          />{" "}
          Move selection as one block
        </label>
        <div className="button-wrap reference-presets">
          {(
            [
              ["Left edges", "x", "min"],
              ["Centres", "x", "center"],
              ["Right edges", "x", "max"],
              ["Top edges", "y", "min"],
              ["Middles", "y", "center"],
              ["Bottom edges", "y", "max"],
              ["Baselines", "y", "baseline"],
            ] as const
          ).map(([label, axis, edge]) => (
            <button
              key={label}
              disabled={
                !moving.length ||
                (!references.runIds.length && !references.shapeIds.length) ||
                missing ||
                overlap
              }
              onClick={() =>
                apply({
                  asBlock,
                  [axis]: { moving: edge, reference: edge, offset: 0 },
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
        {(error || problem) && (
          <p role="alert" className="edit-error">
            {error || problem}
          </p>
        )}
        {preview && !problem && <p className="hint">{preview}</p>}
        <details className="reference-custom">
          <summary>Custom edges & offsets</summary>
          <p className="hint">
            Offsets use points as displayed on the page. Positive is right or
            down. Baselines require horizontal text on one line.
          </p>
          <div className="reference-axis">
            <strong>Horizontal</strong>
            <label>
              Moving edge
              <select
                aria-label="Moving horizontal edge"
                value={x}
                onChange={(e) => setX(e.target.value as Anchor | "")}
              >
                <option value="">Keep position</option>
                {choices("x").map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reference edge
              <select
                aria-label="Reference horizontal edge"
                value={rx}
                onChange={(e) => setRx(e.target.value as Anchor)}
              >
                {choices("x").map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Right offset
              <input
                type="number"
                step="any"
                aria-label="Horizontal alignment offset"
                value={offsetX}
                onChange={(e) => setOffsetX(e.target.value)}
              />
            </label>
          </div>
          <div className="reference-axis">
            <strong>Vertical</strong>
            <label>
              Moving edge
              <select
                aria-label="Moving vertical edge"
                value={y}
                onChange={(e) => setY(e.target.value as Anchor | "")}
              >
                <option value="">Keep position</option>
                {choices("y").map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reference edge
              <select
                aria-label="Reference vertical edge"
                value={ry}
                onChange={(e) => setRy(e.target.value as Anchor)}
              >
                {choices("y").map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Down offset
              <input
                type="number"
                step="any"
                aria-label="Vertical alignment offset"
                value={offsetY}
                onChange={(e) => setOffsetY(e.target.value)}
              />
            </label>
          </div>
          <button
            className="primary"
            disabled={
              !moving.length ||
              (!references.runIds.length && !references.shapeIds.length) ||
              missing ||
              overlap ||
              !!problem
            }
            onClick={() => apply(options)}
          >
            Apply reference alignment
          </button>
        </details>
        <div className="reference-gap">
          <label>
            Gap (points)
            <input
              aria-label="Reference spacing gap"
              type="number"
              min="0"
              step="any"
              value={gap}
              onChange={(e) => setGap(e.target.value)}
            />
          </label>
          <div className="button-wrap">
            {["Left of", "Right of", "Above", "Below"].map((label, index) => (
              <button
                key={label}
                disabled={
                  !moving.length ||
                  (!references.runIds.length && !references.shapeIds.length) ||
                  missing ||
                  overlap ||
                  !gap.trim() ||
                  !Number.isFinite(Number(gap)) ||
                  Number(gap) < 0
                }
                onClick={() => {
                  const amount = Number(gap);
                  apply({
                    asBlock,
                    ...(index < 2
                      ? {
                          x: {
                            moving: index === 0 ? "max" : "min",
                            reference: index === 0 ? "min" : "max",
                            offset: index === 0 ? -amount : amount,
                          },
                        }
                      : {
                          y: {
                            moving: index === 2 ? "max" : "min",
                            reference: index === 2 ? "min" : "max",
                            offset: index === 2 ? -amount : amount,
                          },
                        }),
                  });
                }}
              >
                {label} references
              </button>
            ))}
          </div>
        </div>
      </fieldset>
    </details>
  );
}
