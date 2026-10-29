import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Keep PDF.js font, CMap and codec resources local instead of relying on a CDN.
for (const directory of ["standard_fonts", "cmaps", "wasm"]) {
  const source = fileURLToPath(
    new URL(`../node_modules/pdfjs-dist/${directory}/`, import.meta.url),
  );
  const target = fileURLToPath(
    new URL(`../public/pdfjs/${directory}/`, import.meta.url),
  );
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
}
