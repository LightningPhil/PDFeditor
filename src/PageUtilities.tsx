import { useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EditorPage, Source } from "./pdf";
import {
  parsePageRange,
  safePdfFilename,
  pageFrame,
  cropWithMargins,
  stampPages,
} from "./page-extras";
import type { PageFrame, StampSettings } from "./page-extras";
import { textFonts } from "./typography";
import { readStyleLibrary } from "./style-library";
export function PageUtilities({
  mode,
  pages,
  sources,
  onChange,
  onExport,
  onClose,
  activeIndex = 0,
}: {
  mode: "export" | "pages";
  pages: EditorPage[];
  sources: (Source & { document: PDFDocumentProxy })[];
  onChange: (pages: EditorPage[]) => void;
  onExport: (pages: EditorPage[], name: string) => Promise<boolean>;
  onClose: () => void;
  activeIndex?: number;
}) {
  const [tab, setTab] = useState<"numbers" | "headers" | "crop">("numbers"),
    [range, setRange] = useState(""),
    [filename, setFilename] = useState(
      (sources[0]?.name.replace(/\.pdf$/i, "") ?? "document") + "-edited.pdf",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const last = readStyleLibrary().last;
  const [settings, setSettings] = useState<StampSettings>({
      kind: "numbers",
      range: "",
      format: "{n}",
      start: 1,
      position: "bottom",
      align: "center",
      header: "",
      footer: "",
      font: last.font,
      size: 12,
      color: last.color,
      margin: 28,
      date: new Date().toISOString().slice(0, 10),
    }),
    [margins, setMargins] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const update = (patch: Partial<StampSettings>) =>
    setSettings((s) => ({ ...s, ...patch }));
  let chosen: number[] = [],
    rangeError = "";
  try {
    chosen = parsePageRange(range, pages.length);
  } catch (e) {
    rangeError = String(e instanceof Error ? e.message : e);
  }
  async function apply(reset = false) {
    setBusy(true);
    setError("");
    try {
      if (rangeError) throw Error(rangeError);
      if (mode === "export") {
        const exported = await onExport(
          chosen.map((i) => pages[i]),
          safePdfFilename(filename),
        );
        if (exported) onClose();
        else
          setError(
            "Export failed. Your settings are retained; check the document error and try again.",
          );
        return;
      }
      const frames = new Map<string, PageFrame>();
      for (const i of chosen) {
        const p = pages[i],
          source = sources.find((s) => s.id === p.sourceId)!;
        const original = await source.document.getPage(p.index + 1);
        frames.set(p.id, pageFrame(original, p));
      }
      const selected = new Set(chosen);
      onChange(
        tab === "crop"
          ? pages.map((p, i) =>
              !selected.has(i)
                ? p
                : reset
                  ? { ...p, crop: undefined }
                  : cropWithMargins(p, frames.get(p.id)!, margins),
            )
          : stampPages(
              pages,
              frames,
              new Map(sources.map((s) => [s.id, s.name])),
              {
                ...settings,
                kind: tab === "numbers" ? "numbers" : "headers",
                range,
              },
              () => crypto.randomUUID(),
            ),
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dialog-backdrop">
      <section
        className="workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "export" ? "Export pages" : "Page tools"}
      >
        <div className="panel-title">
          {mode === "export" ? "Export PDF" : "Page tools"}
          <button
            aria-label="Close page tools"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <fieldset disabled={busy} className="utility-fields">
          {mode !== "export" && (
            <div className="button-wrap">
              {(
                [
                  ["numbers", "Page numbers"],
                  ["headers", "Headers & footers"],
                  ["crop", "Crop pages"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={tab === id}
                  onClick={() => {
                    setTab(id);
                    if (id === "crop" && !range.trim())
                      setRange(String(activeIndex + 1));
                    setError("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <label>
            Pages
            <input
              aria-label="Page range"
              placeholder="All pages, or 1–3, 7, 10–12"
              value={range}
              onChange={(e) => setRange(e.target.value)}
            />
          </label>
          <p className="hint">
            {rangeError ||
              `${chosen.length} pages selected. Range order is preserved; repeats are included once.`}
          </p>
          {mode === "export" ? (
            <label>
              Filename
              <input
                aria-label="Export filename"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
              />
            </label>
          ) : tab === "crop" ? (
            <>
              <p className="hint">
                Trim margins in points from the displayed page edges. Apply to
                one page or a range. Cropping hides content; it does not
                securely remove it.
              </p>
              <div className="form-grid">
                {(["left", "right", "top", "bottom"] as const).map((side) => (
                  <label key={side}>
                    {side} margin
                    <input
                      aria-label={`Crop ${side} margin`}
                      type="number"
                      min="0"
                      value={margins[side]}
                      onChange={(e) =>
                        setMargins((m) => ({
                          ...m,
                          [side]: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <button disabled={!!rangeError} onClick={() => void apply(true)}>
                Restore original crop
              </button>
            </>
          ) : (
            <>
              {tab === "numbers" ? (
                <div className="form-grid">
                  <label>
                    Number format
                    <input
                      aria-label="Page number format"
                      value={settings.format}
                      onChange={(e) => update({ format: e.target.value })}
                    />
                  </label>
                  <label>
                    Start at
                    <input
                      aria-label="Page number start"
                      type="number"
                      min="0"
                      value={settings.start}
                      onChange={(e) =>
                        update({ start: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Position
                    <select
                      aria-label="Page number position"
                      value={settings.position}
                      onChange={(e) =>
                        update({
                          position: e.target.value as StampSettings["position"],
                        })
                      }
                    >
                      <option value="top">Top</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </label>
                </div>
              ) : (
                <>
                  <label>
                    Header
                    <input
                      aria-label="Header text"
                      value={settings.header}
                      onChange={(e) => update({ header: e.target.value })}
                    />
                  </label>
                  <label>
                    Footer
                    <input
                      aria-label="Footer text"
                      value={settings.footer}
                      onChange={(e) => update({ footer: e.target.value })}
                    />
                  </label>
                </>
              )}
              <p className="hint">
                Tokens: {"{n}"} = sequence, {"{page}"} = page position,{" "}
                {"{pages}"} = document total, {"{filename}"}, {"{date}"}.
                Existing workspace stamps of this type are replaced on the
                chosen pages. Numbering and footer lanes avoid each other.
                Reapply after reordering pages.
              </p>
              <label>
                Font
                <select
                  aria-label="Stamp font"
                  value={settings.font}
                  onChange={(e) =>
                    update({ font: e.target.value as StampSettings["font"] })
                  }
                >
                  {textFonts.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <div className="form-grid">
                <label>
                  Size
                  <input
                    aria-label="Stamp size"
                    type="number"
                    min="1"
                    value={settings.size}
                    onChange={(e) => update({ size: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Margin
                  <input
                    aria-label="Stamp margin"
                    type="number"
                    min="0"
                    value={settings.margin}
                    onChange={(e) => update({ margin: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Colour
                  <input
                    aria-label="Stamp colour"
                    type="color"
                    value={settings.color}
                    onChange={(e) => update({ color: e.target.value })}
                  />
                </label>
                <label>
                  Alignment
                  <select
                    aria-label="Stamp alignment"
                    value={settings.align}
                    onChange={(e) =>
                      update({
                        align: e.target.value as StampSettings["align"],
                      })
                    }
                  >
                    <option value="left">Left</option>
                    <option value="center">Centre</option>
                    <option value="right">Right</option>
                  </select>
                </label>
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="edit-error">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={
              !!rangeError ||
              !chosen.length ||
              (mode !== "export" &&
                tab === "headers" &&
                !settings.header.trim() &&
                !settings.footer.trim())
            }
            onClick={() => void apply()}
          >
            {busy
              ? "Working…"
              : mode === "export"
                ? "Download PDF"
                : tab === "crop"
                  ? "Apply crop"
                  : "Apply to selected pages"}
          </button>
        </fieldset>
      </section>
    </div>
  );
}
