import type { EditableRun, TextReplacement } from "./text-edit";
import type { EditorPage } from "./pdf";
import { getAllTextRuns, getTextBoxes } from "./text-boxes";
import { bounds } from "./geometry";
export interface TextSegment {
  run: EditableRun;
  value: string;
  start: number;
  end: number;
}
export interface SearchMatch {
  pageId: string;
  start: number;
  end: number;
  context: string;
  segments: { run: EditableRun; value: string; from: number; to: number }[];
}
export function indexedText(
  page: EditorPage,
  runs: EditableRun[],
): { text: string; segments: TextSegment[] } {
  const values = new Map(
    (page.textReplacements ?? []).map((e) => [e.runId, e.replacement]),
  );
  const segments: TextSegment[] = [];
  const positions = new Map(
    getTextBoxes(page, runs).flatMap((box) =>
      box.pieces.map(
        (piece) =>
          [
            piece.runId,
            { quad: piece.quad, baseline: piece.baseline },
          ] as const,
      ),
    ),
  );
  let text = "",
    previous: EditableRun | undefined;
  for (const sourceRun of getAllTextRuns(page, runs)) {
    const run = {
      ...sourceRun,
      geometry: positions.get(sourceRun.id) ?? sourceRun.geometry,
    };
    const value = values.get(run.id) ?? run.text;
    if (!value) continue;
    if (
      previous?.geometry &&
      run.geometry &&
      text &&
      !/\s$/.test(text) &&
      !/^\s/.test(value)
    ) {
      const a = bounds(previous.geometry.quad),
        b = bounds(run.geometry.quad);
      if (
        Math.abs(previous.geometry.baseline.y - run.geometry.baseline.y) >
        Math.min(a.height, b.height) * 0.6
      )
        text += "\n";
      else if (b.x - a.x - a.width > Math.min(a.height, b.height) * 0.15)
        text += " ";
    }
    const start = text.length;
    text += value;
    segments.push({ run, value, start, end: text.length });
    previous = run;
  }
  return { text, segments };
}
export function findText(
  page: EditorPage,
  runs: EditableRun[],
  query: string,
  caseSensitive = false,
  wholeWord = false,
): SearchMatch[] {
  if (!query) return [];
  const { text, segments } = indexedText(page, runs);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, caseSensitive ? "gu" : "giu"),
    result: SearchMatch[] = [];
  for (const match of text.matchAll(regex)) {
    const start = match.index,
      end = start + match[0].length;
    if (
      wholeWord &&
      (/[\p{L}\p{N}_]/u.test(text[start - 1] ?? "") ||
        /[\p{L}\p{N}_]/u.test(text[end] ?? ""))
    )
      continue;
    result.push({
      pageId: page.id,
      start,
      end,
      context: text.slice(
        Math.max(0, start - 25),
        Math.min(text.length, end + 35),
      ),
      segments: segments
        .filter((s) => s.end > start && s.start < end)
        .map((s) => ({
          run: s.run,
          value: s.value,
          from: Math.max(0, start - s.start),
          to: Math.min(s.value.length, end - s.start),
        })),
    });
  }
  return result;
}
export function replacementEdits(
  matches: SearchMatch[],
  replacement: string,
): TextReplacement[] {
  const byRun = new Map<
    string,
    {
      run: EditableRun;
      value: string;
      patches: { from: number; to: number; text: string }[];
    }
  >();
  for (const match of matches)
    for (const [index, s] of match.segments.entries()) {
      const current = byRun.get(s.run.id) ?? {
        run: s.run,
        value: s.value,
        patches: [],
      };
      current.patches.push({
        from: s.from,
        to: s.to,
        text: index === 0 ? replacement : "",
      });
      byRun.set(s.run.id, current);
    }
  return [...byRun.values()].map(({ run, value, patches }) => {
    for (const patch of patches.sort((a, b) => b.from - a.from))
      value = value.slice(0, patch.from) + patch.text + value.slice(patch.to);
    const missing = Array.from(value).find(
      (char) => !run.characters.includes(char),
    );
    if (missing)
      throw new Error(
        `The original font cannot display “${missing}”. Format this text with a replacement font first.`,
      );
    return { runId: run.id, original: run.text, replacement: value };
  });
}
