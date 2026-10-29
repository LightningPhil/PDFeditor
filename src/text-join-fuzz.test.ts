/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { inspectEditableText } from "./text-edit";
import {
  getTextBoxes,
  joinTextBoxes,
  moveTextBoxes,
  ungroupTextBoxes,
} from "./text-boxes";
import { readDocumentTextGroups } from "./text-group-storage";
import { exportPdf } from "./pdf";
import type { EditorPage } from "./pdf";

const fontsUrl = fileURLToPath(
  new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
).replaceAll("\\", "/");
async function imageHash(bytes: Uint8Array) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl: fontsUrl,
  });
  try {
    const page = await (await task.promise).getPage(1),
      viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    return createHash("sha256")
      .update(
        canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
          .data,
      )
      .digest("hex");
  } finally {
    await task.destroy();
  }
}
async function save(bytes: Uint8Array, page: EditorPage) {
  return exportPdf([{ id: "s", name: "fixture.pdf", bytes }], [page]);
}
describe("randomised render-preserving joins", () => {
  for (let seed = 1; seed <= 16; seed++)
    it(`preserves styling and placement across export cycles (seed ${seed})`, async () => {
      let value = seed;
      const random = () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
      };
      const doc = await PDFDocument.create(),
        page = doc.addPage([320, 260]);
      const names = [
        StandardFonts.Helvetica,
        StandardFonts.TimesRomanItalic,
        StandardFonts.CourierBold,
        StandardFonts.HelveticaOblique,
      ];
      const fonts = await Promise.all(names.map((name) => doc.embedFont(name)));
      for (let index = 0; index < 7; index++)
        page.drawText(index === 3 ? "“Résumé” – £10" : `Piece${index}`, {
          font: fonts[index % fonts.length],
          size: 8 + random() * 14,
          x: 30 + (index % 3) * 90,
          y: 200 - Math.floor(index / 3) * 60,
          rotate: degrees((random() - 0.5) * 40),
          xSkew: degrees((random() - 0.5) * 12),
          color: rgb(random(), random(), random()),
          opacity: 0.4 + random() * 0.6,
        });
      const bytes = await doc.save(),
        runs = await inspectEditableText(bytes, 0);
      let model: EditorPage = {
        id: "p",
        sourceId: "s",
        index: 0,
        annotations: [
          {
            id: "new",
            kind: "text",
            text: "Added",
            x: 60,
            y: 30,
            size: 12,
            color: "#297768",
          },
        ],
        textReplacements: [
          {
            runId: runs[0].id,
            original: runs[0].text,
            replacement: seed % 4 === 0 ? "" : "Revised",
          },
        ],
      };
      model = moveTextBoxes(model, runs, [runs[1].id], 2.25, -1.5);
      const expected = await imageHash(await save(bytes, model));
      const joined = joinTextBoxes(
        model,
        runs,
        [...runs.map((run) => run.id), "added:new"],
        "joined",
      );
      const saved = await save(bytes, joined);
      expect(await imageHash(saved)).toBe(expected);
      expect(
        await imageHash(
          await save(bytes, ungroupTextBoxes(joined, ["joined"])),
        ),
      ).toBe(expected);
      let current = saved;
      for (let cycle = 0; cycle < 4; cycle++) {
        const groups = (await readDocumentTextGroups(current))[0],
          members = await inspectEditableText(current, 0);
        expect(groups).toHaveLength(1);
        expect(groups[0].runIds).toHaveLength(seed % 4 === 0 ? 7 : 8);
        const imported: EditorPage = {
          id: "p",
          sourceId: "s",
          index: 0,
          annotations: [],
          textGroups: groups,
        };
        expect(getTextBoxes(imported, members)).toHaveLength(1);
        current = await save(current, imported);
        expect(await imageHash(current)).toBe(expected);
      }
    });
});
