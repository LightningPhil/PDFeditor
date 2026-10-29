import { describe, expect, it } from "vitest";
import {
  PDFDocument,
  StandardFonts,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { exportPdf } from "./pdf";
import type { EditorPage, Source } from "./pdf";
import { movePagesTo, duplicatePages } from "./page-operations";
import { inspectEditableText } from "./text-edit";

async function fixture(): Promise<Source> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([300, 400])
    .drawText("First page original text", { font, size: 14 });
  pdf
    .addPage([500, 600])
    .drawText("Second page original text", { font, size: 14 });
  return { id: "source", name: "fixture.pdf", bytes: await pdf.save() };
}
const page = (id: string, index: number): EditorPage => ({
  id,
  sourceId: "source",
  index,
  annotations: [],
});

describe("PDF export", () => {
  it("exports one final document after cross-file moves, removals, duplication and text editing", async () => {
    const first = await fixture(),
      other = await PDFDocument.create(),
      font = await other.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 3; n++)
      other
        .addPage([300 + n * 10, 400])
        .drawText(`File B page ${n}`, { font, size: 12 });
    const second: Source = {
        id: "second",
        name: "second.pdf",
        bytes: await other.save(),
      },
      originals = [first.bytes.slice(), second.bytes.slice()];
    let pages = [
      page("a1", 0),
      page("a2", 1),
      ...[0, 1, 2].map((index) => ({
        ...page(`b${index + 1}`, index),
        sourceId: second.id,
      })),
    ];
    pages = movePagesTo(pages, ["a2", "b3"], 0).filter(
      (p) => !["a1", "b1"].includes(p.id),
    );
    pages = duplicatePages(pages, ["b3"], () => "b-copy");
    const run = (await inspectEditableText(first.bytes, 1))[0];
    pages[0] = {
      ...pages[0],
      textReplacements: [
        {
          runId: run.id,
          original: run.text,
          replacement: "Edited page from file A",
        },
      ],
    };
    const output = await exportPdf([first, second], pages),
      reopened = await PDFDocument.load(output);
    expect(reopened.getPageCount()).toBe(4);
    expect(reopened.getPages().map((p) => p.getWidth())).toEqual([
      500, 330, 330, 320,
    ]);
    const text = [];
    for (let i = 0; i < 4; i++)
      text.push(
        (await inspectEditableText(output, i)).map((r) => r.text).join(" "),
      );
    expect(text).toEqual([
      "Edited page from file A",
      "File B page 3",
      "File B page 3",
      "File B page 2",
    ]);
    expect(first.bytes).toEqual(originals[0]);
    expect(second.bytes).toEqual(originals[1]);
  });
  it("reorders, omits and repeats pages without changing the source", async () => {
    const source = await fixture();
    const original = source.bytes.slice();
    const result = await PDFDocument.load(
      await exportPdf([source], [page("b", 1), page("a", 0), page("c", 1)]),
    );
    expect(result.getPages().map((p) => p.getSize())).toEqual([
      { width: 500, height: 600 },
      { width: 300, height: 400 },
      { width: 500, height: 600 },
    ]);
    expect(source.bytes).toEqual(original);
    const removed = await PDFDocument.load(
      await exportPdf([source], [page("b", 1)]),
    );
    expect(removed.getPageCount()).toBe(1);
  });
  it("merges pages from separate documents and writes annotation content", async () => {
    const first = await fixture();
    const second = { ...(await fixture()), id: "second" };
    const annotated = page("a", 0);
    annotated.annotations = [
      {
        id: "text",
        kind: "text",
        text: "New annotation",
        x: 35,
        y: 80,
        size: 16,
        color: "#297768",
      },
      {
        id: "rect",
        kind: "rectangle",
        x: 20,
        y: 30,
        width: 50,
        height: 70,
        color: "#297768",
      },
    ];
    const result = await PDFDocument.load(
      await exportPdf(
        [first, second],
        [annotated, { ...page("b", 1), sourceId: "second" }],
      ),
    );
    expect(result.getPageCount()).toBe(2);
    const contents = result.getPage(0).node.Contents();
    expect(contents).toBeInstanceOf(PDFArray);
    const streams = (contents as PDFArray)
      .asArray()
      .map((ref) => result.context.lookup(ref) as PDFRawStream);
    const operators = streams
      .map((stream) =>
        new TextDecoder().decode(decodePDFRawStream(stream).decode()),
      )
      .join("\n");
    // Original text and the added text must both remain in the output streams.
    expect(operators).toContain(
      "46697273742070616765206F726967696E616C2074657874",
    );
    expect(operators).toContain("4E657720616E6E6F746174696F6E");
    expect(operators).toContain("35 80 Tm");
    expect(operators).toContain("50 0 l");
  });
  it("reports empty documents, missing sources and unsupported text", async () => {
    await expect(exportPdf([], [])).rejects.toThrow("at least one page");
    await expect(exportPdf([], [page("a", 0)])).rejects.toThrow(
      "Source PDF missing",
    );
    const annotated = page("a", 0);
    annotated.annotations = [
      {
        id: "t",
        kind: "text",
        text: "你好",
        x: 10,
        y: 10,
        size: 16,
        color: "#297768",
      },
    ];
    await expect(exportPdf([await fixture()], [annotated])).rejects.toThrow(
      "unsupported characters",
    );
  });
});
