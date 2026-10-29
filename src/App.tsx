import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FilePlus2,
  FileText,
  MousePointer2,
  Plus,
  Redo2,
  ScanText,
  ShieldCheck,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { exportPdf } from "./pdf";
import type { Annotation, EditorPage, Source } from "./pdf";
import { inspectEditableText } from "./text-edit";
import type { EditableRun, TextReplacement } from "./text-edit";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;
type Tool = "select" | "text" | "rectangle" | "inspect" | "edit";
type LoadedSource = Source & {
  document: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
};
const uid = () => crypto.randomUUID();

function PageView({
  source,
  page,
  tool,
  color,
  text,
  onAdd,
  onInspect,
  onError,
}: {
  source: LoadedSource;
  page: EditorPage;
  tool: Tool;
  color: string;
  text: string;
  onAdd: (annotation: Annotation) => void;
  onInspect: (text: string) => void;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 595, height: 842 });
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let previewTask: PDFDocumentLoadingTask | undefined;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    setReady(false);
    void (async () => {
      if (!page.textReplacements?.length)
        return source.document.getPage(page.index + 1);
      const data = await exportPdf([source], [{ ...page, annotations: [] }]);
      if (cancelled) return null;
      previewTask = getDocument({
        data,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        wasmUrl: "/pdfjs/wasm/",
      });
      const document = await previewTask.promise;
      return document.getPage(1);
    })()
      .then(async (pdfPage) => {
        if (cancelled || !canvas.current || !pdfPage) return;
        const view = pdfPage.getViewport({ scale: 1 });
        setSize({ width: view.width, height: view.height });
        // Non-zero crop origins and rotated pages need explicit coordinate conversion.
        setSupported(
          pdfPage.rotate === 0 &&
            pdfPage.view[0] === 0 &&
            pdfPage.view[1] === 0 &&
            pdfPage.userUnit === 1,
        );
        const scale = Math.min(window.devicePixelRatio || 1, 2) * 1.4;
        const target = canvas.current;
        const renderView = pdfPage.getViewport({ scale });
        target.width = renderView.width;
        target.height = renderView.height;
        render = pdfPage.render({ canvas: target, viewport: renderView });
        await render.promise;
        if (!cancelled) setReady(true);
      })
      .catch((error) => {
        if (!cancelled) onError(String(error));
      });
    return () => {
      cancelled = true;
      render?.cancel();
      void previewTask?.destroy();
    };
  }, [source, page.id, page.index, page.textReplacements, onError]);

  function point(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * size.width,
      y: ((event.clientY - bounds.top) / bounds.height) * size.height,
    };
  }
  async function inspect() {
    try {
      const pdfPage = await source.document.getPage(page.index + 1);
      const content = await pdfPage.getTextContent();
      onInspect(
        content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join(""),
      );
    } catch (error) {
      onError(String(error));
    }
  }
  return (
    <div
      className="paper"
      style={{ aspectRatio: `${size.width}/${size.height}` }}
    >
      <canvas ref={canvas} />
      {!ready && <div className="rendering">Rendering page…</div>}
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        className={`annotation-layer tool-${tool}`}
        onPointerDown={(event) => {
          if (!ready) return;
          if (tool === "inspect") {
            void inspect();
            return;
          }
          if (!supported || tool === "select" || tool === "edit") return;
          const p = point(event);
          if (tool === "text" && text.trim())
            onAdd({
              id: uid(),
              kind: "text",
              x: p.x,
              y: size.height - p.y,
              text,
              color,
              size: 16,
            });
          if (tool === "rectangle") {
            event.currentTarget.setPointerCapture(event.pointerId);
            setStart(p);
          }
        }}
        onPointerCancel={() => setStart(null)}
        onPointerUp={(event) => {
          if (!start) return;
          const end = point(event);
          if (Math.abs(end.x - start.x) > 3 && Math.abs(end.y - start.y) > 3)
            onAdd({
              id: uid(),
              kind: "rectangle",
              x: Math.min(start.x, end.x),
              y: size.height - Math.max(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
              color,
            });
          setStart(null);
        }}
      >
        {page.annotations.map((a) =>
          a.kind === "text" ? (
            <text
              key={a.id}
              x={a.x}
              y={size.height - a.y}
              fill={a.color}
              fontSize={a.size}
              fontFamily="Helvetica, Arial, sans-serif"
            >
              {a.text}
            </text>
          ) : (
            <rect
              key={a.id}
              x={a.x}
              y={size.height - a.y - a.height}
              width={a.width}
              height={a.height}
              stroke={a.color}
              strokeWidth="2"
              fill="none"
            />
          ),
        )}
      </svg>
      {!supported &&
        tool !== "select" &&
        tool !== "inspect" &&
        tool !== "edit" && (
          <div className="page-notice">
            Annotations on rotated or cropped pages are coming next.
          </div>
        )}
    </div>
  );
}

