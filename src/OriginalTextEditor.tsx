import { useState } from "react";
import {
  X,
  Combine,
  Ungroup,
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import type { EditorPage } from "./pdf";
import type { TextBox } from "./text-boxes";
import type { TextReplacement } from "./text-edit";

export function OriginalTextEditor({
  page,
  boxes,
  loading,
  error,
  selected,
  onSelect,
  onJoin,
  onUngroup,
  onMove,
  onApply,
  onClose,
}: {
  page: EditorPage;
  boxes: TextBox[];
  loading: boolean;
  error: string;
  selected: string[];
  onSelect: (id: string | null, extend?: boolean) => void;
  onJoin: () => void;
  onUngroup: () => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
  onApply: (edits: TextReplacement[]) => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftError, setDraftError] = useState("");
  const selection = boxes.filter((box) => selected.includes(box.id));
  const canMove =
    selection.length > 0 &&
    selection.every((box) => box.runs.every((run) => run.geometry));
  return (
    <aside className="inspector text-editor">
      <div className="panel-title">
        Edit & arrange text
        <button aria-label="Close text editor" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <p>
        Drag a box on the page to move it. Shift-click or tick boxes to select
        more than one, then join them.
      </p>
      <div className="text-group-controls">
        <span>
          {selection.length} {selection.length === 1 ? "box" : "boxes"} selected
        </span>
        <div>
          <button onClick={onJoin} disabled={selection.length < 2 || !canMove}>
            <Combine size={15} />
            Join boxes
          </button>
          <button
            onClick={onUngroup}
            disabled={!selection.some((box) => box.joined)}
          >
            <Ungroup size={15} />
            Ungroup
          </button>
        </div>
        <div className="text-nudge">
          {[
            { label: "Move text left", dx: -1, dy: 0, icon: ArrowLeft },
            { label: "Move text up", dx: 0, dy: 1, icon: ArrowUp },
            { label: "Move text down", dx: 0, dy: -1, icon: ArrowDown },
            { label: "Move text right", dx: 1, dy: 0, icon: ArrowRight },
          ].map((item) => (
            <button
              key={item.label}
              aria-label={item.label}
              disabled={!canMove}
              onClick={() => onMove(selected, item.dx, item.dy)}
            >
              <item.icon size={15} />
            </button>
          ))}
          <small>1 PDF point per click</small>
        </div>
        <small>
          Joining keeps every letter in place. Joined pieces move together and
          keep their individual fonts.
        </small>
      </div>
      {(error || draftError) && (
        <p role="alert" className="edit-error">
          {draftError || error}
        </p>
      )}
      {loading && <p>Reading original text…</p>}
      {!loading && !boxes.length && (
        <p>
          No supported original text was found. Scans and some font encodings
          need further support.
        </p>
      )}
      {boxes.map((box, index) => {
        const current = (runId: string, original: string) =>
          page.textReplacements?.find((edit) => edit.runId === runId)
            ?.replacement ?? original;
        const dirty = box.runs.some(
          (run) =>
            (drafts[run.id] ?? current(run.id, run.text)) !==
            current(run.id, run.text),
        );
        return (
          <form
            key={box.id}
            className={`text-run ${selected.includes(box.id) ? "selected-box" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              const edits: TextReplacement[] = [];
              for (const run of box.runs) {
                const value = drafts[run.id] ?? current(run.id, run.text);
                const missing = Array.from(value).find(
                  (character) => !run.characters.includes(character),
                );
                if (missing) {
                  setDraftError(
                    `The original font does not contain “${missing}”. Try other text.`,
                  );
                  return;
                }
                if (value !== current(run.id, run.text))
                  edits.push({
                    runId: run.id,
                    original: run.text,
                    replacement: value,
                  });
              }
              setDraftError("");
              if (edits.length) onApply(edits);
            }}
          >
            <label className="text-box-heading">
              <input
                type="checkbox"
                aria-label={`Select text box ${index + 1}`}
                checked={selected.includes(box.id)}
                onChange={() => onSelect(box.id, true)}
              />
              <span>
                {box.joined ? "Joined text box" : "Text box"} {index + 1}
              </span>
              {box.joined && <small>{box.runs.length} pieces</small>}
            </label>
            {box.runs.map((run, part) => (
              <label key={run.id}>
                {box.joined && <span>Part {part + 1}</span>}
                <input
                  aria-label={`Text box ${index + 1}${box.joined ? ` part ${part + 1}` : ""}`}
                  value={drafts[run.id] ?? current(run.id, run.text)}
                  maxLength={1000}
                  onChange={(event) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [run.id]: event.target.value,
                    }))
                  }
                />
                <small title={run.font}>{run.font}</small>
              </label>
            ))}
            {!box.points.length && (
              <small>
                Text can be edited here; its position cannot yet be moved.
              </small>
            )}
            <button disabled={!dirty}>Apply change</button>
          </form>
        );
      })}
    </aside>
  );
}
