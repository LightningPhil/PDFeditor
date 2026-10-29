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