function OriginalTextEditor({
  source,
  page,
  onApply,
  onClose,
}: {
  source: Source;
  page: EditorPage;
  onApply: (edit: TextReplacement) => void;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<EditableRun[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void inspectEditableText(source.bytes, page.index)
      .then((result) => {
        if (!cancelled) setRuns(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [source, page.index]);
  return (
    <aside className="inspector text-editor">
      <div className="panel-title">
        Edit original text
        <button aria-label="Close text editor" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <p>
        Change a supported text run below. The original font, colour and
        position stay in place. Text does not reflow; keep changes within the
        available space.
      </p>
      {error && (
        <p role="alert" className="edit-error">
          {error}
        </p>
      )}
      {runs === null && !error && <p>Reading original text…</p>}
      {runs?.length === 0 && (
        <p>
          No supported text runs on this page yet. Scans, composite fonts and
          text split across several drawing commands need further support.
        </p>
      )}
      {runs?.map((run, index) => {
        const current =
          page.textReplacements?.find((edit) => edit.runId === run.id)
            ?.replacement ?? run.text;
        const draft = drafts[run.id] ?? current;
        return (
          <form
            key={run.id}
            className="text-run"
            onSubmit={(event) => {
              event.preventDefault();
              const missing = Array.from(draft).find(
                (character) => !run.characters.includes(character),
              );
              if (missing) {
                setError(
                  `The original font does not contain “${missing}”. Try other text.`,
                );
                return;
              }
              setError("");
              onApply({
                runId: run.id,
                original: run.text,
                replacement: draft,
              });
            }}
          >
            <label>
              Text {index + 1}
              <input
                aria-label={`Original text ${index + 1}`}
                value={draft}
                maxLength={1000}
                onChange={(event) =>
                  setDrafts((previous) => ({
                    ...previous,
                    [run.id]: event.target.value,
                  }))
                }
              />
            </label>
            <small title={run.font}>{run.font}</small>
            <button disabled={draft === current}>Apply change</button>
          </form>
        );
      })}
    </aside>
  );
}

export default function App() {
  const [sources, setSources] = useState<LoadedSource[]>([]);
  const [history, setHistory] = useState<EditorPage[][]>([[]]);
  const [cursor, setCursor] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#297768");
  const [text, setText] = useState("Your text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inspection, setInspection] = useState<string | null>(null);
  const [zoom, setZoom] = useState(85);
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const tasks = useRef<PDFDocumentLoadingTask[]>([]);
  useEffect(
    () => () => {
      tasks.current.forEach((task) => {
        void task.destroy();
      });
    },
    [],
  );
  const pages = history[cursor];
  const active = pages.find((page) => page.id === activeId) ?? pages[0];
  const source = sources.find((item) => item.id === active?.sourceId);
  const activeIndex = pages.findIndex((page) => page.id === active?.id);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pages.length) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pages.length]);
  function commit(next: EditorPage[]) {
    setHistory((previous) => [...previous.slice(0, cursor + 1), next]);
    setCursor(cursor + 1);
  }
  async function importFiles(files: File[]) {
    if (!files.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const loaded: LoadedSource[] = [];
    try {
      const added: EditorPage[] = [];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".pdf"))
          throw new Error("Please choose PDF files.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const task = getDocument({
          data: bytes.slice(),
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          wasmUrl: "/pdfjs/wasm/",
        });
        tasks.current.push(task);
        const document = await task.promise;
        const item = { id: uid(), name: file.name, bytes, document, task };
        loaded.push(item);
        for (let index = 0; index < document.numPages; index++)
          added.push({ id: uid(), sourceId: item.id, index, annotations: [] });
      }
      if (!added.length) throw new Error("This PDF has no pages.");
      setSources((previous) => [...previous, ...loaded]);
      const insertion = active ? activeIndex + 1 : pages.length;
      commit([
        ...pages.slice(0, insertion),
        ...added,
        ...pages.slice(insertion),
      ]);
      setActiveId(added[0].id);
    } catch (cause) {
      loaded.forEach((item) => {
        void item.task.destroy();
      });
      setError(
        `Could not open PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  function move(direction: number) {
    const destination = activeIndex + direction;
    if (!active || destination < 0 || destination >= pages.length) return;
    const next = [...pages];
    [next[activeIndex], next[destination]] = [
      next[destination],
      next[activeIndex],
    ];
    commit(next);
  }
  async function download() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const bytes = await exportPdf(sources, pages);
      const url = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: "application/pdf",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sources[0]?.name.replace(/\.pdf$/i, "") || "document"}-edited.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (cause) {
      setError(
        `Could not export: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const tools = [
    { id: "edit", label: "Edit text", icon: ScanText },
    { id: "select", label: "Select", icon: MousePointer2 },
    { id: "text", label: "Add text", icon: Type },
    { id: "rectangle", label: "Rectangle", icon: Square },
    { id: "inspect", label: "Inspect text", icon: ScanText },
  ] as const;
  return (
    <div
      className="app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(event) => {
          void importFiles(Array.from(event.target.files ?? []));
        }}
      />
      <header>
        <div className="brand">
          <span className="brand-icon">
            <FileText size={22} />
          </span>
          PDF<span>editor</span>
          <small>WORKSPACE</small>
        </div>
        <div className="privacy">
          <ShieldCheck size={15} /> Files stay on your device
        </div>
        <button
          className="primary"
          disabled={!pages.length || busy}
          onClick={() => void download()}
        >
          <Download size={16} /> Export PDF
        </button>
      </header>
      <div className="workspace-bar">
        <div>
          <span className="status-dot" />{" "}
          {sources[0]?.name ?? "Your next great edit"}
          <span className="muted">
            {pages.length
              ? `${pages.length} pages · Browser session`
              : "A little less friction. A lot more freedom."}
          </span>
        </div>
        <div className="history-controls">
          <button
            aria-label="Undo"
            disabled={!cursor || busy}
            onClick={() => setCursor(cursor - 1)}
          >
            <Undo2 size={18} />
          </button>
          <button
            aria-label="Redo"
            disabled={cursor === history.length - 1 || busy}
            onClick={() => setCursor(cursor + 1)}
          >
            <Redo2 size={18} />
          </button>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      <main>
        <aside className="pages-panel">
          <div className="panel-title">
            Pages <span>{pages.length.toString().padStart(2, "0")}</span>
          </div>
          <button
            className="insert"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Plus size={16} />{" "}
            {pages.length ? "Insert PDF after page" : "Open a PDF"}
          </button>
          {!pages.length && (
            <div className="empty-pages">
              <FileText size={30} />
              <p>A place for every page.</p>
              <small>Your pages will appear here.</small>
            </div>
          )}
          <div className="page-list">
            {pages.map((page, index) => (
              <button
                key={page.id}
                disabled={busy}
                className={`page-item ${active?.id === page.id ? "active" : ""}`}
                onClick={() => {
                  setActiveId(page.id);
                  setInspection(null);
                }}
              >
                <span className="mini-paper">
                  <FileText size={30} />
                  <small>{page.index + 1}</small>
                </span>
                <span>
                  <strong>Page {index + 1}</strong>
                  <small>
                    {sources.find((item) => item.id === page.sourceId)?.name}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {!!pages.length && (
            <div className="page-actions">
              <button
                aria-label="Move page earlier"
                disabled={busy || activeIndex <= 0}
                onClick={() => move(-1)}
              >
                <ArrowUp size={17} />
              </button>
              <button
                aria-label="Move page later"
                disabled={busy || activeIndex === pages.length - 1}
                onClick={() => move(1)}
              >
                <ArrowDown size={17} />
              </button>
              <button
                aria-label="Remove selected page"
                disabled={busy}
                onClick={() =>
                  commit(pages.filter((page) => page.id !== active?.id))
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
          )}
          <div className="local-note">
            <ShieldCheck size={16} />
            <span>
              Private by design.
              <br />
              <small>No uploads. No account.</small>
            </span>
          </div>
        </aside>
        <section className="editor">
          <nav className="toolbar" aria-label="Editing tools">
            {tools.map((item) => (
              <button
                key={item.id}
                className={tool === item.id ? "selected" : ""}
                disabled={!active || busy}
                onClick={() => {
                  setTool(item.id);
                  setInspection(null);
                }}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
              </button>
            ))}
            <div className="toolbar-divider" />
            <select
              aria-label="Page zoom"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            >
              {[60, 85, 100, 125].map((value) => (
                <option key={value} value={value}>
                  {value}%
                </option>
              ))}
            </select>
          </nav>
          {active && (tool === "text" || tool === "rectangle") && (
            <div className="tool-options">
              <label>
                Colour{" "}
                <input
                  aria-label="Annotation colour"
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
              {tool === "text" && (
                <label>
                  Text{" "}
                  <input
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    maxLength={300}
                  />
                </label>
              )}
              <span>
                {tool === "text"
                  ? "Click the page to place text. Basic Latin text for now."
                  : "Drag across the page to draw a rectangle."}
              </span>
            </div>
          )}
          <div className="canvas-area">
            {!active ? (
              <div className="welcome">
                <div className="eyebrow">YOUR DOCUMENT. YOUR RULES.</div>
                <h1>
                  Make room for
                  <br />a better PDF editor.
                </h1>
                <p>
                  Rearrange a few pages. Add a thought.
                  <br />
                  Get on with your day.
                </p>
                <button
                  className="drop-zone"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <span className="upload-icon">
                    <Upload size={27} />
                  </span>
                  <strong>
                    {busy ? "Opening your PDF…" : "Drop your PDF right here"}
                  </strong>
                  <span>
                    or <b>browse files</b> to get started
                  </span>
                  <small>Everything happens in your browser.</small>
                </button>
                <div className="welcome-features">
                  <span>
                    <FilePlus2 size={16} /> Organise pages
                  </span>
                  <span>
                    <Type size={16} /> Add text & shapes
                  </span>
                  <span>
                    <Download size={16} /> Export freely
                  </span>
                </div>
                <div className="development-note">
                  EARLY BUILD{" "}
                  <span>
                    Original-text editing now available for supported fonts.
                  </span>
                </div>
              </div>
            ) : (
              <div className="document-wrap" style={{ width: `${zoom * 8}px` }}>
                <div className="page-caption">
                  PAGE {activeIndex + 1} OF {pages.length}
                </div>
                {source && (
                  <PageView
                    key={active.id}
                    source={source}
                    page={active}
                    tool={busy ? "select" : tool}
                    color={color}
                    text={text}
                    onAdd={(annotation) =>
                      commit(
                        pages.map((page) =>
                          page.id === active.id
                            ? {
                                ...page,
                                annotations: [...page.annotations, annotation],
                              }
                            : page,
                        ),
                      )
                    }
                    onInspect={setInspection}
                    onError={setError}
                  />
                )}
                <p className="session-note">
                  Edits live in this tab. Export your PDF before closing.
                </p>
              </div>
            )}
          </div>
          <footer>
            <span>
              {busy
                ? "Working on your PDF…"
                : active
                  ? "Ready when you are"
                  : "A fresh start for your documents"}
            </span>
            <span>PDFeditor · First edition</span>
          </footer>
        </section>
        {tool === "edit" && active && source && (
          <OriginalTextEditor
            key={active.id}
            source={source}
            page={active}
            onClose={() => setTool("select")}
            onApply={(edit) =>
              commit(
                pages.map((page) =>
                  page.id === active.id
                    ? {
                        ...page,
                        textReplacements: [
                          ...(page.textReplacements ?? []).filter(
                            (existing) => existing.runId !== edit.runId,
                          ),
                          ...(edit.replacement === edit.original ? [] : [edit]),
                        ],
                      }
                    : page,
                ),
              )
            }
          />
        )}
        {inspection !== null && (
          <aside className="inspector">
            <div className="panel-title">
              Page text
              <button
                aria-label="Close text inspector"
                onClick={() => setInspection(null)}
              >
                <X size={17} />
              </button>
            </div>
            <p>
              Read-only extraction. Use Edit text to change supported original
              text runs.
            </p>
            <textarea
              readOnly
              aria-label="Extracted page text"
              value={
                inspection ||
                "No selectable text found. This page may be a scan."
              }
            />
          </aside>
        )}
      </main>
    </div>
  );
}
