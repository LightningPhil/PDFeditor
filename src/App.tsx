import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { exportPdf, exportPagePreview } from "./pdf";
import type { Annotation, EditorPage, Source } from "./pdf";
import { inspectEditableText } from "./text-edit";
import type { EditableRun } from "./text-edit";
import { OriginalTextEditor } from "./OriginalTextEditor";
import { TextBoxOverlay } from "./TextBoxOverlay";
import {
  getTextBoxes,
  joinTextBoxes,
  moveTextBoxes,
  ungroupTextBoxes,
} from "./text-boxes";
import type { TextBox } from "./text-boxes";
import { identity, inverseVector } from "./geometry";
import type { Matrix } from "./geometry";
import { readDocumentTextGroups } from "./text-group-storage";
import {
  neighbouringLine,
  selectedTextBoxIds,
  textMembersForBoxes,
} from "./text-selection";
import "./App.css";
import { TextFormatting } from "./TextFormatting";
import { SearchPanel } from "./SearchPanel";
import { PageOrganizer } from "./PageOrganizer";
import { ReviewPanel } from "./ReviewPanel";
import { applyTextEdits, readDocumentParagraphs } from "./document-editing";
import {
  saveSession,
  loadSession,
  latestSession,
  forgetSession,
} from "./session-store";
import type { SessionSnapshot } from "./session-store";
import type { Paragraph } from "./typography";
import type { Point } from "./geometry";
import { renderPageFrame } from "./page-frame";
import { ReferenceAlignment } from "./ReferenceAlignment";
import { emptyReferences } from "./reference-alignment";
import type { AlignmentReferences } from "./reference-alignment";
import { ItemTools } from "./ItemTools";
import { ShapeOverlay } from "./ShapeOverlay";
import { PageUtilities } from "./PageUtilities";
import { readDocumentLocks } from "./item-operations";
import { readStyleLibrary, useStyleLibrary } from "./style-library";
import type { TextStyle } from "./style-library";
import { bounds, transform } from "./geometry";

GlobalWorkerOptions.workerSrc = workerUrl;
type Tool = "select" | "text" | "rectangle" | "inspect" | "edit" | "view";
type LoadedSource = Source & {
  document: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
};
const uid = () => crypto.randomUUID();
const emptyRuns: EditableRun[] = [];
async function restoreSources(saved: Source[]): Promise<LoadedSource[]> {
  const loaded: LoadedSource[] = [];
  try {
    for (const source of saved) {
      const task = getDocument({
        data: source.bytes.slice(),
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        wasmUrl: "/pdfjs/wasm/",
      });
      try {
        const document = await task.promise;
        loaded.push({ ...source, document, task });
      } catch (e) {
        void task.destroy();
        throw e;
      }
    }
    return loaded;
  } catch (e) {
    loaded.forEach((s) => void s.task.destroy());
    throw e;
  }
}

