// Vite supplies the deployment prefix: / locally, /PDFeditor/ on GitHub Pages.
// PDF.js fetches these resources at runtime, outside Vite's asset rewriting.
export const pdfAssetOptions = {
  standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
};
