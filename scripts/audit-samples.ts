import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { inspectEditableText } from "../src/text-edit";

const target = resolve("output/pdf/batch-edit");
await mkdir(target, { recursive: true });
const report = [];
let index = 0;
for (const file of (await readdir("samples"))
  .filter((file) => file.toLowerCase().endsWith(".pdf"))
  .sort()) {
  const bytes = new Uint8Array(await readFile(resolve("samples", file)));
  const id = String(++index).padStart(2, "0");
  const row: Record<string, any> = { id, file };
  try {
    const task = getDocument({
      data: bytes.slice(),
      standardFontDataUrl:
        resolve("node_modules/pdfjs-dist/standard_fonts") + "/",
      cMapUrl: resolve("node_modules/pdfjs-dist/cmaps") + "/",
      cMapPacked: true,
      wasmUrl: resolve("node_modules/pdfjs-dist/wasm") + "/",
    });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      row.pages = pdf.numPages;
      const content = await page.getTextContent();
      row.text = content.items.filter(
        (item) => "str" in item && item.str.trim(),
      );
      row.styles = content.styles;
      const operators = await page.getOperatorList();
      row.images = operators.fnArray.filter((op) =>
        [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(op),
      ).length;
      row.annotations = await page.getAnnotations();
      const view = page.getViewport({ scale: 1 });
      const canvas = createCanvas(
        Math.ceil(view.width),
        Math.ceil(view.height),
      );
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport: view,
      }).promise;
      await writeFile(
        resolve(target, `${id}-before.png`),
        canvas.toBuffer("image/png"),
      );
    } finally {
      await task.destroy();
    }
    try {
      const doc = await PDFDocument.load(bytes);
      const page = doc.getPage(0);
      row.encrypted = doc.isEncrypted;
      const fonts = page.node
        .Resources()
        ?.lookupMaybe(PDFName.of("Font"), PDFDict);
      row.fonts = fonts
        ?.entries()
        .map(([key, ref]) => ({
          key: key.toString(),
          dictionary: doc.context.lookup(ref).toString(),
        }));
      const contents = page.node.Contents();
      const refs =
        contents instanceof PDFArray
          ? contents.asArray()
          : contents
            ? [contents]
            : [];
      row.streams = refs.map((ref) => {
        const stream = doc.context.lookup(ref);
        return stream instanceof PDFRawStream
          ? Array.from(decodePDFRawStream(stream).decode(), (b) =>
              String.fromCharCode(b),
            ).join("")
          : "";
      });
      row.editable = await inspectEditableText(bytes, 0);
    } catch (cause) {
      row.engineError = String(cause);
    }
  } catch (cause) {
    row.error = String(cause);
  }
  report.push(row);
  console.log(
    JSON.stringify({
      id,
      file,
      pages: row.pages,
      textRuns: row.text?.length,
      editable: row.editable?.length,
      images: row.images,
      error: row.error ?? row.engineError,
    }),
  );
  await writeFile(
    resolve(target, "audit.json"),
    JSON.stringify(report, null, 2),
  );
}
