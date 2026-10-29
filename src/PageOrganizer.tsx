import { useEffect, useRef, useState } from "react";
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import type { Source, EditorPage } from "./pdf";
import { exportPagePreview } from "./pdf";
import { duplicatePages, reorderPages, rotatePages } from "./page-operations";
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
  onChange,
  onOpen,
  onInsert,
  onExtract,
  onClose,
}: {
  pages: EditorPage[];
  sources: Source[];
  onChange: (pages: EditorPage[]) => void;
  onOpen: (id: string) => void;
  onInsert: () => void;
  onExtract: (pages: EditorPage[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState("");
  const dragging = useRef<string[]>([]);
  const pointerDrag = useRef<{ ids: string[]; x: number; y: number } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const valid = selected.filter((id) => pages.some((p) => p.id === id));
  return (
    <div className="dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Page organiser"
        className="workspace-dialog organiser"
      >
        <div className="panel-title">
          Organise pages <small>{pages.length} pages</small>
          <button onClick={onClose} aria-label="Close page organiser">
            ×
          </button>
        </div>
        <p>
          Drag a page’s grip to move the selected thumbnails before another
          page. Open several PDFs to merge them into this document.
        </p>
        <div className="organiser-actions button-wrap">
          <button onClick={() => setSelected(pages.map((p) => p.id))}>
            Select all pages
          </button>
          <button onClick={() => setSelected([])}>Clear selection</button>
          <button onClick={onInsert}>Insert PDFs</button>
          <button
            disabled={!valid.length}
            onClick={() => onChange(rotatePages(pages, valid))}
          >
            Rotate 90°
          </button>
          <button
            disabled={!valid.length}
            onClick={() =>
              onChange(duplicatePages(pages, valid, () => crypto.randomUUID()))
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
        {error && <p role="alert">{error}</p>}
        <div className="page-grid">
          {pages.map((page, index) => (
            <article
              className={`page-card ${valid.includes(page.id) ? "selected-card" : ""} ${dropTarget === page.id ? "drop-target" : ""}`}
              key={page.id}
              data-page-id={page.id}
              draggable
              onDragStart={(e) => {
                dragging.current = valid.includes(page.id) ? valid : [page.id];
                e.dataTransfer.setData("text/plain", page.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange(reorderPages(pages, dragging.current, page.id));
                dragging.current = [];
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
                      ?.closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
                    setDropTarget(target ?? null);
                  }}
                  onPointerUp={(event) => {
                    const drag = pointerDrag.current;
                    pointerDrag.current = null;
                    setDropTarget(null);
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
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
                      ?.closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
                    if (target) onChange(reorderPages(pages, drag.ids, target));
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
      </section>
    </div>
  );
}
