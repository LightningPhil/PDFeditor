/** Read private local samples and verify that joins cannot change their rendering. */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { inspectEditableText } from "../src/text-edit";
import { exportPdf } from "../src/pdf";
import type { EditorPage } from "../src/pdf";
import { joinTextBoxes, moveTextBoxes } from "../src/text-boxes";
import { readDocumentTextGroups } from "../src/text-group-storage";

const output = resolve("output/pdf/text-layout");
await mkdir(output, { recursive: true });
async function render(bytes: Uint8Array) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl:
      resolve("node_modules/pdfjs-dist/standard_fonts") + "/",
    cMapUrl: resolve("node_modules/pdfjs-dist/cmaps") + "/",
    cMapPacked: true,
    wasmUrl: resolve("node_modules/pdfjs-dist/wasm") + "/",
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
    const pixels = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      hash: createHash("sha256").update(pixels).digest("hex"),
      image: canvas.toBuffer("image/png"),
      text: (await page.getTextContent()).items.flatMap((item) =>
        "str" in item && item.str.trim() ? [item] : [],
      ),
    };
  } finally {
    await task.destroy();
  }
}
const report = [];
for (const file of (await readdir("samples"))
  .filter((file) => file.endsWith(".pdf"))
  .sort()) {
  const bytes = new Uint8Array(await readFile(resolve("samples", file)));
  const runs = await inspectEditableText(bytes, 0),
    movable = runs.filter((run) => run.geometry);
  if (!movable.length) {
    report.push({ file, status: "no movable text", runs: runs.length });
    continue;
  }
  const model: EditorPage = {
    id: "page",
    sourceId: "source",
    index: 0,
    annotations: [],
  };
  const source = { id: "source", name: file, bytes };
  const original = await render(bytes);
  // Join every supported run: includes different fonts, columns, scales and baselines.
  const joined =
    movable.length > 1
      ? joinTextBoxes(
          model,
          runs,
          movable.map((run) => run.id),
          "whole-page-group",
        )
      : model;
  const joinedBytes = await exportPdf([source], [joined]);
  if (
    movable.length > 1 &&
    (await readDocumentTextGroups(joinedBytes))[0][0]?.runIds.length !==
      movable.length
  )
    throw Error("Joined membership was not preserved in PDF: " + file);
  if ((await render(joinedBytes)).hash !== original.hash)
    throw Error("Joining altered rendering: " + file);
  const selection = movable.length > 1 ? ["whole-page-group"] : [movable[0].id];
  const moved = moveTextBoxes(joined, runs, selection, 20, -30);
  const movedBytes = await exportPdf([source], [moved]);
  const after = await render(movedBytes);
  if (after.hash === original.hash)
    throw Error("Movement did not alter rendering: " + file);
  const restored = moveTextBoxes(moved, runs, selection, -20, 30);
  if (
    (await render(await exportPdf([source], [restored]))).hash !== original.hash
  )
    throw Error("Movement was not reversible: " + file);
  if (file === "very_simple.pdf") {
    await writeFile(resolve(output, "layout-proof.pdf"), movedBytes);
    await writeFile(resolve(output, "before.png"), original.image);
    await writeFile(resolve(output, "after.png"), after.image);
    const beforeText = original.text.find((item) =>
        item.str.includes("Dummy"),
      )!,
      afterText = after.text.find((item) => item.str.includes("Dummy"))!;
    if (
      Math.abs(afterText.transform[4] - beforeText.transform[4] - 20) > 1e-6 ||
      Math.abs(afterText.transform[5] - beforeText.transform[5] + 30) > 1e-6
    )
      throw Error("Fragmented line did not move rigidly");
  }
  report.push({
    file,
    status: "verified",
    joinedRuns: movable.length > 1 ? movable.length : 0,
    joinPixelIdentical: movable.length > 1 ? true : null,
    movementVisible: true,
    restorePixelIdentical: true,
  });
  console.log(
    file +
      (movable.length > 1
        ? ": join identical; move visible; restore identical ("
        : ": single box; move visible; restore identical (") +
      movable.length +
      " pieces)",
  );
}
await writeFile(
  resolve(output, "results.json"),
  JSON.stringify(report, null, 2),
);
