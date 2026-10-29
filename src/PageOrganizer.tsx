import { useEffect, useRef, useState } from "react";
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import type { Source, EditorPage } from "./pdf";
import { exportPagePreview } from "./pdf";
import {
  duplicatePages,
  reorderPages,
  rotatePages,
  movePagesTo,
} from "./page-operations";
import { parsePageRange } from "./page-extras";
function Thumbnail({ source, page }: { source: Source; page: EditorPage }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    [visible, setVisible] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    let render: RenderTask | undefined;
    void (async () => {
      const data = await exportPagePreview(source, page, true);
      if (cancelled) return;
      task = getDocument({
        data,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        wasmUrl: "/pdfjs/wasm/",
      });
      const document = await task.promise,
        pdf = await document.getPage(1);
      if (cancelled || !canvas.current) return;
      const original = pdf.getViewport({ scale: 1 }),
        view = pdf.getViewport({
          scale: 160 / Math.max(original.width, original.height),
        });
      canvas.current.width = Math.ceil(view.width);
      canvas.current.height = Math.ceil(view.height);
      render = pdf.render({ canvas: canvas.current, viewport: view });
      await render.promise;
    })().catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      render?.cancel();
      void task?.destroy();
    };
  }, [visible, source, page]);
  return (
    <div className="thumbnail">
      <canvas ref={canvas} aria-label="Page thumbnail" />
      {error && <small>Preview unavailable</small>}
    </div>
  );
}
export function PageOrganizer({
  pages,
  sources,
  busy,
  importError,
  onChange,
  onOpen,
  onInsert,
  onFiles,
  onExport,
  onExtract,
  onClose,
}: {
  pages: EditorPage[];
  sources: Source[];
  busy: boolean;
  importError: string;
  onChange: (pages: EditorPage[]) => void;
  onOpen: (id: string) => void;
  onInsert: (position: number) => void;
  onFiles: (files: File[], position: number) => void;
  onExport: () => void;
  onExtract: (pages: EditorPage[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [range, setRange] = useState(""),
    [destination, setDestination] = useState("end");
  const dragging = useRef<string[]>([]);
  const pointerDrag = useRef<{ ids: string[]; x: number; y: number } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const valid = selected.filter((id) => pages.some((p) => p.id === id));
  const usedSources = sources.filter((s) =>
    pages.some((p) => p.sourceId === s.id),
  );
  const insertion =
    destination === "start"
      ? 0
      : destination === "end"
        ? pages.length
        : pages.findIndex((p) => p.id === destination);
  const position = insertion < 0 ? pages.length : insertion;
  function dropPages(target: string) {
    onChange(
      target === "end"
        ? movePagesTo(pages, dragging.current, pages.length)
        : reorderPages(pages, dragging.current, target),
    );
    dragging.current = [];
    setDropTarget(null);
  }
  return (
    <div className="dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Page organiser"
        className="workspace-dialog organiser"
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onFiles(Array.from(e.dataTransfer.files), position);
        }}
      >
        <div className="panel-title">
          Combine & organise{" "}
          <small>
            {pages.length} pages · {usedSources.length} files
          </small>
          <button
            disabled={busy}
            onClick={onClose}
            aria-label="Close page organiser"
          >
            ×
          </button>
        </div>
        <p>
          Add one or more PDFs, then choose and arrange the pages for one final
          file. Drag page grips to reorder a selection. Drop PDF files onto a
          thumbnail to insert before it. Changes can be undone after closing
          this view; source files stay unchanged.
        </p>
        <fieldset className="organiser-controls" disabled={busy}>
          <div className="organiser-actions button-wrap">
            <button onClick={() => onInsert(position)}>Add PDF files</button>
            <button disabled={!pages.length} onClick={onExport}>
              Export combined PDF
            </button>
            <button onClick={() => setSelected(pages.map((p) => p.id))}>
              Select all pages
            </button>
            <button onClick={() => setSelected([])}>Clear selection</button>
            <button
              disabled={!valid.length}
              onClick={() => onChange(rotatePages(pages, valid))}
            >
              Rotate 90°
            </button>
            <button
              disabled={!valid.length}
              onClick={() =>
                onChange(
                  duplicatePages(pages, valid, () => crypto.randomUUID()),
                )
              }
            >
              Duplicate pages
            </button>
            <button
              disabled={!valid.length}
              onClick={() =>
                void onExtract(pages.filter((p) => valid.includes(p.id))).catch(
                  (e) => setError(String(e)),
                )
              }
            >
              Extract selected
            </button>
            <button
              disabled={!valid.length}
              onClick={() => {
                onChange(pages.filter((p) => !valid.includes(p.id)));
                setSelected([]);
              }}
            >
              Remove pages
            </button>
          </div>
          <div className="organiser-options">
            <label>
              Insert / move to
              <select
                aria-label="Page insertion position"
                value={insertion < 0 ? "end" : destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="start">Beginning of document</option>
                <option value="end">End of document</option>
                {pages.map((p, i) => (
                  <option key={p.id} value={p.id}>
                    Before page {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!valid.length}
              onClick={() => onChange(movePagesTo(pages, valid, position))}
            >
              Move selected here
            </button>
            <label>
              Select pages from file
              <select
                aria-label="Select pages from file"
                value=""
                onChange={(e) =>
                  setSelected(
                    pages
                      .filter((p) => p.sourceId === e.target.value)
                      .map((p) => p.id),
                  )
                }
              >
                <option value="" disabled>
                  Choose a source PDF…
                </option>
                {usedSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({pages.filter((p) => p.sourceId === s.id).length}{" "}
                    {pages.filter((p) => p.sourceId === s.id).length === 1
                      ? "page"
                      : "pages"}
                    )
                  </option>
                ))}
              </select>
            </label>
            <label>
              Page range in final document
              <input
                aria-label="Select page range"
                placeholder="e.g. 1–3, 7"
                value={range}
                onChange={(e) => setRange(e.target.value)}
              />
            </label>
            <button
              disabled={!pages.length}
              onClick={() => {
                try {
                  setSelected(
                    parsePageRange(range, pages.length).map((i) => pages[i].id),
                  );
                  setError("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Select range
            </button>
          </div>
          <div className="button-wrap">
            <button
              disabled={!valid.length}
              onClick={() =>
                onChange([
                  ...pages.filter((p) => valid.includes(p.id)),
                  ...pages.filter((p) => !valid.includes(p.id)),
                ])
              }
            >
              Move to beginning
            </button>
            <button
              disabled={!valid.length}
              onClick={() =>
                onChange([
                  ...pages.filter((p) => !valid.includes(p.id)),
                  ...pages.filter((p) => valid.includes(p.id)),
                ])
              }
            >
              Move to end
            </button>
            <span>{valid.length} selected</span>
          </div>
          {busy && <p role="status">Opening PDF files…</p>}
          {error && <p role="alert">{error}</p>}
          {importError && <p role="alert">{importError}</p>}
          {!pages.length && (
            <p className="organiser-empty">
              Add PDF files or drop them here to start building your document.
            </p>
          )}
          <div className="page-grid">
            {pages.map((page, index) => (
              <article
                className={`page-card ${valid.includes(page.id) ? "selected-card" : ""} ${dropTarget === page.id ? "drop-target" : ""}`}
                key={page.id}
                data-page-id={page.id}
                draggable={!busy}
                onDragStart={(e) => {
                  dragging.current = valid.includes(page.id)
                    ? valid
                    : [page.id];
                  e.dataTransfer.setData("text/plain", page.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTarget(page.id);
                }}
                onDragEnd={() => {
                  dragging.current = [];
                  setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (busy) return;
                  if (e.dataTransfer.files.length)
                    onFiles(Array.from(e.dataTransfer.files), index);
                  else dropPages(page.id);
                }}
              >
                <label>
                  <input
                    aria-label={`Select page ${index + 1}`}
                    type="checkbox"
                    checked={valid.includes(page.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...valid, page.id]
                          : valid.filter((id) => id !== page.id),
                      )
                    }
                  />
                  Page {index + 1}
                  <button
                    type="button"
                    className="page-grip"
                    aria-label={`Drag page ${index + 1}`}
                    title="Drag to reorder selected pages"
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.stopPropagation();
                      pointerDrag.current = {
                        ids: valid.includes(page.id) ? valid : [page.id],
                        x: event.clientX,
                        y: event.clientY,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!pointerDrag.current) return;
                      const target = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>("[data-page-id]")
                        ?.dataset.pageId;
                      setDropTarget(target ?? null);
                    }}
                    onPointerUp={(event) => {
                      const drag = pointerDrag.current;
                      pointerDrag.current = null;
                      setDropTarget(null);
                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      )
                        event.currentTarget.releasePointerCapture(
                          event.pointerId,
                        );
                      if (
                        !drag ||
                        Math.hypot(
                          event.clientX - drag.x,
                          event.clientY - drag.y,
                        ) < 8
                      )
                        return;
                      const target = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>("[data-page-id]")
                        ?.dataset.pageId;
                      if (target)
                        onChange(
                          target === "end"
                            ? movePagesTo(pages, drag.ids, pages.length)
                            : reorderPages(pages, drag.ids, target),
                        );
                    }}
                    onPointerCancel={() => {
                      pointerDrag.current = null;
                      setDropTarget(null);
                    }}
                    onLostPointerCapture={() => {
                      pointerDrag.current = null;
                      setDropTarget(null);
                    }}
                  >
                    ⠿
                  </button>
                </label>
                <button
                  aria-label={`Open page ${index + 1}`}
                  onClick={() => {
                    onOpen(page.id);
                    onClose();
                  }}
                >
                  <Thumbnail
                    page={page}
                    source={sources.find((s) => s.id === page.sourceId)!}
                  />
                </button>
                <small>
                  {sources.find((s) => s.id === page.sourceId)?.name} · source
                  page {page.index + 1}
                  {page.rotation ? ` · ${page.rotation}°` : ""}
                </small>
              </article>
            ))}
          </div>
          {!!pages.length && (
            <div
              className={`page-drop-end ${dropTarget === "end" ? "drop-target" : ""}`}
              data-page-id="end"
              onDragOver={(e) => {
                e.preventDefault();
                setDropTarget("end");
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (busy) return;
                if (e.dataTransfer.files.length)
                  onFiles(Array.from(e.dataTransfer.files), pages.length);
                else dropPages("end");
              }}
            >
              Drop pages or PDFs here to append to the end
            </div>
          )}
        </fieldset>
      </section>
    </div>
  );
}
