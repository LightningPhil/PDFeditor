import { useState, useEffect, useRef } from "react";
import type { EditorPage } from "./pdf";
import type { EditableRun } from "./text-edit";
import type { TextBox } from "./text-boxes";
import { paragraphFromSelection, reflowSelection } from "./document-editing";
import { layoutParagraph, textFonts } from "./typography";
import type { Paragraph } from "./typography";
import { bounds } from "./geometry";
import { alignText } from "./text-alignment";
import type { Alignment } from "./text-alignment";
import { useStyleLibrary } from "./style-library";
export function TextFormatting({
  page,
  runs,
  boxes,
  selected,
  onChange,
  onMove,
  disabled,
  draft,
  onDraft,
}: {
  page: EditorPage;
  runs: EditableRun[];
  boxes: TextBox[];
  selected: string[];
  onChange: (page: EditorPage, selectedGroup?: string) => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
  disabled: boolean;
  draft?: Paragraph;
  onDraft: (paragraph: Paragraph) => void;
}) {
  const [paragraph, setParagraph] = useState<Paragraph | null>(() => {
    try {
      return draft ?? paragraphFromSelection(page, runs, selected);
    } catch {
      return null;
    }
  });
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const library = useStyleLibrary();
  const [styleName, setStyleName] = useState("My style"),
    [styleId, setStyleId] = useState("");
  const selection = boxes.filter((b) => selected.includes(b.id));
  const area = selection.length
    ? bounds(selection.flatMap((b) => b.points))
    : null;
  const [x, setX] = useState(String(Math.round(area?.x ?? 0))),
    [y, setY] = useState(String(Math.round(area?.y ?? 0)));
  const position = useRef({ x: area?.x ?? 0, y: area?.y ?? 0 });
  useEffect(() => {
    const x = area?.x ?? 0,
      y = area?.y ?? 0,
      dx = x - position.current.x,
      dy = y - position.current.y;
    position.current = { x, y };
    setX(String(Math.round(x * 100) / 100));
    setY(String(Math.round(y * 100) / 100));
    if ((dx || dy) && paragraph) {
      const next = { ...paragraph, x: paragraph.x + dx, y: paragraph.y + dy };
      setParagraph(next);
      onDraft(next);
    }
  }, [area?.x, area?.y]);
  if (!selection.length) return null;
  const update = (patch: Partial<Paragraph>) => {
    setPreview("");
    if (paragraph) {
      const next = { ...paragraph, ...patch };
      setParagraph(next);
      onDraft(next);
    }
  };
  const perform = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="format-tools">
      <details>
        <summary>Position & alignment</summary>
        <fieldset disabled={disabled}>
          <p className="hint">
            PDF points, measured from the page’s lower-left corner.
          </p>
          <div className="form-grid">
            <label>
              X
              <input
                aria-label="Text X position"
                type="number"
                value={x}
                onChange={(e) => setX(e.target.value)}
              />
            </label>
            <label>
              Y
              <input
                aria-label="Text Y position"
                type="number"
                value={y}
                onChange={(e) => setY(e.target.value)}
              />
            </label>
          </div>
          <button
            onClick={() =>
              perform(() => {
                if (
                  !area ||
                  !Number.isFinite(Number(x)) ||
                  !Number.isFinite(Number(y))
                )
                  throw Error("Enter valid coordinates.");
                onMove(selected, Number(x) - area.x, Number(y) - area.y);
              })
            }
          >
            Set position
          </button>
          <div className="button-wrap">
            {(
              [
                "left",
                "center",
                "right",
                "top",
                "baseline",
                "bottom",
                "horizontal",
                "vertical",
              ] as Alignment[]
            ).map((mode) => (
              <button
                key={mode}
                disabled={
                  selected.length <
                  (mode === "horizontal" || mode === "vertical" ? 3 : 2)
                }
                onClick={() =>
                  perform(() => onChange(alignText(page, runs, selected, mode)))
                }
              >
                {mode === "horizontal" || mode === "vertical"
                  ? `Distribute ${mode}`
                  : `Align ${mode}`}
              </button>
            ))}
          </div>
        </fieldset>
      </details>
      {paragraph && (
        <details>
          <summary>Paragraph & font formatting</summary>
          <fieldset disabled={disabled}>
            <p className="hint">
              Joining preserves positions. Apply reflow explicitly replaces the
              selected text with a wrapping paragraph in your chosen font.
            </p>
            <label>
              Paragraph text
              <textarea
                aria-label="Paragraph text"
                rows={5}
                value={paragraph.text}
                onChange={(e) => update({ text: e.target.value })}
              />
            </label>
            <label>
              Replacement font
              <select
                aria-label="Paragraph font"
                value={paragraph.font}
                onChange={(e) =>
                  update({ font: e.target.value as Paragraph["font"] })
                }
              >
                {textFonts.map((font) => (
                  <option key={font}>{font}</option>
                ))}
              </select>
            </label>
            <details className="style-library">
              <summary>Saved text styles</summary>
              <label>
                Style
                <select
                  aria-label="Saved text style"
                  value={styleId}
                  onChange={(e) => {
                    setStyleId(e.target.value);
                    const style =
                      e.target.value === "last"
                        ? library.last
                        : library.styles.find((s) => s.id === e.target.value);
                    if (
                      style &&
                      "name" in style &&
                      typeof style.name === "string"
                    )
                      setStyleName(style.name);
                    if (style)
                      update({
                        font: style.font,
                        size: style.size,
                        color: style.color,
                        lineHeight: style.lineHeight,
                      });
                  }}
                >
                  <option value="">Current settings</option>
                  <option value="last">Last used style</option>
                  {library.styles.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Style name
                <input
                  aria-label="Text style name"
                  value={styleName}
                  onChange={(e) => setStyleName(e.target.value)}
                />
              </label>
              <button
                onClick={() =>
                  perform(() => library.save(styleName, paragraph))
                }
              >
                Save text style
              </button>
              <button
                disabled={!library.styles.some((s) => s.id === styleId)}
                onClick={() =>
                  perform(() => {
                    library.remove(styleId);
                    setStyleId("");
                  })
                }
              >
                Delete text style
              </button>
            </details>
            <div className="form-grid">
              <label>
                Size
                <input
                  aria-label="Paragraph font size"
                  type="number"
                  min="1"
                  max="300"
                  value={paragraph.size}
                  onChange={(e) => update({ size: Number(e.target.value) })}
                />
              </label>
              <label>
                Width
                <input
                  aria-label="Paragraph width"
                  type="number"
                  min="1"
                  value={paragraph.width}
                  onChange={(e) => update({ width: Number(e.target.value) })}
                />
              </label>
              <label>
                Line spacing
                <input
                  aria-label="Paragraph line spacing"
                  type="number"
                  min="0.5"
                  max="5"
                  step="0.1"
                  value={paragraph.lineHeight}
                  onChange={(e) =>
                    update({ lineHeight: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Colour
                <input
                  aria-label="Paragraph colour"
                  type="color"
                  value={paragraph.color}
                  onChange={(e) => update({ color: e.target.value })}
                />
              </label>
            </div>
            <label>
              Alignment
              <select
                aria-label="Paragraph alignment"
                value={paragraph.align}
                onChange={(e) =>
                  update({ align: e.target.value as Paragraph["align"] })
                }
              >
                <option value="left">Left</option>
                <option value="center">Centre</option>
                <option value="right">Right</option>
              </select>
            </label>
            <p className="hint">
              Helvetica, Times and Courier provide regular, bold and italic
              faces. Replacement fonts support Latin text. Keep the original
              font for other available glyphs.
            </p>
            <button
              onClick={() => {
                try {
                  const lines = layoutParagraph(paragraph);
                  setPreview(
                    `${lines.length} lines · ${Math.round(lines.length * paragraph.size * paragraph.lineHeight)} points high`,
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Preview line count
            </button>
            <button
              className="primary"
              onClick={() =>
                perform(() => {
                  const next = reflowSelection(
                    page,
                    runs,
                    selected,
                    paragraph,
                    () => crypto.randomUUID(),
                  );
                  onChange(next, next.paragraphs?.at(-1)?.groupId);
                  try {
                    library.setLast(paragraph);
                  } catch {
                    /* Document edits remain available if preferences cannot be saved. */
                  }
                })
              }
            >
              Apply paragraph reflow
            </button>
          </fieldset>
        </details>
      )}
      {error && (
        <p role="status" className="edit-error">
          {error}
        </p>
      )}
      {preview && !error && (
        <p role="status" className="hint">
          {preview}
        </p>
      )}
    </div>
  );
}
