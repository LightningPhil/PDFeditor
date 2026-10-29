import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Combine,
  Ungroup,
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  AlignLeft,
} from "lucide-react";
import type { EditorPage } from "./pdf";
import type { TextBox } from "./text-boxes";
import type { TextReplacement } from "./text-edit";

export function OriginalTextEditor({
  page,
  boxes,
  loading,
  busy,
  positionReady,
  error,
  selected,
  onSelect,
  onJoin,
  onSelectLine,
  canSelectLine,
  onUngroup,
  onMove,
  onApply,
  onClose,
}: {
  page: EditorPage;
  boxes: TextBox[];
  loading: boolean;
  busy: boolean;
  positionReady: boolean;
  error: string;
  selected: string[];
  onSelect: (id: string | null, extend?: boolean) => void;
  onJoin: () => void;
  onSelectLine: () => void;
  canSelectLine: boolean;
  onUngroup: () => void;
  onMove: (ids: string[], dx: number, dy: number) => void;
  onApply: (edits: TextReplacement[]) => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftError, setDraftError] = useState("");
  const values = useMemo(() => {
    const replacements = new Map(
      (page.textReplacements ?? []).map((edit) => [
        edit.runId,
        edit.replacement,
      ]),
    );
    return new Map(
      boxes.flatMap((box) =>
        box.runs.map(
          (run) => [run.id, replacements.get(run.id) ?? run.text] as const,
        ),
      ),
    );
  }, [boxes, page.textReplacements]);
  const previousValues = useRef(values);
  useEffect(() => {
    const previous = previousValues.current;
    previousValues.current = values;
    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(
          ([id]) => values.has(id) && previous.get(id) === values.get(id),
        ),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  }, [values]);
  const pending = boxes
    .flatMap((box) => box.runs)
    .filter(
      (run) =>
        drafts[run.id] !== undefined && drafts[run.id] !== values.get(run.id),
    );
  function apply(runs: TextBox["runs"]) {
    const edits: TextReplacement[] = [];
    for (const run of runs) {
      const value = drafts[run.id] ?? values.get(run.id) ?? run.text;
      if (value === values.get(run.id)) continue;
      const missing = Array.from(value).find(
        (character) => !run.characters.includes(character),
      );
      if (missing) {
        setDraftError(
          `The original font does not contain “${missing}”. Try other text.`,
        );
        return;
      }
      edits.push({ runId: run.id, original: run.text, replacement: value });
    }
    if (!edits.length) return;
    try {
      onApply(edits);
      const changed = new Set(edits.map((edit) => edit.runId));
      setDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !changed.has(id)),
        ),
      );
      setDraftError("");
    } catch (cause) {
      setDraftError(String(cause));
    }
  }
  const selectedIds = new Set(selected);
  const selection = boxes.filter((box) => selectedIds.has(box.id));
  const canMove = selection.length > 0 && selection.every((box) => box.movable);
  return (
    <aside className="inspector text-editor" aria-busy={busy || loading}>
      <div className="panel-title">
        Edit & arrange text
        <button aria-label="Close text editor" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <fieldset className="text-editor-controls" disabled={busy}>
        <p>
          Drag text or its outline to move it. Drag empty page space to select
          several boxes, or select one and choose Select line.
        </p>
        <div className="text-group-controls">
          <span>
            {selection.length} {selection.length === 1 ? "box" : "boxes"}{" "}
            selected
          </span>
          <div>
            <button onClick={onSelectLine} disabled={!canSelectLine || loading}>
              <AlignLeft size={15} />
              Select line
            </button>
            <button
              onClick={onJoin}
              disabled={
                selection.length < 2 || !canMove || !!pending.length || loading
              }
            >
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
                disabled={!canMove || !positionReady}
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
          {!!pending.length && (
            <div className="pending-text">
              <span>
                {pending.length} unapplied text{" "}
                {pending.length === 1 ? "change" : "changes"}. Apply or discard
                before joining.
              </span>
              <div>
                <button onClick={() => apply(pending)}>Apply all</button>
                <button
                  onClick={() => {
                    setDrafts({});
                    setDraftError("");
                  }}
                >
                  Discard changes
                </button>
              </div>
            </div>
          )}
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
            values.get(runId) ?? original;
          const dirty = box.runs.some(
            (run) =>
              (drafts[run.id] ?? current(run.id, run.text)) !==
              current(run.id, run.text),
          );
          return (
            <form
              key={box.id}
              className={`text-run ${selectedIds.has(box.id) ? "selected-box" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                apply(box.runs);
              }}
            >
              <label className="text-box-heading">
                <input
                  type="checkbox"
                  aria-label={`Select text box ${index + 1}`}
                  checked={selectedIds.has(box.id)}
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
      </fieldset>
    </aside>
  );
}
