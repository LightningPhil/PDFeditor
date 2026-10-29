import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  pdfDocEncodingDecode,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { inspectPageText, pageTextFingerprint } from "./text-edit";
import type { EditableRun } from "./text-edit";
import { assertTextGroups, isGroupId, normalizeTextGroups } from "./text-boxes";
import type { TextGroup } from "./text-boxes";
import type { Point } from "./geometry";

const key = PDFName.of("PDFeditorTextGroups");
const maxGroups = 10000,
  maxMembers = 100000,
  maxJsonLength = 8 * 1024 * 1024;
function decodeMetadata(value: PDFString | PDFHexString): string {
  if (value.sizeInBytes() > 34 * 1024 * 1024)
    throw new Error("Joined-box metadata is too large.");
  const bytes = value.asBytes();
  // pdf-lib's decodeText spreads every character onto the JS call stack. Native
  // decoding handles large joined groups and supplementary Unicode safely.
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be", { fatal: true }).decode(
      bytes.subarray(2),
    );
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le", { fatal: true }).decode(
      bytes.subarray(2),
    );
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192)
    chunks.push(pdfDocEncodingDecode(bytes.subarray(index, index + 8192)));
  return chunks.join("");
}
interface Anchor {
  runId: string;
  text: string;
  font: string;
  baseline: Point;
  quad: Point[];
}
const family = (font: string) =>
  font
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/#([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
const identity = (text: string, font: string) =>
  JSON.stringify([text, family(font)]);
function validPoint(point: unknown): point is Point {
  return (
    !!point &&
    typeof point === "object" &&
    Number.isFinite((point as Point).x) &&
    Number.isFinite((point as Point).y)
  );
}
function validAnchor(value: unknown): value is Anchor {
  if (!value || typeof value !== "object") return false;
  const a = value as Anchor;
  return (
    typeof a.runId === "string" &&
    /^\d+:\d+$/.test(a.runId) &&
    typeof a.text === "string" &&
    typeof a.font === "string" &&
    validPoint(a.baseline) &&
    Array.isArray(a.quad) &&
    a.quad.length === 4 &&
    a.quad.every(validPoint)
  );
}
function matches(run: EditableRun, anchor: Anchor): boolean {
  const near = (a: Point, b: Point) =>
    Math.abs(a.x - b.x) <= 0.002 && Math.abs(a.y - b.y) <= 0.002;
  return (
    !!run.geometry &&
    run.text === anchor.text &&
    family(run.font) === family(anchor.font) &&
    near(run.geometry.baseline, anchor.baseline) &&
    run.geometry.quad.every((point, index) => near(point, anchor.quad[index]))
  );
}

/** Group restoration is all-or-nothing per box. Never attach an ambiguous piece. */
export async function readDocumentTextGroups(
  bytes: Uint8Array,
): Promise<TextGroup[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    try {
      const value = page.node.lookup(key);
      if (!(value instanceof PDFString) && !(value instanceof PDFHexString))
        return [];
      const json = decodeMetadata(value);
      if (json.length > maxJsonLength) return [];
      const data = JSON.parse(json);
      if (
        !data ||
        !Array.isArray(data.groups) ||
        data.groups.length > maxGroups
      )
        return [];
      if (data.version !== 1 && data.version !== 2) return [];
      const runs = inspectPageText(page),
        byId = new Map(runs.map((run) => [run.id, run]));
      if (data.version === 1) {
        const groups = data.groups.filter(
          (group: TextGroup) =>
            group &&
            isGroupId(group.id) &&
            Array.isArray(group.runIds) &&
            group.runIds.length <= maxMembers,
        );
        return normalizeTextGroups(
          groups,
          runs.map((run) => run.id),
        );
      }
      const unchanged = data.fingerprint === pageTextFingerprint(page);
      const candidates = new Map<string, EditableRun[]>();
      const cell = (point: Point) => ({
        x: Math.floor(point.x * 100),
        y: Math.floor(point.y * 100),
      });
      const spatialKey = (text: string, font: string, x: number, y: number) =>
        `${identity(text, font)}#${x},${y}`;
      for (const run of runs) {
        if (!run.geometry) continue;
        const position = cell(run.geometry.baseline),
          id = spatialKey(run.text, run.font, position.x, position.y);
        const list = candidates.get(id) ?? [];
        list.push(run);
        candidates.set(id, list);
      }
      const groups: TextGroup[] = [],
        claimed = new Set<string>(),
        ids = new Set<string>();
      let total = 0;
      for (const group of data.groups) {
        if (
          !group ||
          !isGroupId(group.id) ||
          ids.has(group.id) ||
          !Array.isArray(group.members) ||
          !group.members.length ||
          group.members.length > maxMembers
        )
          continue;
        total += group.members.length;
        if (total > maxMembers) break;
        const members: string[] = [];
        const within = new Set<string>();
        let valid = true;
        for (const value of group.members) {
          if (!validAnchor(value)) {
            valid = false;
            break;
          }
          const direct = byId.get(value.runId);
          let run: EditableRun | undefined;
          if (unchanged && direct && matches(direct, value)) run = direct;
          else {
            const found: EditableRun[] = [],
              seen = new Set<string>(),
              position = cell(value.baseline);
            scan: for (let x = -1; x <= 1; x++)
              for (let y = -1; y <= 1; y++)
                for (const candidate of candidates.get(
                  spatialKey(
                    value.text,
                    value.font,
                    position.x + x,
                    position.y + y,
                  ),
                ) ?? []) {
                  if (seen.has(candidate.id)) continue;
                  seen.add(candidate.id);
                  if (matches(candidate, value)) {
                    found.push(candidate);
                    if (found.length > 1) break scan;
                  }
                }
            if (found.length === 1) run = found[0];
          }
          if (!run || claimed.has(run.id) || within.has(run.id)) {
            valid = false;
            break;
          }
          members.push(run.id);
          within.add(run.id);
        }
        if (!valid) continue;
        members.forEach((id) => claimed.add(id));
        ids.add(group.id);
        groups.push({ id: group.id, runIds: members });
      }
      return normalizeTextGroups(
        groups,
        runs.map((run) => run.id),
      );
    } catch {
      return [];
    }
  });
}
export function storePageTextGroups(page: PDFPage, groups: TextGroup[]) {
  page.node.delete(key);
  if (!groups.length) return;
  const runs = inspectPageText(page),
    byId = new Map(runs.map((run) => [run.id, run]));
  const normalized = assertTextGroups(
    groups,
    runs.map((run) => run.id),
  );
  if (
    normalized.length > maxGroups ||
    normalized.reduce((sum, group) => sum + group.runIds.length, 0) > maxMembers
  )
    throw new Error(
      "Too much joined-text data on this page. Ungroup some sections before exporting.",
    );
  const stored = normalized.map((group) => ({
    id: group.id,
    members: group.runIds.map((id) => {
      const run = byId.get(id)!;
      if (!run.geometry)
        throw new Error("A joined text box has an unsupported position.");
      return {
        runId: run.id,
        text: run.text,
        font: run.font,
        baseline: run.geometry.baseline,
        quad: run.geometry.quad,
      };
    }),
  }));
  const json = JSON.stringify({
    version: 2,
    fingerprint: pageTextFingerprint(page),
    groups: stored,
  });
  if (json.length > maxJsonLength)
    throw new Error(
      "Too much joined-text data on this page. Ungroup some sections before exporting.",
    );
  page.node.set(key, PDFHexString.fromText(json));
}
