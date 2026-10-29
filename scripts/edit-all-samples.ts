/** Local batch proof. Takes a private JSON plan; never commits documents or edits. */
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import { inspectEditableText, replacePageText } from "../src/text-edit";
import { editScannedWord } from "./prove-scan-edit";

interface Plan {
  file: string;
  original: string;
  replacement: string;
  imagePath?: string;
  expectedPhrase?: string;
}
const [planPath, destination = "output/pdf/edited-samples"] =
  process.argv.slice(2);
if (!planPath) throw new Error("Usage: plan.json [output-directory]");
const plan: Plan[] = JSON.parse(await readFile(planPath, "utf8"));
const files = (await readdir("samples"))
  .filter((file) => file.toLowerCase().endsWith(".pdf"))
  .sort();
if (
  plan.length !== files.length ||
  files.some((file) => plan.filter((item) => item.file === file).length !== 1)
)
  throw new Error("The plan must cover every sample PDF exactly once.");
const directory = resolve(destination);
await mkdir(directory, { recursive: true });
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function render(bytes: Uint8Array, path: string) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl:
      resolve("node_modules/pdfjs-dist/standard_fonts") + "/",
    cMapUrl: resolve("node_modules/pdfjs-dist/cmaps") + "/",
    cMapPacked: true,
    wasmUrl: resolve("node_modules/pdfjs-dist/wasm") + "/",
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const view = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: view,
    }).promise;
    await writeFile(path, canvas.toBuffer("image/png"));
    const content = await page.getTextContent();
    return {
      pages: doc.numPages,
      text: content.items.flatMap((item) => ("str" in item ? [item.str] : [])),
      annotations: (await page.getAnnotations()).length,
      width: view.width,
      height: view.height,
    };
  } finally {
    await task.destroy();
  }
}
const report = [];
for (let index = 0; index < plan.length; index++) {
  const item = plan[index];
  const id = String(index + 1).padStart(2, "0");
  const input = resolve("samples", item.file);
  const originalBytes = new Uint8Array(await readFile(input));
  const originalHash = hash(originalBytes);
  const output = basename(item.file, ".pdf") + "-edited.pdf";
  const row: Record<string, any> = {
    id,
    file: item.file,
    original: item.original,
    replacement: item.replacement,
    output,
    status: "failed",
  };
  try {
    let editedBytes: Uint8Array;
    if (item.imagePath) {
      const result = await editScannedWord(
        originalBytes,
        item.imagePath,
        item.original,
        item.replacement,
      );
      editedBytes = result.bytes;
      row.scan = result.verification;
    } else {
      const runs = await inspectEditableText(originalBytes, 0);
      const matches = runs.filter((run) => run.text.trim() === item.original);
      if (matches.length !== 1)
        throw new Error("Expected one text match, found " + matches.length);
      const run = matches[0];
      const doc = await PDFDocument.load(originalBytes);
      replacePageText(doc.getPage(0), [
        { runId: run.id, original: run.text, replacement: item.replacement },
      ]);
      editedBytes = await doc.save();
      const editedRuns = await inspectEditableText(editedBytes, 0);
      if (
        !editedRuns.some(
          (edited) =>
            edited.text === item.replacement && edited.font === run.font,
        )
      )
        throw new Error(
          "Original font or replacement text did not survive saving.",
        );
      row.font = run.font;
      row.method = "original-text-operator-replacement";
    }
    await writeFile(resolve(directory, output), editedBytes);
    const before = await render(
      originalBytes,
      resolve(directory, id + "-before.png"),
    );
    const after = await render(
      new Uint8Array(await readFile(resolve(directory, output))),
      resolve(directory, id + "-after.png"),
    );
    if (
      after.pages !== before.pages ||
      after.width !== before.width ||
      after.height !== before.height ||
      after.annotations !== before.annotations
    )
      throw new Error("Page count, dimensions or annotation count changed.");
    if (!item.imagePath) {
      const normal = (value: string) => value.replace(/\s+/g, "");
      const expected = normal(item.expectedPhrase ?? item.replacement);
      if (
        !normal(after.text.join("")).includes(expected) ||
        normal(before.text.join("")) === normal(after.text.join(""))
      )
        throw new Error(
          "Independent PDF.js extraction did not confirm a text change.",
        );
    }
    const images = await Promise.all(
      [id + "-before.png", id + "-after.png"].map((file) =>
        loadImage(resolve(directory, file)),
      ),
    );
    const pixels = images.map((image) => {
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, image.width, image.height).data;
    });
    let changed = 0,
      left = images[0].width,
      top = images[0].height,
      right = 0,
      bottom = 0;
    for (let y = 0; y < images[0].height; y++)
      for (let x = 0; x < images[0].width; x++) {
        const offset = (y * images[0].width + x) * 4;
        if (
          [0, 1, 2, 3].some(
            (channel) =>
              pixels[0][offset + channel] !== pixels[1][offset + channel],
          )
        ) {
          changed++;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    if (!changed) throw new Error("No visible pixels changed.");
    for (const [index, label] of ["before", "after"].entries()) {
      const image = images[index];
      const x = Math.max(0, left - 35),
        y = Math.max(0, top - 18);
      const width = Math.min(image.width - x, right - left + 71),
        height = Math.min(image.height - y, bottom - top + 37);
      const detail = createCanvas(width, height);
      detail
        .getContext("2d")
        .drawImage(image, x, y, width, height, 0, 0, width, height);
      await writeFile(
        resolve(directory, `${id}-${label}-detail.png`),
        detail.toBuffer("image/png"),
      );
    }
    if (hash(new Uint8Array(await readFile(input))) !== originalHash)
      throw new Error("Original file was modified.");
    Object.assign(row, {
      status: "verified",
      pages: after.pages,
      annotations: after.annotations,
      originalUnchanged: true,
      changedPixels: changed,
      changedBounds: [left, top, right, bottom],
    });
  } catch (cause) {
    row.error = String(cause);
  }
  report.push(row);
  await writeFile(
    resolve(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      file: item.file,
      status: row.status,
      changedBounds: row.changedBounds,
      error: row.error,
    }),
  );
}
const escape = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
await writeFile(
  resolve(directory, "review.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDFeditor — all sample edits</title><style>body{margin:0;background:#f0f5f2;color:#243b30;font:15px/1.6 system-ui}header,main{max-width:1400px;margin:auto;padding:25px}header{padding-bottom:0}h1{font:36px Georgia}article{background:white;margin:24px 0;padding:24px;border:1px solid #d4e0d9;border-radius:12px}h2{font-size:18px;margin-top:0}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:20px}img{width:100%;border:1px solid #e1e8e4}a{color:#1e7057}strong{color:#1e7057}.note{color:#617c6c}summary{cursor:pointer;font-weight:600}figure{margin:0}figcaption{font-weight:600;margin-bottom:10px}@media(max-width:700px){.comparison{grid-template-columns:1fr}}</style><header><h1>Every sample, tested.</h1><p>${report.filter((row) => row.status === "verified").length} of ${report.length} files edited and independently verified. Only the first page was changed; all page counts and annotations were retained. Originals are untouched.</p><p class="note">These are demonstration copies. The scan uses OCR-guided bitmap editing, which is not yet available in the interactive editor. Other files use the app's original-text editing engine. Longer edits do not reflow text.</p></header><main>${report.map((row) => `<article><h2>${escape(row.id)} · ${escape(row.file)}</h2><p><strong>${escape(row.status)}</strong> — “${escape(row.original)}” → “${escape(row.replacement)}”</p>${row.status === "verified" ? `<p><a href="${encodeURIComponent(row.output)}" target="_blank">Open edited PDF (${row.pages} pages)</a>${row.scan ? " · OCR-verified scan pixel change" : " · Original font retained"}</p><details open><summary>Compare first pages</summary><div class="comparison"><figure><figcaption>Original</figcaption><img loading="lazy" src="${row.id}-before.png" alt="Original first page"></figure><figure><figcaption>Edited</figcaption><img loading="lazy" src="${row.id}-after.png" alt="Edited first page"></figure></div></details>` : `<p>${escape(row.error)}</p>`}</article>`).join("")}</main></html>`,
);
if (report.some((row) => row.status !== "verified")) process.exitCode = 1;
// Show the actual edit at readable size; expand full-page comparisons on demand.
let review = await readFile(resolve(directory, "review.html"), "utf8");
let detailIndex = 0;
review = review.replaceAll(
  "<details open><summary>Compare first pages</summary>",
  () => {
    const row = report.filter((row) => row.status === "verified")[
      detailIndex++
    ];
    return `<div class="comparison details"><figure><figcaption>Changed area — original</figcaption><img src="${row.id}-before-detail.png" alt="Original text detail"></figure><figure><figcaption>Changed area — edited</figcaption><img src="${row.id}-after-detail.png" alt="Edited text detail"></figure></div><details><summary>Compare complete first pages</summary>`;
  },
);
review = review.replace(
  "</style>",
  ".details img{height:125px;object-fit:contain;object-position:left center;background:#fafcfb;border-radius:6px}.details{margin-bottom:12px}summary{font-size:12px}</style>",
);
await writeFile(resolve(directory, "review.html"), review);
