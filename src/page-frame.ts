import type { PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";

/** Never expose a cleared or progressively painted canvas to the document view. */
export async function renderPageFrame(
  page: Pick<PDFPageProxy, "getViewport" | "render">,
  scale: number,
  options: {
    createCanvas: () => HTMLCanvasElement;
    current: () => boolean;
    rendering: (task: RenderTask) => void;
    present: (canvas: HTMLCanvasElement, viewport: PageViewport) => void;
  },
): Promise<void> {
  const canvas = options.createCanvas();
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const task = page.render({ canvas, viewport, background: "#ffffff" });
  options.rendering(task);
  await task.promise;
  if (options.current())
    options.present(canvas, page.getViewport({ scale: 1 }));
}
