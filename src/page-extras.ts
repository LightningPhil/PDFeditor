import type { EditorPage } from "./pdf";
import type { TextFont } from "./typography";
import { textWidth } from "./typography";
import { bounds, inverseVector, transform } from "./geometry";
import { getAllTextRuns } from "./text-boxes";
import type { Matrix } from "./geometry";
export function parsePageRange(value: string, count: number): number[] {
  if (!Number.isInteger(count) || count < 1)
    throw Error("There are no pages to select.");
  if (
    !value.trim() ||
    value.trim() === "*" ||
    /^all(?: pages)?$/i.test(value.trim())
  )
    return Array.from({ length: count }, (_, i) => i);
  const result = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:[-–—]\s*(\d+)\s*)?$/.exec(part);
    if (!match)
      throw Error("Use page numbers or ranges, for example 1–3, 7, 10–12.");
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (first < 1 || last > count || last < first)
      throw Error(
        `Choose pages from 1 to ${count}, with ranges in ascending order.`,
      );
    for (let n = first; n <= last; n++) result.add(n - 1);
  }
  return [...result];
}
export function safePdfFilename(value: string) {
  const name = value
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\.pdf$/i, "");
  if (!name) throw Error("Enter a filename.");
  return name + ".pdf";
}
export interface PageFrame {
  matrix: Matrix;
  width: number;
  height: number;
  unit: number;
}
export function pageFrame(
  source: { view: readonly number[]; rotate: number; userUnit: number },
  page: EditorPage,
): PageFrame {
  const crop = page.crop ?? {
      x: source.view[0],
      y: source.view[1],
      width: source.view[2] - source.view[0],
      height: source.view[3] - source.view[1],
    },
    u = source.userUnit,
    rotation = (((source.rotate + (page.rotation ?? 0)) % 360) + 360) % 360;
  if (
    ![crop.x, crop.y, crop.width, crop.height, u].every(Number.isFinite) ||
    u <= 0 ||
    crop.width <= 0 ||
    crop.height <= 0
  )
    throw Error("Invalid page dimensions.");
  const { x, y, width: w, height: h } = crop;
  const matrix: Matrix =
    rotation === 0
      ? [u, 0, 0, -u, -x * u, (y + h) * u]
      : rotation === 90
        ? [0, u, u, 0, -y * u, -x * u]
        : rotation === 180
          ? [-u, 0, 0, u, (x + w) * u, -y * u]
          : [0, -u, -u, 0, (y + h) * u, (x + w) * u];
  return {
    matrix,
    width: (rotation % 180 ? h : w) * u,
    height: (rotation % 180 ? w : h) * u,
    unit: u,
  };
}
export function cropWithMargins(
  page: EditorPage,
  frame: PageFrame,
  margins: { left: number; right: number; top: number; bottom: number },
): EditorPage {
  const { left, right, top, bottom } = margins;
  if (
    ![left, right, top, bottom].every((n) => Number.isFinite(n) && n >= 0) ||
    left + right >= frame.width - 1 ||
    top + bottom >= frame.height - 1
  )
    throw Error("Margins must leave a positive page area.");
  const point = (x: number, y: number) =>
    inverseVector(frame.matrix, {
      x: x - frame.matrix[4],
      y: y - frame.matrix[5],
    });
  const crop = bounds([
    point(left, top),
    point(frame.width - right, top),
    point(frame.width - right, frame.height - bottom),
    point(left, frame.height - bottom),
  ]);
  return { ...page, crop };
}
export interface StampSettings {
  kind: "numbers" | "headers";
  range: string;
  format: string;
  start: number;
  position: "top" | "bottom";
  align: "left" | "center" | "right";
  header: string;
  footer: string;
  font: TextFont;
  size: number;
  color: string;
  margin: number;
  date: string;
}
export function stampPages(
  pages: EditorPage[],
  frames: Map<string, PageFrame>,
  names: Map<string, string>,
  settings: StampSettings,
  uid: () => string,
): EditorPage[] {
  const indices = parsePageRange(settings.range, pages.length),
    chosen = new Set(indices);
  if (
    !Number.isInteger(settings.start) ||
    settings.start < 0 ||
    ![settings.size, settings.margin].every(Number.isFinite) ||
    settings.size < 1 ||
    settings.size > 200 ||
    settings.margin < 0 ||
    !/^#[\da-f]{6}$/i.test(settings.color)
  )
    throw Error("Check numbering, font size, margin and colour.");
  return pages.map((page, index) => {
    if (!chosen.has(index)) return page;
    const frame = frames.get(page.id);
    if (!frame) throw Error("Page dimensions are not available.");
    const roles =
      settings.kind === "numbers" ? ["page-number"] : ["header", "footer"];
    const removed = new Set(
      page.annotations
        .filter((a) => a.role && roles.includes(a.role))
        .map((a) => a.id),
    );
    if (
      page.annotations.some(
        (a) =>
          removed.has(a.id) &&
          (a.locked || page.lockedRunIds?.includes(`added:${a.id}`)),
      )
    )
      throw Error("Unlock existing page stamps before replacing them.");
    const tokens = (text: string) =>
      text.replace(
        /\{(n|page|pages|filename|date)\}/g,
        (_, key: string) =>
          ({
            n: String(settings.start + indices.indexOf(index)),
            page: String(index + 1),
            pages: String(pages.length),
            filename: names.get(page.sourceId) ?? "",
            date: settings.date,
          })[key]!,
      );
    const values =
      settings.kind === "numbers"
        ? [
            {
              text: tokens(settings.format),
              position: settings.position,
              role: "page-number" as const,
            },
          ]
        : [
            {
              text: tokens(settings.header),
              position: "top" as const,
              role: "header" as const,
            },
            {
              text: tokens(settings.footer),
              position: "bottom" as const,
              role: "footer" as const,
            },
          ];
    const additions = values
      .filter((v) => v.text.trim())
      .map(({ text, position, role }) => {
        if (/[\r\n]/.test(text)) throw Error("Use one line for each stamp.");
        const width = textWidth(text, settings.font, settings.size);
        if (
          width > frame.width - 2 * settings.margin ||
          settings.margin + settings.size > frame.height / 2
        )
          throw Error(
            "This stamp does not fit. Shorten it, reduce the font size or use a smaller margin.",
          );
        const x =
            settings.align === "left"
              ? settings.margin
              : settings.align === "right"
                ? frame.width - settings.margin - width
                : (frame.width - width) / 2,
          y =
            position === "top"
              ? settings.margin + settings.size
              : frame.height - settings.margin;
        const native = inverseVector(frame.matrix, {
            x: x - frame.matrix[4],
            y: y - frame.matrix[5],
          }),
          direction = inverseVector(frame.matrix, { x: 1, y: 0 });
        return {
          id: uid(),
          kind: "text" as const,
          text,
          font: settings.font,
          size: settings.size / frame.unit,
          color: settings.color,
          x: native.x,
          y: native.y,
          rotation: (Math.atan2(direction.y, direction.x) * 180) / Math.PI,
          role,
        };
      });
    // Keep separately applied numbering and headers/footers in distinct lanes.
    const occupied = getAllTextRuns(
      {
        ...page,
        annotations: page.annotations.filter(
          (a) => a.role && !removed.has(a.id),
        ),
      },
      [],
    ).flatMap((run) =>
      run.geometry
        ? [bounds(run.geometry.quad.map((p) => transform(frame.matrix, p)))]
        : [],
    );
    const visual = (annotation: (typeof additions)[number]) => {
      const run = getAllTextRuns({ ...page, annotations: [annotation] }, [])[0];
      return bounds(run.geometry!.quad.map((p) => transform(frame.matrix, p)));
    };
    for (const addition of additions) {
      let box = visual(addition);
      let attempts = 0;
      const sign =
        addition.role === "header" ||
        (addition.role === "page-number" && settings.position === "top")
          ? 1
          : -1;
      while (
        occupied.some(
          (other) =>
            box.x < other.x + other.width + 2 &&
            box.x + box.width + 2 > other.x &&
            box.y < other.y + other.height + 2 &&
            box.y + box.height + 2 > other.y,
        )
      ) {
        if (++attempts > 30)
          throw Error(
            "There is not enough room for these stamps. Use smaller text or different positions.",
          );
        const delta = inverseVector(frame.matrix, {
          x: 0,
          y: sign * (settings.size + 4),
        });
        addition.x += delta.x;
        addition.y += delta.y;
        box = visual(addition);
      }
      if (box.y < 0 || box.y + box.height > frame.height)
        throw Error("This stamp would be outside the page.");
      occupied.push(box);
    }
    const affected = new Set(
      (page.textGroups ?? [])
        .filter((g) =>
          g.runIds.some(
            (id) => id.startsWith("added:") && removed.has(id.slice(6)),
          ),
        )
        .map((g) => g.id),
    );
    return {
      ...page,
      annotations: [
        ...page.annotations.filter((a) => !removed.has(a.id)),
        ...additions,
      ],
      textGroups: page.textGroups
        ?.map((g) => ({
          ...g,
          runIds: g.runIds.filter(
            (id) => !id.startsWith("added:") || !removed.has(id.slice(6)),
          ),
        }))
        .filter((g) => g.runIds.length),
      paragraphs: page.paragraphs?.filter((p) => !affected.has(p.groupId)),
    };
  });
}
