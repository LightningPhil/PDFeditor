import { useEffect, useMemo, useState } from "react";
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import { exportPagePreview } from "./pdf";
import type { EditorPage, Source } from "./pdf";
import type { EditableRun } from "./text-edit";
import { inspectEditableText } from "./text-edit";
import { findText, replacementEdits } from "./search";
import type { SearchMatch } from "./search";
import { applyTextEdits } from "./document-editing";
export function SearchPanel({
  pages,
  sources,
  onChange,
  onJump,
  onClose,
}: {
  pages: EditorPage[];
  sources: (Source & { document: PDFDocumentProxy })[];
  onChange: (pages: EditorPage[]) => void;
  onJump: (pageId: string, runIds: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [replacement, setReplacement] = useState(""),
    [sensitive, setSensitive] = useState(false),
    [whole, setWhole] = useState(false);
  const [index, setIndex] = useState<Map<string, EditableRun[]>>(new Map()),
    [fallback, setFallback] = useState<Map<string, string>>(new Map()),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false),
    [current, setCurrent] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPreview(false);
    void (async () => {
      const next = new Map<string, EditableRun[]>(),
        other = new Map<string, string>();
      for (const page of pages) {
        if (cancelled) return;
        const source = sources.find((s) => s.id === page.sourceId)!;
        const runs = await inspectEditableText(
          source.bytes,
          page.index,
          page.textReplacements,
        );
        next.set(page.id, runs);
        {
          let task: PDFDocumentLoadingTask | undefined;
          try {
            const modified =
              page.annotations.length ||
              page.textReplacements?.length ||
              page.textOffsets?.length;
            const document = modified
              ? await (task = getDocument({
                  data: await exportPagePreview(source, page, true),
                  standardFontDataUrl: "/pdfjs/standard_fonts/",
                  cMapUrl: "/pdfjs/cmaps/",
                  cMapPacked: true,
                  wasmUrl: "/pdfjs/wasm/",
                })).promise
              : source.document;
            const pdf = await document.getPage(modified ? 1 : page.index + 1),
              content = await pdf.getTextContent();
            other.set(
              page.id,
              content.items
                .flatMap((item) => ("str" in item ? [item.str] : []))
                .join(" "),
            );
          } finally {
            void task?.destroy();
          }
        }
      }
      if (!cancelled) {
        setIndex(next);
        setFallback(other);
        setLoading(false);
      }
    })().catch((e) => {
      if (!cancelled) {
        setError(String(e));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pages, sources]);
  const matches = useMemo(
    () =>
      pages.flatMap((page) =>
        findText(page, index.get(page.id) ?? [], query, sensitive, whole),
      ),
    [pages, index, query, sensitive, whole],
  );
  const readonlyHits = [...fallback].flatMap(([id, text]) => {
    const raw: EditableRun = { id: "readonly", text, font: "", characters: "" };
    const all = findText(
      { id, sourceId: "", index: 0, annotations: [] },
      [raw],
      query,
      sensitive,
      whole,
    );
    return all
      .slice(matches.filter((m) => m.pageId === id).length)
      .map((match) => [id, match.context] as const);
  });
  const replacementPlan = useMemo(() => {
    const changes = new Map<string, ReturnType<typeof replacementEdits>>();
    let error = "";
    try {
      for (const page of pages) {
        const found = matches.filter((m) => m.pageId === page.id);
        if (found.length)
          changes.set(page.id, replacementEdits(found, replacement));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { changes, error };
  }, [pages, matches, replacement]);
  function jump(match: SearchMatch, position: number) {
    setCurrent(position);
    onJump(match.pageId, [...new Set(match.segments.map((s) => s.run.id))]);
  }
  function replace(which: SearchMatch[]) {
    try {
      const next = pages.map((page) => {
        const found = which.filter((m) => m.pageId === page.id);
        return found.length
          ? applyTextEdits(page, replacementEdits(found, replacement))
          : page;
      });
      onChange(next);
      setPreview(false);
      setCurrent(0);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Find and replace"
        className="workspace-dialog search-dialog"
      >
        <div className="panel-title">
          Find & replace
          <button onClick={onClose} aria-label="Close search">
            ×
          </button>
        </div>
        <label>
          Find
          <input
            autoFocus
            aria-label="Find text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPreview(false);
              setCurrent(0);
            }}
          />
        </label>
        <label>
          Replace with
          <input
            aria-label="Replace with"
            value={replacement}
            onChange={(e) => {
              setReplacement(e.target.value);
              setPreview(false);
            }}
          />
        </label>
        <div className="button-wrap">
          <label>
            <input
              type="checkbox"
              checked={sensitive}
              onChange={(e) => setSensitive(e.target.checked)}
            />{" "}
            Match case
          </label>
          <label>
            <input
              type="checkbox"
              checked={whole}
              onChange={(e) => setWhole(e.target.checked)}
            />{" "}
            Whole words
          </label>
        </div>
        <p role="status">
          {loading
            ? "Reading document…"
            : `${matches.length} editable matches${readonlyHits.length ? ` · ${readonlyHits.length} read-only matches` : ""} across ${pages.length} pages`}
        </p>
        <div className="button-wrap">
          <button
            disabled={!matches.length}
            onClick={() =>
              jump(
                matches[(current + matches.length - 1) % matches.length],
                (current + matches.length - 1) % matches.length,
              )
            }
          >
            Previous match
          </button>
          <button
            disabled={!matches.length}
            onClick={() =>
              jump(
                matches[(current + 1) % matches.length],
                (current + 1) % matches.length,
              )
            }
          >
            Next match
          </button>
          <button
            disabled={loading || !matches.length}
            onClick={() => setPreview(true)}
          >
            Preview replacements
          </button>
        </div>
        {(error || replacementPlan.error) && (
          <p role="alert" className="edit-error">
            {error || replacementPlan.error}
          </p>
        )}
        {preview && (
          <div className="replacement-preview">
            <strong>{matches.length} replacements ready for review</strong>
            <p>
              “{query}” → “{replacement}”. Surrounding text stays at its
              original position; a longer replacement may overlap it.
            </p>
            <button
              disabled={!!replacementPlan.error}
              onClick={() => replace([matches[current] ?? matches[0]])}
            >
              Replace current
            </button>
            <button
              className="primary"
              disabled={!!replacementPlan.error}
              onClick={() => replace(matches)}
            >
              Apply all replacements
            </button>
          </div>
        )}
        <div className="search-results">
          {matches.map((match, i) => (
            <button
              key={`${match.pageId}:${match.start}`}
              className={current === i ? "active" : ""}
              onClick={() => jump(match, i)}
            >
              <strong>
                Page {pages.findIndex((p) => p.id === match.pageId) + 1}
              </strong>
              <span>{match.context}</span>
            </button>
          ))}
          {readonlyHits.map(([id, text], index) => (
            <button key={`${id}:${index}`} onClick={() => onJump(id, [])}>
              <strong>
                Page {pages.findIndex((p) => p.id === id) + 1} · read only
              </strong>
              <span>
                {text.slice(
                  Math.max(
                    0,
                    text.toLowerCase().indexOf(query.toLowerCase()) - 25,
                  ),
                  Math.max(
                    0,
                    text.toLowerCase().indexOf(query.toLowerCase()) - 25,
                  ) + 100,
                )}
              </span>
            </button>
          ))}
        </div>
        <p className="hint">
          Search spans PDF text fragments. Scans need OCR; unsupported original
          font encodings remain read only.
        </p>
      </section>
    </div>
  );
}