function PageView({
  source,
  page,
  tool,
  color,
  text,
  onAdd,
  onInspect,
  onError,
  boxes,
  selected,
  onSelect,
  onSelection,
  onMoveText,
  onViewport,
  snapEnabled,
  highlight,
  deletedQuads,
  references,
  shapeSelected,
  onShapeSelect,
  onPageChange,
  addStyle,
  zoom,
}: {
  source: LoadedSource;
  page: EditorPage;
  tool: Tool;
  color: string;
  text: string;
  onAdd: (annotation: Annotation) => void;
  onInspect: (text: string) => void;
  onError: (message: string) => void;
  boxes: TextBox[];
  selected: string[];
  onSelect: (id: string | null, extend?: boolean) => void;
  onSelection: (ids: string[]) => void;
  onMoveText: (ids: string[], dx: number, dy: number) => void;
  onViewport: (
    matrix: Matrix,
    pageId: string,
    rotation: number,
    width: number,
    height: number,
  ) => void;
  snapEnabled: boolean;
  highlight: boolean;
  deletedQuads: Point[][];
  references: AlignmentReferences;
  shapeSelected: string[];
  onShapeSelect: (id: string, extend: boolean) => void;
  onPageChange: (page: EditorPage) => void;
  addStyle: TextStyle;
  zoom: number;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 595, height: 842 });
  const [ready, setReady] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewport, setViewport] = useState<Matrix>(identity);
  const [positionReady, setPositionReady] = useState(false);
  const [positionRotation, setPositionRotation] = useState<number>();
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const referenceRunIds = useMemo(
    () => new Set(references.runIds),
    [references.runIds],
  );
  useEffect(() => {
    let cancelled = false;
    let previewTask: PDFDocumentLoadingTask | undefined;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    setReady(false);
    void (async () => {
      if (
        !page.textReplacements?.length &&
        !page.textOffsets?.length &&
        !page.annotations.length &&
        !page.rotation &&
        !page.crop &&
        !page.textCopies?.length &&
        !page.textTransforms?.length
      )
        return source.document.getPage(page.index + 1);
      const data = await exportPagePreview(source, page, true);
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
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(
          Math.min(window.devicePixelRatio || 1, 2) * Math.max(1.4, zoom / 100),
          Math.sqrt(20000000 / (base.width * base.height)),
        );
        await renderPageFrame(pdfPage, scale, {
          createCanvas: () => document.createElement("canvas"),
          current: () => !cancelled && !!canvas.current,
          rendering: (task) => {
            render = task;
          },
          present: (frame, view) => {
            canvas.current!.replaceChildren(frame);
            setViewport(view.transform as Matrix);
            onViewport(
              view.transform as Matrix,
              page.id,
              page.rotation ?? 0,
              view.width,
              view.height,
            );
            setPositionRotation(page.rotation ?? 0);
            setPositionReady(true);
            setSize({ width: view.width, height: view.height });
            setHasFrame(true);
            setReady(true);
          },
        });
      })
      .catch((error) => {
        if (!cancelled) onError(String(error));
      });
    return () => {
      cancelled = true;
      render?.cancel();
      void previewTask?.destroy();
    };
  }, [
    source,
    page.id,
    page.index,
    page.textReplacements,
    page.textOffsets,
    page.annotations,
    page.rotation,
    page.crop,
    page.textCopies,
    page.textTransforms,
    onError,
    onViewport,
    zoom,
  ]);

  function point(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = {
      x: ((event.clientX - bounds.left) / bounds.width) * size.width,
      y: ((event.clientY - bounds.top) / bounds.height) * size.height,
    };
    return inverseVector(viewport, {
      x: position.x - viewport[4],
      y: position.y - viewport[5],
    });
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
      <div className="page-canvas" ref={canvas} />
      {!hasFrame && <div className="rendering">Rendering page…</div>}
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        className={`annotation-layer tool-${tool}`}
        onPointerDown={(event) => {
          if (!ready) return;
          if (tool === "inspect") {
            void inspect();
            return;
          }
          if (tool === "edit") onSelect(null);
          if (tool === "select" || tool === "edit" || tool === "view") return;
          const p = point(event);
          if (tool === "text" && text.trim())
            onAdd({
              id: uid(),
              kind: "text",
              x: p.x,
              y: p.y,
              text,
              color,
              size: addStyle.size,
              font: addStyle.font,
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
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
              color,
            });
          setStart(null);
        }}
      ></svg>
      {highlight && (
        <svg
          className="change-layer"
          viewBox={`0 0 ${size.width} ${size.height}`}
          aria-label="Highlighted changes"
        >
          <g transform={`matrix(${viewport.join(" ")})`}>
            {deletedQuads.map((quad, index) => (
              <polygon
                key={`deleted:${index}`}
                className="deleted-highlight"
                points={quad.map((p) => `${p.x},${p.y}`).join(" ")}
              />
            ))}
            {page.annotations
              .filter((a) => a.kind === "rectangle")
              .map((a) =>
                a.kind === "rectangle" ? (
                  <rect
                    key={a.id}
                    className="shape-highlight"
                    x={a.x}
                    y={a.y}
                    width={a.width}
                    height={a.height}
                  />
                ) : null,
              )}
            {boxes.flatMap((box) =>
              box.pieces
                .filter(
                  (piece) =>
                    piece.runId.startsWith("added:") ||
                    piece.runId.startsWith("copy:") ||
                    page.textReplacements?.some(
                      (e) => e.runId === piece.runId,
                    ) ||
                    page.textOffsets?.some((e) => e.runId === piece.runId),
                )
                .map((piece) => (
                  <polygon
                    key={piece.runId}
                    points={piece.quad.map((p) => `${p.x},${p.y}`).join(" ")}
                  />
                )),
            )}
          </g>
        </svg>
      )}
      {(tool === "edit" || tool === "select") && (
        <svg
          className="reference-layer"
          viewBox={`0 0 ${size.width} ${size.height}`}
          aria-label="Fixed alignment references"
        >
          <g transform={`matrix(${viewport.join(" ")})`}>
            {boxes.flatMap((box) =>
              box.pieces
                .filter((piece) => referenceRunIds.has(piece.runId))
                .map((piece) => (
                  <polygon
                    key={piece.runId}
                    points={piece.quad.map((p) => `${p.x},${p.y}`).join(" ")}
                  />
                )),
            )}
            {page.annotations
              .filter(
                (a) =>
                  a.kind === "rectangle" && references.shapeIds.includes(a.id),
              )
              .map((a) =>
                a.kind === "rectangle" ? (
                  <rect
                    key={a.id}
                    x={a.x}
                    y={a.y}
                    width={a.width}
                    height={a.height}
                  />
                ) : null,
              )}
          </g>
        </svg>
      )}
      {(tool === "edit" || tool === "select") && (
        <TextBoxOverlay
          disabled={!ready}
          positionReady={
            positionReady && positionRotation === (page.rotation ?? 0)
          }
          boxes={boxes}
          selected={selected}
          viewport={viewport}
          snapEnabled={snapEnabled}
          width={size.width}
          height={size.height}
          onSelect={onSelect}
          onSelection={onSelection}
          onMove={onMoveText}
        />
      )}
      {(tool === "edit" || tool === "select") && (
        <ShapeOverlay
          page={page}
          viewport={viewport}
          width={size.width}
          height={size.height}
          selected={shapeSelected}
          disabled={!ready}
          onSelect={onShapeSelect}
          onChange={onPageChange}
        />
      )}
    </div>
  );
}

