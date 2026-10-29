import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";
import { inspectEditableText, replacePageText } from "./text-edit";
import { exportPdf } from "./pdf";

async function fixture(content?: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 500]);
  page.drawText("Original title", { x: 30, y: 400, font, size: 20 });
  if (content) {
    const key = page.node
      .Resources()!
      .lookup(PDFName.of("Font"))!
      .toString()
      .match(/\/(Helvetica-[^ ]+)/)![1];
    page.node.set(
      PDFName.of("Contents"),
      doc.context.register(
        doc.context.flateStream(content.replaceAll("/F1", "/" + key)),
      ),
    );
  }
  return doc.save();
}
function decoded(doc: PDFDocument, index = 0) {
  const contents = doc.getPage(index).node.Contents()!;
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((ref) =>
      new TextDecoder().decode(
        decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode(),
      ),
    )
    .join("\n");
}

describe("original text editing", () => {
  it("replaces the original operator and preserves other copies of the same page", async () => {
    const bytes = await fixture();
    const [run] = await inspectEditableText(bytes, 0);
    expect(run.text).toBe("Original title");
    const output = await exportPdf(
      [{ id: "s", name: "original.pdf", bytes }],
      [
        {
          id: "a",
          sourceId: "s",
          index: 0,
          annotations: [],
          textReplacements: [
            { runId: run.id, original: run.text, replacement: "Edited title" },
          ],
        },
        { id: "b", sourceId: "s", index: 0, annotations: [] },
      ],
    );
    const edited = await PDFDocument.load(output);
    expect((await inspectEditableText(output, 0))[0].text).toBe("Edited title");
    expect((await inspectEditableText(output, 1))[0].text).toBe(
      "Original title",
    );
    expect((await inspectEditableText(bytes, 0))[0].text).toBe(
      "Original title",
    );
    expect(decoded(edited)).not.toContain("4F726967696E616C207469746C65");
    expect(decoded(edited)).toContain("1 0 0 1 30 400 Tm");
    expect(decoded(edited)).not.toMatch(/\bre\b/); // No rectangle or cover-up.
  });
  it("handles strings with escapes, nested parentheses, comments, and TJ kerning", async () => {
    const bytes = await fixture(
      "BT /F1 20 Tf 30 400 Td [(Hello\\040) 10 (world \\(test\\))] TJ ET\n% (Fake) Tj\n",
    );
    const [run] = await inspectEditableText(bytes, 0);
    expect(run.text).toBe("Hello world (test)");
    const doc = await PDFDocument.load(bytes);
    replacePageText(doc.getPage(0), [
      { runId: run.id, original: run.text, replacement: "Changed (test)" },
    ]);
    expect((await inspectEditableText(await doc.save(), 0))[0].text).toBe(
      "Changed (test)",
    );
    const nested = await inspectEditableText(
      await fixture("BT /F1 12 Tf (Nested (parentheses)) Tj ET"),
      0,
    );
    expect(nested[0].text).toBe("Nested (parentheses)");
  });
  it("keeps split text, inline images, clipping text and ActualText read-only", async () => {
    for (const content of [
      "BT /F1 12 Tf (One) Tj (Two) Tj ET",
      "BI /W 1 /H 1 ID bytes EI BT /F1 12 Tf (Text) Tj ET",
      "BT /F1 12 Tf 7 Tr (Clip) Tj ET",
      "/Span << /ActualText (Old) >> BDC BT /F1 12 Tf (Text) Tj ET EMC",
    ]) {
      expect(await inspectEditableText(await fixture(content), 0)).toEqual([]);
    }
  });
  it("rejects stale identifiers, unsupported characters and multiline edits", async () => {
    const bytes = await fixture();
    const [run] = await inspectEditableText(bytes, 0);
    const doc = await PDFDocument.load(bytes);
    expect(() =>
      replacePageText(doc.getPage(0), [
        { runId: run.id, original: "Wrong", replacement: "Test" },
      ]),
    ).toThrow("original text changed");
    expect(() =>
      replacePageText(doc.getPage(0), [
        { runId: run.id, original: run.text, replacement: "你好" },
      ]),
    ).toThrow("does not contain");
    expect(() =>
      replacePageText(doc.getPage(0), [
        { runId: run.id, original: run.text, replacement: "Two\nlines" },
      ]),
    ).toThrow("single line");
  });
});
