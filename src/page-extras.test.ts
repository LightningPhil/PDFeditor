import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import {
  parsePageRange,
  safePdfFilename,
  pageFrame,
  cropWithMargins,
  stampPages,
} from "./page-extras";
import type { StampSettings } from "./page-extras";
import type { EditorPage } from "./pdf";
import { exportPdf } from "./pdf";
import { inspectEditableText } from "./text-edit";
import { bounds, transform } from "./geometry";
import { getAllTextRuns } from "./text-boxes";
const model = (id = "p", index = 0): EditorPage => ({
  id,
  index,
  sourceId: "s",
  annotations: [],
});
describe("page convenience features", () => {
  it("keeps page numbers and footers in distinct lanes in either application order", () => {
    const pages = [model()],
      frame = pageFrame(
        { view: [0, 0, 400, 500], rotate: 0, userUnit: 1 },
        pages[0],
      ),
      frames = new Map([["p", frame]]);
    const settings: StampSettings = {
      kind: "numbers",
      range: "",
      format: "Page {n}",
      start: 1,
      position: "bottom",
      align: "center",
      header: "",
      footer: "Reviewed",
      font: "Helvetica",
      size: 12,
      color: "#000000",
      margin: 24,
      date: "2026-10-29",
    };
    for (const order of [
      ["numbers", "headers"],
      ["headers", "numbers"],
    ] as const) {
      let n = 0;
      let next = pages;
      for (const kind of order)
        next = stampPages(next, frames, new Map(), { ...settings, kind }, () =>
          String(n++),
        );
      const boxes = getAllTextRuns(next[0], []).map((r) =>
        bounds(r.geometry!.quad.map((p) => transform(frame.matrix, p))),
      );
      expect(boxes).toHaveLength(2);
      expect(Math.abs(boxes[0].y - boxes[1].y)).toBeGreaterThan(
        Math.max(boxes[0].height, boxes[1].height) + 2,
      );
    }
  });
  it("parses page ranges without duplicates and rejects invalid or out-of-bounds input", () => {
    expect(parsePageRange("1–3, 7, 10-12, 2", 12)).toEqual([
      0, 1, 2, 6, 9, 10, 11,
    ]);
    expect(parsePageRange("3,1", 3)).toEqual([2, 0]);
    expect(parsePageRange("", 2)).toEqual([0, 1]);
    for (const value of ["0", "4", "3-1", "1,,2", "x", "1-999999999"])
      expect(() => parsePageRange(value, 3)).toThrow();
    expect(safePdfFilename(" my:report.PDF ")).toBe("my_report.pdf");
  });
  for (const rotate of [0, 90, 180, 270])
    it(`crops visible margins on rotated, scaled pages with nonzero origins (${rotate})`, () => {
      const source = { view: [20, 30, 420, 530], rotate, userUnit: 2 },
        p = model(),
        frame = pageFrame(source, p),
        next = cropWithMargins(p, frame, {
          left: 10,
          right: 20,
          top: 30,
          bottom: 40,
        }),
        after = pageFrame(source, next);
      expect(after.width).toBeCloseTo(frame.width - 30, 8);
      expect(after.height).toBeCloseTo(frame.height - 70, 8);
      expect(p.crop).toBeUndefined();
      expect(() =>
        cropWithMargins(p, frame, {
          left: frame.width,
          right: 0,
          top: 0,
          bottom: 0,
        }),
      ).toThrow();
    });
  it("numbers a selected range, writes native upright text on rotated pages and replaces stamps", async () => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    doc
      .addPage([400, 500])
      .drawText("First", { font, x: 30, y: 400, size: 12 });
    doc.addPage([400, 500]).setRotation(degrees(90));
    const bytes = await doc.save(),
      pages = [model("one", 0), model("two", 1)],
      frames = new Map(
        pages.map((p, i) => [
          p.id,
          pageFrame({ view: [0, 0, 400, 500], rotate: i * 90, userUnit: 1 }, p),
        ]),
      );
    const settings: StampSettings = {
      kind: "numbers",
      range: "2",
      format: "Page {n} / {pages}",
      start: 7,
      position: "bottom",
      align: "center",
      header: "",
      footer: "",
      font: "Helvetica",
      size: 12,
      color: "#225588",
      margin: 24,
      date: "2026-10-29",
    };
    let n = 0;
    const numbered = stampPages(
      pages,
      frames,
      new Map([["s", "example.pdf"]]),
      settings,
      () => `s${n++}`,
    );
    expect(numbered[0]).toBe(pages[0]);
    expect(numbered[1].annotations).toHaveLength(1);
    const stamp = numbered[1].annotations[0];
    expect(stamp.kind === "text" && stamp.text).toBe("Page 7 / 2");
    expect(stamp.rotation).toBe(90);
    expect(transform(frames.get("two")!.matrix, stamp).y).toBe(376);
    const again = stampPages(
      numbered,
      frames,
      new Map(),
      { ...settings, start: 8 },
      () => `s${n++}`,
    );
    expect(again[1].annotations).toHaveLength(1);
    const saved = await exportPdf(
      [{ id: "s", name: "fixture.pdf", bytes }],
      again,
    );
    expect((await inspectEditableText(saved, 0)).map((r) => r.text)).toEqual([
      "First",
    ]);
    expect((await inspectEditableText(saved, 1)).map((r) => r.text)).toEqual([
      "Page 8 / 2",
    ]);
  });
  it("adds repeatable headers/footers with tokens and does not replace locked stamps", () => {
    const pages = [model()],
      frames = new Map([
        [
          "p",
          pageFrame(
            { view: [0, 0, 400, 500], rotate: 0, userUnit: 1 },
            pages[0],
          ),
        ],
      ]);
    const settings: StampSettings = {
      kind: "headers",
      range: "",
      format: "",
      start: 1,
      position: "top",
      align: "left",
      header: "{filename}",
      footer: "{date} · {page}/{pages}",
      font: "Helvetica",
      size: 10,
      color: "#000000",
      margin: 20,
      date: "2026-10-29",
    };
    let n = 0;
    const first = stampPages(
      pages,
      frames,
      new Map([["s", "File.pdf"]]),
      settings,
      () => String(n++),
    );
    expect(
      first[0].annotations.map((a) => a.kind === "text" && a.text),
    ).toEqual(["File.pdf", "2026-10-29 · 1/1"]);
    expect(
      stampPages(first, frames, new Map(), settings, () => String(n++))[0]
        .annotations,
    ).toHaveLength(1);
    const locked = {
      ...first[0],
      annotations: first[0].annotations.map((a) => ({ ...a, locked: true })),
    };
    expect(() =>
      stampPages([locked], frames, new Map(), settings, () => String(n++)),
    ).toThrow("Unlock");
  });
});
