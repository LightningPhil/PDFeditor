/** Local-only PDF proof: npx tsx scripts/prove-text-edit.ts input.pdf 'Old text' 'New text' output-base */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { inspectEditableText } from "../src/text-edit";
import { exportPdf } from "../src/pdf";

const [input, original, replacement, outputBase] = process.argv.slice(2);
if (!input || !original || replacement === undefined || !outputBase)
  throw new Error('Usage: input.pdf "Old text" "New text" output-base');
const bytes = new Uint8Array(await readFile(input));
const runs = await inspectEditableText(bytes, 0);
const matches = runs.filter((run) => run.text.trim() === original);
if (matches.length !== 1)
  throw new Error(`Expected one editable match, found ${matches.length}`);
const run = matches[0];
const output = await exportPdf(
  [{ id: "sample", name: input, bytes }],
  [
    {
      id: "page1",
      sourceId: "sample",
      index: 0,
      annotations: [],
      textReplacements: [{ runId: run.id, original: run.text, replacement }],
    },
  ],
);
const editedRuns = await inspectEditableText(output, 0);
if (
  !editedRuns.some(
    (item) => item.text === replacement && item.font === run.font,
  )
)
  throw new Error("Replacement or original font was not preserved");
if (editedRuns.some((item) => item.text.trim() === original))
  throw new Error("Original text remains in an editable run");
const target = resolve(outputBase);
await mkdir(dirname(target), { recursive: true });
await writeFile(`${target}.pdf`, output);
const text: Record<string, string[]> = {};
for (const [label, data] of [
  ["before", bytes],
  ["after", output],
] as const) {
  const task = getDocument({
    data: data.slice(),
    standardFontDataUrl:
      resolve("node_modules/pdfjs-dist/standard_fonts") + "/",
    cMapUrl: resolve("node_modules/pdfjs-dist/cmaps") + "/",
    cMapPacked: true,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    await writeFile(`${target}-${label}.png`, canvas.toBuffer("image/png"));
    text[label] = (await page.getTextContent()).items.flatMap((item) =>
      "str" in item ? [item.str] : [],
    );
  } finally {
    await task.destroy();
  }
}
if (!text.after.includes(replacement) || text.after.includes(original))
  throw new Error(
    "Independent PDF.js extraction did not confirm text replacement",
  );
console.log(
  JSON.stringify(
    {
      output: `${target}.pdf`,
      original,
      replacement,
      originalFont: run.font,
      verified: true,
      firstPageOnly: true,
    },
    null,
    2,
  ),
);
