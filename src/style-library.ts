import { useEffect, useState } from "react";
import type { TextFont } from "./typography";
import { textFonts } from "./typography";
export interface TextStyle {
  font: TextFont;
  size: number;
  color: string;
  lineHeight: number;
}
export interface SavedStyle extends TextStyle {
  id: string;
  name: string;
}
interface Library {
  last: TextStyle;
  styles: SavedStyle[];
}
const key = "PDFeditor-text-styles",
  event = "pdfeditor-style-library";
const fallback: TextStyle = {
  font: "Helvetica",
  size: 16,
  color: "#297768",
  lineHeight: 1.3,
};
function valid(s: TextStyle) {
  return (
    s &&
    textFonts.includes(s.font) &&
    Number.isFinite(s.size) &&
    s.size >= 1 &&
    s.size <= 300 &&
    /^#[\da-f]{6}$/i.test(s.color) &&
    s.lineHeight >= 0.5 &&
    s.lineHeight <= 5
  );
}
export function readStyleLibrary(): Library {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "null");
    return {
      last: valid(data?.last) ? data.last : fallback,
      styles: Array.isArray(data?.styles)
        ? data.styles
            .filter(
              (s: SavedStyle) =>
                valid(s) &&
                typeof s.name === "string" &&
                typeof s.id === "string",
            )
            .slice(0, 50)
        : [],
    };
  } catch {
    return { last: fallback, styles: [] };
  }
}
function write(value: Library) {
  const clean = (s: TextStyle) => ({
    font: s.font,
    size: s.size,
    color: s.color,
    lineHeight: s.lineHeight,
  });
  localStorage.setItem(
    key,
    JSON.stringify({
      last: clean(value.last),
      styles: value.styles.map((s) => ({
        ...clean(s),
        id: s.id,
        name: s.name,
      })),
    }),
  );
  window.dispatchEvent(new Event(event));
}
export function useStyleLibrary() {
  const [library, setLibrary] = useState(readStyleLibrary);
  useEffect(() => {
    const refresh = () => setLibrary(readStyleLibrary());
    window.addEventListener(event, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(event, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return {
    ...library,
    setLast: (style: TextStyle) => {
      if (!valid(style)) throw Error("Invalid text style.");
      write({ ...readStyleLibrary(), last: style });
    },
    save: (name: string, style: TextStyle) => {
      if (!name.trim() || !valid(style))
        throw Error("Enter a style name and valid font settings.");
      const prior = readStyleLibrary();
      write({
        ...prior,
        last: style,
        styles: [
          ...prior.styles.filter((s) => s.name !== name.trim()),
          { ...style, id: crypto.randomUUID(), name: name.trim() },
        ].slice(-50),
      });
    },
    remove: (id: string) => {
      const prior = readStyleLibrary();
      write({ ...prior, styles: prior.styles.filter((s) => s.id !== id) });
    },
  };
}
