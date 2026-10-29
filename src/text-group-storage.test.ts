import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  PDFHexString,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";
import { inspectEditableText } from "./text-edit";
import { readDocumentTextGroups } from "./text-group-storage";
import { exportPdf } from "./pdf";
import type { EditorPage } from "./pdf";
import { joinTextBoxes } from "./text-boxes";

const key = PDFName.of("PDFeditorTextGroups");
async function fixture(duplicates = false) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    page = doc.addPage([400, 500]);
  page.drawText(duplicates ? "Same" : "Left", {
    font,
    x: 40,
    y: 400,
    size: 16,
  });
  page.drawText(duplicates ? "Same" : "Right", {
    font,
    x: duplicates ? 40 : 100,
    y: 400,
    size: 16,
  });
  page.drawText("Other", { font, x: 40, y: 350, size: 16 });
  return doc.save();
}
async function joined(duplicates = false) {
  const bytes = await fixture(duplicates),
    runs = await inspectEditableText(bytes, 0);
  const page: EditorPage = {
    id: "page",
    sourceId: "s",
    index: 0,
    annotations: [],
  };
  const model = joinTextBoxes(page, runs, [runs[0].id, runs[1].id], "g");
  return exportPdf([{ id: "s", name: "fixture.pdf", bytes }], [model]);
}
async function rewriteStreams(
  bytes: Uint8Array,
  change: (text: string) => string,
) {
  const doc = await PDFDocument.load(bytes),
    page = doc.getPage(0),
    contents = page.node.Contents()!;
  const entries =
    contents instanceof PDFArray ? contents.asArray() : [contents];
  const text = entries
    .map((ref) =>
      Array.from(
        decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode(),
        (byte) => String.fromCharCode(byte),
      ).join(""),
    )
    .join("\n");
  const changed = Uint8Array.from(change(text), (char) => char.charCodeAt(0));
  page.node.set(
    PDFName.of("Contents"),
    doc.context.register(doc.context.flateStream(changed)),
  );
  return doc.save();
}
describe("resilient joined-box storage", () => {
  it("restores large Unicode groups without exceeding JavaScript argument limits", async () => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica),
      page = doc.addPage([400, 500]);
    for (let i = 0; i < 800; i++)
      page.drawText(`“Item (${i})” – £10`, {
        font,
        size: 12,
        x: 20 + (i % 10) * 20,
        y: 470 - Math.floor(i / 10) * 5,
      });
    const bytes = await doc.save(),
      runs = await inspectEditableText(bytes, 0);
    const model = joinTextBoxes(
      { id: "p", sourceId: "s", index: 0, annotations: [] },
      runs,
      runs.map((run) => run.id),
      "joined:(🧩)",
    );
    const saved = await exportPdf(
      [{ id: "s", name: "large.pdf", bytes }],
      [model],
    );
    const loaded = await PDFDocument.load(saved),
      value = loaded.getPage(0).node.lookup(key, PDFHexString);
    expect(value.asBytes().length).toBeGreaterThan(300000);
    const groups = (await readDocumentTextGroups(saved))[0];
    expect(groups[0].id).toBe("joined:(🧩)");
    expect(groups[0].runIds).toHaveLength(800);
  });
  it("restores a group after content streams are merged and reformatted by another writer", async () => {
    const bytes = await joined(),
      before = await inspectEditableText(bytes, 0);
    const rewritten = await rewriteStreams(
      bytes,
      (text) => "% reformatted\n\n" + text + "\n% end\n",
    );
    const after = await inspectEditableText(rewritten, 0),
      groups = (await readDocumentTextGroups(rewritten))[0];
    expect(after[0].id).not.toBe(before[0].id);
    expect(groups).toEqual([{ id: "g", runIds: [after[0].id, after[1].id] }]);
  });
  it("does not attach a group to changed text merely because an old stream offset still exists", async () => {
    const bytes = await joined();
    const rewritten = await rewriteStreams(bytes, (text) =>
      text.replace("4C656674", "4C6F7374"),
    );
    expect((await inspectEditableText(rewritten, 0))[0].text).toBe("Lost");
    expect((await readDocumentTextGroups(rewritten))[0]).toEqual([]);
  });
  it("keeps exact overlapping pieces when unchanged but rejects ambiguous remapping after a rewrite", async () => {
    const bytes = await joined(true);
    expect((await readDocumentTextGroups(bytes))[0][0].runIds).toHaveLength(2);
    const rewritten = await rewriteStreams(
      bytes,
      (text) => "% changed offsets\n" + text,
    );
    expect((await readDocumentTextGroups(rewritten))[0]).toEqual([]);
  });
  it("isolates malformed entries rather than losing unrelated valid groups", async () => {
    const doc = await PDFDocument.load(await joined());
    const value = JSON.parse(
      doc.getPage(0).node.lookup(key, PDFHexString).decodeText(),
    );
    value.groups.unshift(null, { id: "bad", members: [null] });
    doc.getPage(0).node.set(key, PDFString.of(JSON.stringify(value)));
    expect(
      (await readDocumentTextGroups(await doc.save()))[0].map(
        (group) => group.id,
      ),
    ).toEqual(["g"]);
  });
  it("reads legacy files safely and never partially restores a group with a missing piece", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0),
      doc = await PDFDocument.load(bytes);
    doc.getPage(0).node.set(
      key,
      PDFString.of(
        JSON.stringify({
          version: 1,
          groups: [
            { id: "missing", runIds: [runs[0].id, "99:99"] },
            { id: "valid", runIds: [runs[1].id, runs[2].id] },
          ],
        }),
      ),
    );
    expect((await readDocumentTextGroups(await doc.save()))[0]).toEqual([
      { id: "valid", runIds: [runs[1].id, runs[2].id] },
    ]);
  });
  it("refuses to export stale or overlapping group membership", async () => {
    const bytes = await fixture(),
      runs = await inspectEditableText(bytes, 0);
    const page: EditorPage = {
      id: "p",
      sourceId: "s",
      index: 0,
      annotations: [],
      textGroups: [{ id: "g", runIds: [runs[0].id, "missing"] }],
    };
    await expect(
      exportPdf([{ id: "s", name: "fixture.pdf", bytes }], [page]),
    ).rejects.toThrow("stale or overlapping");
  });
  it("keeps groups page-local across reordered and duplicated pages", async () => {
    const bytes = await joined(),
      groups = (await readDocumentTextGroups(bytes))[0];
    const page: EditorPage = {
      id: "p",
      sourceId: "s",
      index: 0,
      annotations: [],
      textGroups: groups,
    };
    const saved = await exportPdf(
      [{ id: "s", name: "fixture.pdf", bytes }],
      [page, { ...page, id: "copy" }],
    );
    const restored = await readDocumentTextGroups(saved);
    expect(restored).toHaveLength(2);
    expect(restored[0][0].runIds).toHaveLength(2);
    expect(restored[1]).toEqual(restored[0]);
  });
});
