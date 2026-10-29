import { Encodings, Font, FontNames } from "@pdf-lib/standard-fonts";

export type TextFont =
  | "Helvetica"
  | "Helvetica-Bold"
  | "Helvetica-Oblique"
  | "Helvetica-BoldOblique"
  | "Times-Roman"
  | "Times-Bold"
  | "Times-Italic"
  | "Times-BoldItalic"
  | "Courier"
  | "Courier-Bold"
  | "Courier-Oblique"
  | "Courier-BoldOblique";
export const textFonts: TextFont[] = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
];
export interface Paragraph {
  groupId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  font: TextFont;
  size: number;
  color: string;
  lineHeight: number;
  align: "left" | "center" | "right";
}
const metrics = new Map<TextFont, ReturnType<typeof Font.load>>();
export function fontMetrics(font: TextFont = "Helvetica") {
  if (!textFonts.includes(font))
    throw new Error("Choose a supported replacement font.");
  if (!metrics.has(font)) metrics.set(font, Font.load(font as FontNames));
  return metrics.get(font)!;
}
export function textWidth(text: string, font: TextFont, size: number): number {
  const metric = fontMetrics(font);
  return Array.from(text).reduce((total, char) => {
    const code = char.codePointAt(0)!;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(code))
      throw new Error(
        `The replacement font cannot display “${char}”. Use original-text editing to keep a font containing that character.`,
      );
    return (
      total +
      ((metric.getWidthOfGlyph(
        Encodings.WinAnsi.encodeUnicodeCodePoint(code).name,
      ) ?? 500) *
        size) /
        1000
    );
  }, 0);
}
export function validateParagraph(p: Paragraph) {
  if (
    ![p.x, p.y, p.width, p.size, p.lineHeight].every(Number.isFinite) ||
    p.width < 1 ||
    p.width > 20000 ||
    p.size < 1 ||
    p.size > 300 ||
    p.lineHeight < 0.5 ||
    p.lineHeight > 5 ||
    !/^#[\da-f]{6}$/i.test(p.color) ||
    !["left", "center", "right"].includes(p.align) ||
    typeof p.text !== "string" ||
    p.text.length > 100000
  )
    throw new Error("Check paragraph size, width, spacing and colour.");
  textWidth(p.text.replace(/[\n\r\t]/g, " "), p.font, p.size);
}
export interface ParagraphLine {
  text: string;
  x: number;
  y: number;
}
/** Wrap by measured PDF font advances, retaining explicit blank lines. */
export function layoutParagraph(p: Paragraph): ParagraphLine[] {
  validateParagraph(p);
  const rows: string[] = [];
  for (const line of p.text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n")) {
    let row = "",
      rowWidth = 0;
    for (const token of line.match(/\S+\s*|\s+/gu) ?? []) {
      if (
        row &&
        rowWidth + textWidth(token.trimEnd(), p.font, p.size) > p.width
      ) {
        rows.push(row.trimEnd());
        row = "";
        rowWidth = 0;
      }
      for (const character of token) {
        const advance = textWidth(character, p.font, p.size);
        if (character.trim() && advance > p.width)
          throw new Error(
            "Paragraph width is too narrow for the chosen font size.",
          );
        if (row && rowWidth + advance > p.width && character.trim()) {
          rows.push(row.trimEnd());
          row = "";
          rowWidth = 0;
        }
        row += character;
        rowWidth += advance;
      }
    }
    rows.push(row.trimEnd());
  }
  return rows.map((text, index) => ({
    text,
    x:
      p.x +
      (p.align === "left"
        ? 0
        : (p.width - textWidth(text, p.font, p.size)) /
          (p.align === "center" ? 2 : 1)),
    y: p.y - index * p.size * p.lineHeight,
  }));
}