export default function App() {
  const [sources, setSources] = useState<LoadedSource[]>([]);
  const [history, setHistory] = useState<EditorPage[][]>([[]]);
  const [cursor, setCursor] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(() => readStyleLibrary().last.color);
  const styles = useStyleLibrary();
  useEffect(() => setColor(styles.last.color), [styles.last.color]);
  const [shapeSelection, setShapeSelection] = useState<{
    pageId: string;
    ids: string[];
  }>({ pageId: "", ids: [] });
  const [text, setText] = useState("Your text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inspection, setInspection] = useState<string | null>(null);
  const [zoom, setZoom] = useState(85);
  const [zoomMode, setZoomMode] = useState<"manual" | "fit-page" | "fit-width">(
    "manual",
  );
  const canvasArea = useRef<HTMLDivElement>(null);
  const [zoomTarget, setZoomTarget] = useState<Point | null>(null);
  const [pageJump, setPageJump] = useState("1");
  const [selection, setSelection] = useState<{
    pageId: string;
    runIds: string[];
  }>({ pageId: "", runIds: [] });
  const [formatDrafts, setFormatDrafts] = useState<Record<string, Paragraph>>(
    {},
  );
  const [alignmentReferences, setAlignmentReferences] = useState<
    Record<string, AlignmentReferences>
  >({});
  const [baseline, setBaseline] = useState<EditorPage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [dialog, setDialog] = useState<
    "search" | "pages" | "review" | "export" | "utilities" | null
  >(null);
  const [showOriginal, setShowOriginal] = useState(false),
    [highlight, setHighlight] = useState(false),
    [snapEnabled, setSnapEnabled] = useState(true);
  const [hydrated, setHydrated] = useState(false),
    [saveStatus, setSaveStatus] = useState("Opening local workspace…");
  const [recovery, setRecovery] = useState<SessionSnapshot | null>(null);
  const [sessionId, setSessionId] = useState(() => {
    try {
      let id = sessionStorage.getItem("PDFeditor-session");
      if (!id) {
        id = uid();
        sessionStorage.setItem("PDFeditor-session", id);
      }
      return id;
    } catch {
      return uid();
    }
  });
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const tasks = useRef<PDFDocumentLoadingTask[]>([]);
  function applyRecovered(snapshot: SessionSnapshot, loaded: LoadedSource[]) {
    if (
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.history) ||
      !snapshot.history[snapshot.cursor]
    )
      throw new Error("This saved workspace cannot be restored.");
    tasks.current.push(...loaded.map((s) => s.task));
    setSources(loaded);
    setHistory(snapshot.history);
    setCursor(snapshot.cursor);
    setActiveId(snapshot.activeId);
    setBaseline(snapshot.baseline ?? []);
    setDrafts(snapshot.drafts ?? {});
    setZoom(snapshot.zoom ?? 85);
    setSelection(snapshot.selection ?? { pageId: "", runIds: [] });
    setFormatDrafts(snapshot.formatDrafts ?? {});
    setAlignmentReferences(snapshot.alignmentReferences ?? {});
    setShapeSelection(snapshot.shapeSelection ?? { pageId: "", ids: [] });
    setZoomMode(snapshot.zoomMode ?? "manual");
    if (
      ["select", "edit", "text", "rectangle", "inspect"].includes(
        snapshot.tool ?? "",
      )
    )
      setTool(snapshot.tool as Tool);
    setRecovery(null);
    setSaveStatus("Recovered local workspace");
  }
  useEffect(() => {
    let cancelled = false;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      const saved = await loadSession(sessionId);
      if (saved) {
        const loaded = await restoreSources(saved.sources);
        if (cancelled) {
          loaded.forEach((s) => void s.task.destroy());
          return;
        }
        applyRecovered(saved, loaded);
      } else {
        const candidate = await latestSession();
        if (!cancelled) {
          setRecovery(candidate ?? null);
          setSaveStatus("Ready to save locally");
        }
      }
    })()
      .catch((e) => {
        if (!cancelled) {
          setSaveStatus("Local recovery unavailable");
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHydrated(true);
          setBusy(false);
          busyRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!hydrated || busy || !sources.length) return;
    setSaveStatus("Saving locally…");
    let cancelled = false;
    const timer = setTimeout(() => {
      const start = Math.max(0, cursor - 40);
      const snapshot: SessionSnapshot = {
        version: 1,
        id: sessionId,
        updatedAt: Date.now(),
        sources: sources.map(({ id, name, bytes }) => ({ id, name, bytes })),
        history: history.slice(start, cursor + 11),
        cursor: cursor - start,
        activeId,
        baseline,
        drafts,
        zoom,
        selection,
        formatDrafts,
        alignmentReferences,
        shapeSelection,
        zoomMode,
        tool,
      };
      void saveSession(snapshot)
        .then(() => {
          if (!cancelled)
            setSaveStatus(
              `Saved locally · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            );
        })
        .catch(() => {
          if (!cancelled) setSaveStatus("Local save failed — export your PDF");
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    hydrated,
    busy,
    sources,
    history,
    cursor,
    activeId,
    baseline,
    drafts,
    zoom,
    sessionId,
    selection,
    formatDrafts,
    alignmentReferences,
    shapeSelection,
    zoomMode,
    tool,
  ]);
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
  const displayPage = useMemo(
    () =>
      active && showOriginal
        ? {
            ...active,
            annotations: [],
            textReplacements: [],
            textOffsets: [],
            textGroups: [],
            paragraphs: [],
            rotation: 0,
            crop: undefined,
            textTransforms: [],
            textCopies: [],
            lockedRunIds: [],
          }
        : active,
    [active, showOriginal],
  );
  const source = sources.find((item) => item.id === active?.sourceId);
  const activeIndex = pages.findIndex((page) => page.id === active?.id);
  useEffect(() => setPageJump(String(activeIndex + 1)), [activeIndex]);
  function jumpPage() {
    const number = Number(pageJump);
    if (!Number.isInteger(number) || number < 1 || number > pages.length) {
      setError(`Enter a page number from 1 to ${pages.length}.`);
      return;
    }
    setActiveId(pages[number - 1].id);
  }
  const selectedShapes =
    shapeSelection.pageId === active?.id
      ? shapeSelection.ids.filter((id) =>
          active?.annotations.some((a) => a.id === id),
        )
      : [];
  function selectShape(id: string, extend: boolean) {
    if (!active) return;
    if (!extend) setSelection({ pageId: active.id, runIds: [] });
    setShapeSelection({
      pageId: active.id,
      ids: extend
        ? selectedShapes.includes(id)
          ? selectedShapes.filter((value) => value !== id)
          : [...selectedShapes, id]
        : [id],
    });
  }
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDialog(null);
      }
      if (event.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    };
  }, [dialog]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const input =
        event.target instanceof HTMLElement &&
        (event.target.matches("input, textarea, select") ||
          event.target.isContentEditable);
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        pages.length
      ) {
        event.preventDefault();
        setDialog("search");
      }
      if (
        !input &&
        !dialog &&
        !busy &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        setCursor((current) =>
          Math.max(
            0,
            Math.min(history.length - 1, current + (event.shiftKey ? 1 : -1)),
          ),
        );
      }
      if (!input && !dialog && !busy && pages.length) {
        let destination: number | undefined;
        if (event.key === "PageDown") destination = activeIndex + 1;
        if (event.key === "PageUp") destination = activeIndex - 1;
        if ((event.ctrlKey || event.metaKey) && event.key === "Home")
          destination = 0;
        if ((event.ctrlKey || event.metaKey) && event.key === "End")
          destination = pages.length - 1;
        if (destination !== undefined) {
          event.preventDefault();
          setActiveId(
            pages[Math.max(0, Math.min(pages.length - 1, destination))].id,
          );
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [pages, activeIndex, dialog, busy, history.length]);
  const [pageViewport, setPageViewport] = useState<{
    pageId: string;
    matrix: Matrix;
    rotation: number;
    width: number;
    height: number;
  }>({ pageId: "", matrix: identity(), rotation: 0, width: 595, height: 842 });
  const publishViewport = useCallback(
    (
      matrix: Matrix,
      pageId: string,
      rotation: number,
      width: number,
      height: number,
    ) => setPageViewport({ matrix, pageId, rotation, width, height }),
    [],
  );
  const [runState, setRunState] = useState<{
    pageId: string;
    runs: EditableRun[];
    original: EditableRun[];
  }>({ pageId: "", runs: [], original: [] });
  const [readingText, setReadingText] = useState(false);
  const runs = runState.pageId === active?.id ? runState.runs : emptyRuns;
  const boxes = useMemo(
    () =>
      active ? getTextBoxes(active, runs).filter((box) => box.text.trim()) : [],
    [active, runs],
  );
  const selected = useMemo(
    () =>
      selection.pageId === active?.id
        ? selectedTextBoxIds(boxes, selection.runIds ?? [])
        : [],
    [selection, active?.id, boxes],
  );
  useEffect(() => {
    if (!active || !source) return;
    let cancelled = false;
    setReadingText(true);
    void Promise.all([
      inspectEditableText(
        source.bytes,
        active.index,
        active.textReplacements,
        active.textCopies,
      ),
      inspectEditableText(source.bytes, active.index),
    ])
      .then(([runs, original]) => {
        if (!cancelled) setRunState({ pageId: active.id, runs, original });
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setReadingText(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    active?.id,
    active?.index,
    active?.textReplacements,
    active?.textCopies,
    source,
  ]);
  function selectText(id: string | null, extend = false) {
    if (!active) return;
    if (!extend) setShapeSelection({ pageId: active.id, ids: [] });
    setSelection({
      pageId: active.id,
      runIds: textMembersForBoxes(
        boxes,
        id === null
          ? []
          : extend
            ? selected.includes(id)
              ? selected.filter((value) => value !== id)
              : [...selected, id]
            : [id],
      ),
    });
  }
  function selectTextIds(ids: string[]) {
    if (active) setShapeSelection({ pageId: active.id, ids: [] });
    if (active)
      setSelection({
        pageId: active.id,
        runIds: textMembersForBoxes(boxes, ids),
      });
  }
  const lineSelection = useMemo(
    () => (selected.length === 1 ? neighbouringLine(boxes, selected[0]) : []),
    [boxes, selected],
  );
  const viewWidth =
      pageViewport.pageId === active?.id ? pageViewport.width : 595,
    viewHeight = pageViewport.pageId === active?.id ? pageViewport.height : 842;
  useEffect(() => {
    const area = canvasArea.current;
    if (!area || zoomMode === "manual") return;
    const fit = () => {
      const padding = getComputedStyle(area);
      const width = Math.max(
          60,
          area.clientWidth -
            parseFloat(padding.paddingLeft) -
            parseFloat(padding.paddingRight) -
            2,
        ),
        height = Math.max(
          60,
          area.clientHeight -
            parseFloat(padding.paddingTop) -
            parseFloat(padding.paddingBottom) -
            40,
        );
      setZoom(
        Math.max(
          0.1,
          Math.min(
            800,
            100 *
              (zoomMode === "fit-width"
                ? width / viewWidth
                : Math.min(width / viewWidth, height / viewHeight)),
          ),
        ),
      );
    };
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    fit();
    return () => observer.disconnect();
  }, [zoomMode, viewWidth, viewHeight]);
  useLayoutEffect(() => {
    if (!zoomTarget || !canvasArea.current) return;
    const area = canvasArea.current,
      paper = area.querySelector<HTMLElement>(".paper");
    if (!paper) return;
    const r = paper.getBoundingClientRect(),
      a = area.getBoundingClientRect();
    area.scrollLeft +=
      r.left - a.left + (zoomTarget.x * zoom) / 100 - a.width / 2;
    area.scrollTop +=
      r.top - a.top + (zoomTarget.y * zoom) / 100 - a.height / 2;
    setZoomTarget(null);
  }, [zoom, zoomTarget]);
  function fitSelection() {
    const points = boxes
      .filter((b) => selected.includes(b.id))
      .flatMap((b) => b.points);
    for (const a of active?.annotations ?? [])
      if (selectedShapes.includes(a.id) && a.kind === "rectangle")
        points.push(
          { x: a.x, y: a.y },
          { x: a.x + a.width, y: a.y },
          { x: a.x + a.width, y: a.y + a.height },
          { x: a.x, y: a.y + a.height },
        );
    if (!points.length || !canvasArea.current) return;
    const area = bounds(points.map((p) => transform(pageViewport.matrix, p))),
      container = canvasArea.current;
    setZoomMode("manual");
    setZoom(
      Math.max(
        0.1,
        Math.min(
          800,
          100 *
            Math.min(
              (container.clientWidth - 80) / Math.max(20, area.width),
              (container.clientHeight - 100) / Math.max(20, area.height),
            ),
        ),
      ),
    );
    setZoomTarget({ x: area.x + area.width / 2, y: area.y + area.height / 2 });
  }
  function moveText(ids: string[], dx: number, dy: number) {
    if (!active || busyRef.current) return;
    try {
      const next = moveTextBoxes(active, runs, ids, dx, dy);
      commit(pages.map((page) => (page.id === active.id ? next : page)));
    } catch (cause) {
      setError(String(cause));
    }
  }
  function joinText() {
    if (!active || busyRef.current) return;
    try {
      const id = `joined:${uid()}`;
      const next = joinTextBoxes(active, runs, selected, id);
      commit(pages.map((page) => (page.id === active.id ? next : page)));
      setSelection({
        pageId: active.id,
        runIds: textMembersForBoxes(getTextBoxes(next, runs), [id]),
      });
    } catch (cause) {
      setError(String(cause));
    }
  }
  function ungroupText() {
    if (!active || busyRef.current) return;
    const members = boxes
      .filter((box) => selected.includes(box.id))
      .flatMap((box) => box.runs.map((run) => run.id));
    const next = ungroupTextBoxes(active, selected);
    commit(pages.map((page) => (page.id === active.id ? next : page)));
    setSelection({ pageId: active.id, runIds: members });
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pages.length && !saveStatus.startsWith("Saved locally"))
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pages.length, saveStatus]);
  function commit(next: EditorPage[]) {
    setHistory((previous) => [...previous.slice(0, cursor + 1), next]);
    setCursor(cursor + 1);
  }
  async function newWorkspace() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await saveSession({
        version: 1,
        id: sessionId,
        updatedAt: Date.now(),
        sources: sources.map(({ id, name, bytes }) => ({ id, name, bytes })),
        history: history.slice(Math.max(0, cursor - 40), cursor + 11),
        cursor: Math.min(cursor, 40),
        activeId,
        baseline,
        drafts,
        zoom,
        selection,
        formatDrafts,
        alignmentReferences,
        shapeSelection,
        zoomMode,
        tool,
      });
      const id = uid();
      sessionStorage.setItem("PDFeditor-session", id);
      tasks.current.forEach((task) => void task.destroy());
      tasks.current = [];
      setSources([]);
      setHistory([[]]);
      setCursor(0);
      setActiveId("");
      setBaseline([]);
      setDrafts({});
      setFormatDrafts({});
      setAlignmentReferences({});
      setShapeSelection({ pageId: "", ids: [] });
      setSelection({ pageId: "", runIds: [] });
      setTool("select");
      setShowOriginal(false);
      setDialog(null);
      setHydrated(false);
      setSessionId(id);
    } catch (e) {
      setError(String(e));
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function importFiles(files: File[]) {
    if (!files.length || busyRef.current || !hydrated) return;
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
        const groups = await readDocumentTextGroups(bytes);
        const paragraphs = await readDocumentParagraphs(bytes, groups);
        const locks = await readDocumentLocks(bytes);
        const item = { id: uid(), name: file.name, bytes, document, task };
        loaded.push(item);
        for (let index = 0; index < document.numPages; index++)
          added.push({
            id: uid(),
            sourceId: item.id,
            index,
            annotations: [],
            textGroups: groups[index] ?? [],
            paragraphs: paragraphs[index] ?? [],
            lockedRunIds: locks[index] ?? [],
          });
      }
      if (!added.length) throw new Error("This PDF has no pages.");
      setSources((previous) => [...previous, ...loaded]);
      setBaseline((previous) => [...previous, ...added]);
      setRecovery(null);
      setShowOriginal(false);
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
  async function download(chosen: EditorPage[] = pages, filename?: string) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const bytes = await exportPdf(sources, chosen);
      const url = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: "application/pdf",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        filename ??
        `${sources[0]?.name.replace(/\.pdf$/i, "") || "document"}-edited.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return true;
    } catch (cause) {
      setError(
        `Could not export: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const tools = [
    // Source text remains native when duplicating or transforming it.
    { id: "edit", label: "Edit text", icon: ScanText },
    { id: "select", label: "Select", icon: MousePointer2 },
    { id: "text", label: "Add text", icon: Type },
    { id: "rectangle", label: "Rectangle", icon: Square },
    { id: "inspect", label: "Inspect text", icon: ScanText },
  ] as const;
  function itemControls() {
    return active ? (
      <ItemTools
        page={active}
        runs={runs}
        boxes={boxes}
        selected={selected}
        shapes={selectedShapes}
        onSelectShape={selectShape}
        disabled={busy || readingText}
        onChange={(next) =>
          commit(pages.map((p) => (p.id === active.id ? next : p)))
        }
        onDuplicate={(result) => {
          commit(pages.map((p) => (p.id === active.id ? result.page : p)));
          setSelection({ pageId: active.id, runIds: result.runIds });
          setShapeSelection({ pageId: active.id, ids: result.shapeIds });
        }}
      />
    ) : null;
  }
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
          onClick={() => setDialog("export")}
        >
          <Download size={16} /> Export PDF
        </button>
        {!!pages.length && (
          <button disabled={busy} onClick={() => void newWorkspace()}>
            New workspace
          </button>
        )}
      </header>
      <div className="workspace-bar">
        <div>
          <span className="status-dot" />{" "}
          {sources[0]?.name ?? "Your next great edit"}
          <span className="muted" role="status" aria-live="polite">
            {pages.length
              ? `${pages.length} pages · ${saveStatus}`
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
      {!pages.length && recovery && (
        <div className="recovery-banner">
          <div>
            <strong>Recover your previous workspace</strong>
            <p>
              {recovery.sources[0]?.name} ·{" "}
              {new Date(recovery.updatedAt).toLocaleString()} · saved on this
              device
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              busyRef.current = true;
              setBusy(true);
              void restoreSources(recovery.sources)
                .then((loaded) => applyRecovered(recovery, loaded))
                .catch((e) => setError(String(e)))
                .finally(() => {
                  busyRef.current = false;
                  setBusy(false);
                });
            }}
          >
            Restore workspace
          </button>
          <button onClick={() => setRecovery(null)}>Start fresh</button>
          <button
            onClick={() =>
              void forgetSession(recovery.id)
                .then(() => setRecovery(null))
                .catch((e) => setError(String(e)))
            }
          >
            Delete saved copy
          </button>
        </div>
      )}
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
        <section
          className={`editor ${zoomMode === "fit-page" ? "is-fit-page" : ""}`}
        >
          {!!pages.length && (
            <nav className="document-tools" aria-label="Document tools">
              <button disabled={busy} onClick={() => setDialog("utilities")}>
                Page tools
              </button>
              <button disabled={busy} onClick={() => setDialog("search")}>
                Find & replace
              </button>
              <button disabled={busy} onClick={() => setDialog("pages")}>
                Organise pages
              </button>
              <button disabled={busy} onClick={() => setDialog("review")}>
                Review changes
              </button>
              <div
                className="compare-switch"
                role="group"
                aria-label="Compare page"
              >
                <button
                  aria-pressed={!showOriginal}
                  className={!showOriginal ? "selected" : ""}
                  onClick={() => setShowOriginal(false)}
                >
                  Edited
                </button>
                <button
                  aria-pressed={showOriginal}
                  className={showOriginal ? "selected" : ""}
                  onClick={() => setShowOriginal(true)}
                >
                  Original
                </button>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={highlight}
                  disabled={showOriginal}
                  onChange={(e) => setHighlight(e.target.checked)}
                />{" "}
                Highlight changes
              </label>
            </nav>
          )}
          <nav className="toolbar" aria-label="Editing tools">
            {tools.map((item) => (
              <button
                key={item.id}
                className={tool === item.id ? "selected" : ""}
                disabled={!active || busy || showOriginal}
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
            <button
              disabled={!active}
              aria-pressed={zoomMode === "fit-page"}
              onClick={() => setZoomMode("fit-page")}
            >
              Fit page
            </button>
            <button
              disabled={!active}
              aria-pressed={zoomMode === "fit-width"}
              onClick={() => setZoomMode("fit-width")}
            >
              Fit width
            </button>
            <button
              disabled={!selected.length && !selectedShapes.length}
              onClick={fitSelection}
            >
              Zoom to selection
            </button>
            {tool === "edit" && (
              <label className="snap-toggle">
                <input
                  type="checkbox"
                  checked={snapEnabled}
                  onChange={(e) => setSnapEnabled(e.target.checked)}
                />{" "}
                Snap
              </label>
            )}
            <select
              aria-label="Page zoom"
              value={zoom}
              onChange={(event) => {
                setZoomMode("manual");
                setZoom(Number(event.target.value));
              }}
            >
              {![25, 50, 60, 75, 85, 100, 125, 150, 200, 400, 800].includes(
                zoom,
              ) && <option value={zoom}>{Math.round(zoom)}%</option>}
              {[25, 50, 60, 75, 85, 100, 125, 150, 200, 400, 800].map(
                (value) => (
                  <option key={value} value={value}>
                    {value}%
                  </option>
                ),
              )}
            </select>
          </nav>
          {!!pages.length && (
            <nav className="page-navigation" aria-label="Page navigation">
              <button
                aria-label="First page"
                disabled={activeIndex === 0 || busy}
                onClick={() => setActiveId(pages[0].id)}
              >
                «
              </button>
              <button
                aria-label="Previous page"
                disabled={activeIndex === 0 || busy}
                onClick={() => setActiveId(pages[activeIndex - 1].id)}
              >
                ‹
              </button>
              <label>
                Page{" "}
                <input
                  aria-label="Go to page"
                  type="number"
                  min="1"
                  max={pages.length}
                  value={pageJump}
                  onChange={(e) => setPageJump(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") jumpPage();
                  }}
                />{" "}
                of {pages.length}
              </label>
              <button onClick={jumpPage} disabled={busy}>
                Go
              </button>
              <button
                aria-label="Next page"
                disabled={activeIndex === pages.length - 1 || busy}
                onClick={() => setActiveId(pages[activeIndex + 1].id)}
              >
                ›
              </button>
              <button
                aria-label="Last page"
                disabled={activeIndex === pages.length - 1 || busy}
                onClick={() => setActiveId(pages.at(-1)!.id)}
              >
                »
              </button>
              <small>Page Up / Page Down · Ctrl/Cmd+Home / End</small>
            </nav>
          )}
          {active && (tool === "text" || tool === "rectangle") && (
            <div className="tool-options">
              <label>
                Colour{" "}
                <input
                  aria-label="Annotation colour"
                  type="color"
                  value={color}
                  onChange={(event) => {
                    setColor(event.target.value);
                    if (tool === "text")
                      styles.setLast({
                        ...styles.last,
                        color: event.target.value,
                      });
                  }}
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
              {tool === "text" && (
                <>
                  <label>
                    Font
                    <select
                      aria-label="New text font"
                      value={styles.last.font}
                      onChange={(e) =>
                        styles.setLast({
                          ...styles.last,
                          font: e.target.value as TextStyle["font"],
                        })
                      }
                    >
                      {[
                        "Helvetica",
                        "Helvetica-Bold",
                        "Helvetica-Oblique",
                        "Helvetica-BoldOblique",
                        "Times-Roman",
                        "Times-Bold",
                        "Times-Italic",
                        "Times-BoldItalic",
                        "Courier",
                        "Courier-Bold",
                        "Courier-Oblique",
                        "Courier-BoldOblique",
                      ].map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Size
                    <input
                      aria-label="New text size"
                      type="number"
                      min="1"
                      max="300"
                      value={styles.last.size}
                      onChange={(e) => {
                        const size = Number(e.target.value);
                        if (size >= 1 && size <= 300)
                          styles.setLast({ ...styles.last, size });
                      }}
                    />
                  </label>
                </>
              )}
              <span>
                {tool === "text"
                  ? "Click the page to place text. Basic Latin text for now."
                  : "Drag across the page to draw a rectangle."}
              </span>
            </div>
          )}
          <div className="canvas-area" ref={canvasArea}>
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
              <div
                className="document-wrap"
                style={{ width: `${(viewWidth * zoom) / 100}px` }}
              >
                <div className="page-caption">
                  {showOriginal ? "ORIGINAL SOURCE · " : ""}PAGE{" "}
                  {activeIndex + 1} OF {pages.length}
                </div>
                {source && (
                  <PageView
                    key={active.id + (showOriginal ? ":original" : "")}
                    source={source}
                    page={displayPage!}
                    tool={busy || showOriginal ? "view" : tool}
                    zoom={zoom}
                    addStyle={styles.last}
                    shapeSelected={selectedShapes}
                    onShapeSelect={selectShape}
                    onPageChange={(next) => {
                      if (!busyRef.current)
                        commit(
                          pages.map((p) => (p.id === active.id ? next : p)),
                        );
                    }}
                    color={color}
                    text={text}
                    boxes={boxes}
                    selected={selected}
                    onSelect={selectText}
                    onSelection={selectTextIds}
                    onMoveText={moveText}
                    onViewport={publishViewport}
                    snapEnabled={snapEnabled}
                    references={
                      alignmentReferences[active.id] ?? emptyReferences
                    }
                    highlight={highlight && !showOriginal}
                    deletedQuads={
                      !showOriginal && runState.pageId === active.id
                        ? (runState.original ?? [])
                            .filter((run) =>
                              active.textReplacements?.some(
                                (edit) =>
                                  edit.runId === run.id &&
                                  !edit.replacement.trim(),
                              ),
                            )
                            .flatMap((run) =>
                              run.geometry ? [run.geometry.quad] : [],
                            )
                        : []
                    }
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
                  {saveStatus}. Export a PDF to share your finished document.
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
        {tool === "edit" && active && source && !showOriginal && (
          <OriginalTextEditor
            key={active.id}
            page={active}
            boxes={boxes}
            loading={readingText || runState.pageId !== active.id}
            busy={busy}
            positionReady={
              pageViewport.pageId === active.id &&
              pageViewport.rotation === (active.rotation ?? 0)
            }
            error=""
            selected={selected}
            drafts={drafts[active.id] ?? {}}
            setDrafts={(update) =>
              setDrafts((current) => ({
                ...current,
                [active.id]:
                  typeof update === "function"
                    ? update(current[active.id] ?? {})
                    : update,
              }))
            }
            onSelect={selectText}
            onJoin={joinText}
            onSelectLine={() => selectTextIds(lineSelection)}
            canSelectLine={lineSelection.length > selected.length}
            onUngroup={ungroupText}
            onMove={(ids, dx, dy) => {
              if (
                pageViewport.pageId !== active.id ||
                pageViewport.rotation !== (active.rotation ?? 0)
              )
                return;
              const delta = inverseVector(pageViewport.matrix, {
                x: dx,
                y: -dy,
              });
              moveText(ids, delta.x, delta.y);
            }}
            onClose={() => setTool("select")}
            onApply={(edits) => {
              if (busyRef.current)
                throw new Error(
                  "Please wait for the current PDF operation to finish.",
                );
              setFormatDrafts((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(
                    ([key]) => !key.startsWith(`${active.id}:`),
                  ),
                ),
              );
              commit(
                pages.map((page) =>
                  page.id === active.id ? applyTextEdits(page, edits) : page,
                ),
              );
            }}
          >
            {itemControls()}
            <ReferenceAlignment
              page={active}
              runs={runs}
              boxes={boxes}
              selected={selected}
              references={alignmentReferences[active.id] ?? emptyReferences}
              viewport={pageViewport.matrix}
              disabled={
                busy ||
                readingText ||
                boxes.some((b) => selected.includes(b.id) && b.locked) ||
                runState.pageId !== active.id ||
                pageViewport.pageId !== active.id ||
                pageViewport.rotation !== (active.rotation ?? 0)
              }
              onReferences={(references) =>
                setAlignmentReferences((current) => ({
                  ...current,
                  [active.id]: references,
                }))
              }
              onPin={() => {
                const runIds = boxes
                  .filter((box) => selected.includes(box.id))
                  .flatMap((box) =>
                    box.runs
                      .filter((run) =>
                        (
                          active.textReplacements?.find(
                            (edit) => edit.runId === run.id,
                          )?.replacement ?? run.text
                        ).trim(),
                      )
                      .map((run) => run.id),
                  );
                setAlignmentReferences((current) => ({
                  ...current,
                  [active.id]: { runIds: [...new Set(runIds)], shapeIds: [] },
                }));
                selectTextIds([]);
              }}
              onChange={(next) => {
                if (next !== active)
                  commit(pages.map((p) => (p.id === active.id ? next : p)));
              }}
            />
            <TextFormatting
              draft={formatDrafts[`${active.id}:${selected.join("|")}`]}
              onDraft={(paragraph) =>
                setFormatDrafts((current) => ({
                  ...current,
                  [`${active.id}:${selected.join("|")}`]: paragraph,
                }))
              }
              key={`${active.id}:${selected.join("|")}:${JSON.stringify(active.paragraphs ?? [])}`}
              page={active}
              runs={runs}
              boxes={boxes}
              selected={selected}
              disabled={
                busy ||
                readingText ||
                Object.keys(drafts[active.id] ?? {}).some((id) => {
                  const value = boxes
                    .flatMap((b) => b.runs)
                    .find((r) => r.id === id);
                  return (
                    value &&
                    drafts[active.id][id] !==
                      (active.textReplacements?.find((e) => e.runId === id)
                        ?.replacement ?? value.text)
                  );
                })
              }
              onMove={moveText}
              onChange={(next, selectedGroup) => {
                if (next.paragraphs !== active.paragraphs)
                  setFormatDrafts((current) =>
                    Object.fromEntries(
                      Object.entries(current).filter(
                        ([key]) => !key.startsWith(`${active.id}:`),
                      ),
                    ),
                  );
                commit(pages.map((p) => (p.id === active.id ? next : p)));
                const group = next.paragraphs?.find(
                  (p) => p.groupId === selectedGroup,
                );
                if (group)
                  setSelection({
                    pageId: active.id,
                    runIds:
                      next.textGroups?.find((g) => g.id === group.groupId)
                        ?.runIds ?? [],
                  });
              }}
            />
          </OriginalTextEditor>
        )}
        {tool === "select" && active && !showOriginal && (
          <aside className="inspector text-editor">
            <div className="panel-title">Arrange items</div>
            <p className="hint">
              Select text on the page, or click a rectangle border. Shift-click
              to select several items.
            </p>
            {itemControls()}
          </aside>
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
      {(dialog === "export" || dialog === "utilities") && (
        <PageUtilities
          activeIndex={activeIndex}
          mode={dialog === "export" ? "export" : "pages"}
          pages={pages}
          sources={sources}
          onChange={commit}
          onExport={download}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "search" && (
        <SearchPanel
          pages={pages}
          sources={sources}
          onChange={(next) => {
            const changed = pages
              .filter((page, index) => page !== next[index])
              .map((p) => p.id);
            setFormatDrafts((current) =>
              Object.fromEntries(
                Object.entries(current).filter(
                  ([key]) => !changed.some((id) => key.startsWith(`${id}:`)),
                ),
              ),
            );
            commit(next);
          }}
          onJump={(pageId, runIds) => {
            setActiveId(pageId);
            setShowOriginal(false);
            setTool("edit");
            setSelection({ pageId, runIds });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "pages" && (
        <PageOrganizer
          pages={pages}
          sources={sources}
          onChange={commit}
          onOpen={setActiveId}
          onInsert={() => input.current?.click()}
          onExtract={async (chosen) => {
            await download(chosen, "extracted-pages.pdf");
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "review" && (
        <ReviewPanel
          pages={pages}
          baseline={baseline}
          onJump={(id) => {
            setActiveId(id);
            setHighlight(true);
            setShowOriginal(false);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
