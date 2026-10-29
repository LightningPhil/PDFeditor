/** Local scan proof. Changes bitmap pixels using glyphs already present in the scan. */
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";

export async function editScannedWord(
  pdfBytes: Uint8Array,
  imagePath: string,
  original: string,
  replacement: string,
) {
  const changes = Array.from(original).flatMap((character, index) =>
    character === replacement[index] ? [] : [index],
  );
  if (original.length !== replacement.length || changes.length !== 1)
    throw new Error("This scan proof supports one character substitution.");
  const imageBytes = await readFile(imagePath);
  const image = await loadImage(imageBytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  await mkdir("tmp/pdfs/ocr-cache", { recursive: true });
  const worker = await createWorker("eng", 1, {
    cachePath: "tmp/pdfs/ocr-cache",
  });
  try {
    const before = await worker.recognize(
      imageBytes,
      {},
      { blocks: true, text: true },
    );
    const lines =
      before.data.blocks?.flatMap((block) =>
        block.paragraphs.flatMap((paragraph) => paragraph.lines),
      ) ?? [];
    const line = lines.find((line) =>
      line.words.some((word) => word.text === original),
    );
    const targetWord = line?.words.find((word) => word.text === original);
    const target = targetWord?.symbols[changes[0]];
    // Reuse an actual glyph from this same line: no invented font or cover-up text.
    const source = line?.words
      .flatMap((word) => word.symbols)
      .find((symbol) => symbol.text === replacement[changes[0]]);
    if (!source || !target)
      throw new Error("Could not locate matching scan glyphs.");
    const sourceBox = source.bbox,
      targetBox = target.bbox;
    const glyph = context.getImageData(
      sourceBox.x0,
      sourceBox.y0,
      sourceBox.x1 - sourceBox.x0 + 1,
      sourceBox.y1 - sourceBox.y0 + 1,
    );
    context.fillStyle = "#fff";
    context.fillRect(
      targetBox.x0 - 1,
      targetBox.y0 - 1,
      Math.max(glyph.width, targetBox.x1 - targetBox.x0 + 1) + 2,
      targetBox.y1 - targetBox.y0 + 3,
    );
    context.putImageData(glyph, targetBox.x0, sourceBox.y0);
    const modifiedImage = canvas.toBuffer("image/png");
    const after = await worker.recognize(modifiedImage);
    if (
      !after.data.text.includes(replacement) ||
      after.data.text.includes(original)
    )
      throw new Error("OCR did not verify the changed scan.");
    const originalPdf = await PDFDocument.load(pdfBytes);
    const page = originalPdf.getPage(0);
    const xobjects = page.node
      .Resources()
      ?.lookup(PDFName.of("XObject"), PDFDict);
    if (!xobjects || xobjects.entries().length !== 1)
      throw new Error("This proof requires a single-image scan.");
    const embedded = await originalPdf.embedPng(modifiedImage);
    xobjects.set(xobjects.entries()[0][0], embedded.ref);
    // Copy only reachable objects, dropping the replaced original image stream.
    await originalPdf.save();
    const clean = await PDFDocument.create();
    const pages = await clean.copyPages(
      originalPdf,
      originalPdf.getPageIndices(),
    );
    pages.forEach((page) => clean.addPage(page));
    const bytes = await clean.save();
    return {
      bytes,
      verification: {
        method: "scan-pixel-substitution",
        original,
        replacement,
        ocrVerified: true,
        sourceImage: resolve(imagePath),
        bounds: targetBox,
        interactiveTextEditing: false,
      },
    };
  } finally {
    await worker.terminate();
  }
}
