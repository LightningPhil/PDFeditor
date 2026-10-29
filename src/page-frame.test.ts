import { describe, expect, it, vi } from "vitest";
import type { PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { renderPageFrame } from "./page-frame";

function fixture() {
  let finish!: () => void, fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const task = { promise } as RenderTask;
  const render = vi.fn(() => task);
  const page = {
    getViewport: ({ scale }: { scale: number }) =>
      ({
        width: 100.25 * scale,
        height: 200.25 * scale,
        transform: [1, 0, 0, -1, 0, 200.25],
      }) as PageViewport,
    render,
  } as unknown as Pick<PDFPageProxy, "getViewport" | "render">;
  return { page, render, finish, fail };
}
describe("atomic page presentation", () => {
  it("retains the displayed frame throughout painting, then presents an opaque completed frame", async () => {
    const { page, render, finish } = fixture();
    const old = { width: 80, height: 160 },
      next = { width: 0, height: 0 } as HTMLCanvasElement;
    let visible = old;
    const present = vi.fn((canvas: HTMLCanvasElement) => {
      visible = canvas;
    });
    const pending = renderPageFrame(page, 1.4, {
      createCanvas: () => next,
      current: () => true,
      rendering: () => {},
      present,
    });
    expect(visible).toBe(old);
    expect(old).toEqual({ width: 80, height: 160 });
    expect(present).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: next, background: "#ffffff" }),
    );
    finish();
    await pending;
    expect(visible).toBe(next);
    expect(present).toHaveBeenCalledOnce();
    expect(next.width).toBe(141);
    expect(next.height).toBe(281);
  });
  it("does not publish an out-of-date frame after a newer move supersedes it", async () => {
    const { page, finish } = fixture();
    let current = true;
    const present = vi.fn();
    const pending = renderPageFrame(page, 1, {
      createCanvas: () => ({}) as HTMLCanvasElement,
      current: () => current,
      rendering: () => {},
      present,
    });
    current = false;
    finish();
    await pending;
    expect(present).not.toHaveBeenCalled();
  });
  it("leaves the previous frame untouched if rendering fails or is cancelled", async () => {
    const { page, fail } = fixture(),
      present = vi.fn();
    const pending = renderPageFrame(page, 1, {
      createCanvas: () => ({}) as HTMLCanvasElement,
      current: () => true,
      rendering: () => {},
      present,
    });
    fail(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(present).not.toHaveBeenCalled();
  });
});
