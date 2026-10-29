import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFContentStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { Font, FontNames, Encodings } from "@pdf-lib/standard-fonts";
import {
  identity,
  multiply,
  transform,
  inverseVector,
  inverse,
} from "./geometry";
import type { Matrix, Point } from "./geometry";

export interface TextReplacement {
  runId: string;
  original: string;
  replacement: string;
}
export interface EditableRun {
  id: string;
  text: string;
  font: string;
  characters: string;
  fontSize?: number;
  geometry?: { quad: Point[]; baseline: Point };
}
export interface TextOffset {
  runId: string;
  original: string;
  dx: number;
  dy: number;
}
export interface TextTransform {
  runId: string;
  original: string;
  matrix: Matrix;
}
export interface TextCopy {
  id: string;
  sourceRunId: string;
  sourceOriginal: string;
  text: string;
}
interface Token {
  kind: "string" | "name" | "word" | "array" | "dict";
  start: number;
  end: number;
  raw: string;
  bytes?: number[];
  children?: Token[];
}
interface Codec {
  decode: (bytes: number[]) => string;
  encode: (text: string) => number[];
  name: string;
  characters: string;
  ascent: number;
  descent: number;
  advance: (
    bytes: number[],
    size: number,
    characterSpacing: number,
    wordSpacing: number,
  ) => number;
}
interface Run extends EditableRun {
  start: number;
  end: number;
  codec: Codec;
  stream: number;
  leading: string[];
  advance: number;
  size: number;
  characterSpacing: number;
  wordSpacing: number;
  matrix?: Matrix;
  horizontalScale: number;
  rise: number;
  parts: Token[];
  textMatrix?: Matrix;
  lineMatrix?: Matrix;
  ctm: Matrix;
}
const name = (value: string) => PDFName.of(value);
const binary = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
const toBytes = (text: string) =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));
const whitespace = (c: string) => /[\x00\t\n\f\r ]/.test(c);
const delimiter = (c: string) =>
  !c || whitespace(c) || "()<>[]{}/%".includes(c);

/** Tokenise PDF syntax, never matching operators inside strings or comments. */
function tokenize(input: string): Token[] {
  let position = 0;
  function skip() {
    while (position < input.length) {
      if (whitespace(input[position])) {
        position++;
        continue;
      }
      if (input[position] === "%") {
        while (position < input.length && !"\r\n".includes(input[position]))
          position++;
        continue;
      }
      break;
    }
  }
  function token(): Token {
    skip();
    const start = position;
    const c = input[position++];
    if (c === "(") {
      const bytes: number[] = [];
      let depth = 1;
      while (position < input.length && depth) {
        let char = input[position++];
        if (char === "\\") {
          char = input[position++];
          if (char === "\r" || char === "\n") {
            if (char === "\r" && input[position] === "\n") position++;
            continue;
          }
          if (/[0-7]/.test(char)) {
            let octal = char;
            for (let i = 0; i < 2 && /[0-7]/.test(input[position] ?? "x"); i++)
              octal += input[position++];
            bytes.push(parseInt(octal, 8) & 255);
            continue;
          }
          const escaped: Record<string, number> = {
            n: 10,
            r: 13,
            t: 9,
            b: 8,
            f: 12,
          };
          bytes.push(escaped[char] ?? char.charCodeAt(0));
          continue;
        }
        if (char === "(") depth++;
        if (char === ")" && --depth === 0) break;
        if (char !== ")") {
          if (char === "\r") {
            if (input[position] === "\n") position++;
            char = "\n";
          }
          bytes.push(char.charCodeAt(0));
        } else bytes.push(41);
      }
      if (depth) throw new Error("Unterminated PDF string");
      return {
        kind: "string",
        bytes,
        start,
        end: position,
        raw: input.slice(start, position),
      };
    }
    if (c === "[" || (c === "<" && input[position] === "<")) {
      const dictionary = c === "<";
      if (dictionary) position++;
      const children: Token[] = [];
      while (position < input.length) {
        skip();
        if (
          dictionary
            ? input.slice(position, position + 2) === ">>"
            : input[position] === "]"
        ) {
          position += dictionary ? 2 : 1;
          return {
            kind: dictionary ? "dict" : "array",
            children,
            start,
            end: position,
            raw: input.slice(start, position),
          };
        }
        children.push(token());
      }
      throw new Error("Unterminated PDF container");
    }
    if (c === "<") {
      const close = input.indexOf(">", position);
      if (close < 0) throw new Error("Unterminated PDF hex string");
      let hex = input.slice(position, close).replace(/[\x00\t\n\f\r ]/g, "");
      if (!/^[0-9a-f]*$/i.test(hex)) throw new Error("Invalid PDF hex string");
      if (hex.length % 2) hex += "0";
      position = close + 1;
      return {
        kind: "string",
        start,
        end: position,
        raw: input.slice(start, position),
        bytes: hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [],
      };
    }
    if (c === "/") {
      while (position < input.length && !delimiter(input[position])) position++;
      return {
        kind: "name",
        start,
        end: position,
        raw: input.slice(start, position),
      };
    }
    if (delimiter(c)) throw new Error("Unexpected PDF delimiter");
    while (position < input.length && !delimiter(input[position])) position++;
    const raw = input.slice(start, position);
    // Inline image bytes require their own parser. Refuse this stream safely.
    if (raw === "BI")
      throw new Error("Inline image content is not editable yet");
    return { kind: "word", start, end: position, raw };
  }
  const tokens: Token[] = [];
  while (position < input.length) {
    skip();
    if (position < input.length) tokens.push(token());
  }
  return tokens;
}

function fontCodec(font: PDFDict): Codec | null {
  const subtype = font.get(name("Subtype"))?.toString();
  const composite = subtype === "/Type0";
  if (!composite && subtype !== "/Type1" && subtype !== "/TrueType")
    return null;
  if (composite && font.get(name("Encoding"))?.toString() !== "/Identity-H")
    return null;
  const codeBytes = composite ? 2 : 1;
  const base =
    font.get(name("BaseFont"))?.toString().slice(1) ?? "Unknown font";
  const map = new Map<number, string>();
  const widths = new Map<number, number>();
  let metricsSource = font;
  let defaultWidth = 0;
  if (composite) {
    const descendant = font
      .lookup(name("DescendantFonts"), PDFArray)
      .lookup(0, PDFDict);
    metricsSource = descendant;
    defaultWidth =
      descendant.lookupMaybe(name("DW"), PDFNumber)?.asNumber() ?? 1000;
    const entries = descendant.lookupMaybe(name("W"), PDFArray);
    for (let i = 0; entries && i < entries.size();) {
      const first = entries.lookup(i++, PDFNumber).asNumber();
      const next = entries.lookup(i++);
      if (next instanceof PDFArray) {
        for (let j = 0; j < next.size(); j++)
          widths.set(first + j, next.lookup(j, PDFNumber).asNumber());
      } else if (next instanceof PDFNumber) {
        const last = next.asNumber();
        const width = entries.lookup(i++, PDFNumber).asNumber();
        if (last - first > 65535) return null;
        for (let code = first; code <= last; code++) widths.set(code, width);
      } else return null;
    }
  } else {
    const entries = font.lookupMaybe(name("Widths"), PDFArray);
    const first =
      font.lookupMaybe(name("FirstChar"), PDFNumber)?.asNumber() ?? 0;
    if (entries)
      for (let i = 0; i < entries.size(); i++)
        widths.set(first + i, entries.lookup(i, PDFNumber).asNumber());
    if (
      !entries &&
      Object.values(FontNames).includes(base as FontNames) &&
      !["Symbol", "ZapfDingbats"].includes(base)
    ) {
      const metrics = Font.load(base as FontNames);
      for (const codePoint of Encodings.WinAnsi.supportedCodePoints) {
        const glyph = Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint);
        const width = metrics.getWidthOfGlyph(glyph.name);
        if (typeof width === "number") widths.set(glyph.code, width);
      }
    }
    if (!widths.size) return null;
  }
  const addMapping = (source: string, destination: string) => {
    if (
      source.length !== codeBytes * 2 ||
      !destination.length ||
      destination.length % 4
    )
      throw new Error("Unsupported Unicode mapping");
    const decoded = String.fromCharCode(
      ...(destination.match(/.{4}/g) ?? []).map((value) => parseInt(value, 16)),
    );
    if (Array.from(decoded).length !== 1)
      throw new Error("Multi-character glyph mapping is read-only");
    map.set(parseInt(source, 16), decoded);
  };
  const unicode = font.lookup(name("ToUnicode"));
  if (unicode instanceof PDFRawStream) {
    const cmap = binary(decodePDFRawStream(unicode).decode());
    const ranges = [
      ...cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g),
    ].flatMap((section) => [
      ...section[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi),
    ]);
    if (
      !ranges.length ||
      ranges.some(
        (range) =>
          range[1].length !== codeBytes * 2 ||
          range[2].length !== codeBytes * 2,
      )
    )
      return null;
    for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of section[1].matchAll(
        /<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi,
      )) {
        addMapping(pair[1], pair[2]);
      }
    }
    for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const range of section[1].matchAll(
        /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]+)>|\[([^\]]*)\])/gi,
      )) {
        const first = parseInt(range[1], 16),
          last = parseInt(range[2], 16);
        if (last < first || last - first > 65535) return null;
        const destinations =
          range[5] === undefined
            ? null
            : [...range[5].matchAll(/<([0-9a-f]+)>/gi)].map(
                (match) => match[1],
              );
        if (destinations && destinations.length !== last - first + 1)
          return null;
        for (let code = first; code <= last; code++) {
          const destination = destinations
            ? destinations[code - first]
            : (BigInt("0x" + range[4]) + BigInt(code - first))
                .toString(16)
                .padStart(range[4].length, "0");
          addMapping(
            code.toString(16).padStart(codeBytes * 2, "0"),
            destination,
          );
        }
      }
    }
  } else {
    if (composite) return null;
    const encoding = font.get(name("Encoding"))?.toString();
    if (encoding !== "/WinAnsiEncoding" && encoding !== "/MacRomanEncoding")
      return null;
    const decoder = new TextDecoder(
      encoding === "/WinAnsiEncoding" ? "windows-1252" : "macintosh",
    );
    for (let code = 32; code < 256; code++) {
      // Subset fonts may name a normal encoding yet contain only a few glyphs.
      if ((widths.get(code) ?? 0) <= 0) continue;
      const decoded = decoder.decode(Uint8Array.of(code));
      if (decoded !== "\ufffd" && !/[\x00-\x1f\x7f-\x9f]/.test(decoded))
        map.set(code, decoded);
    }
  }
  if (!map.size) return null;
  const reverse = new Map(
    Array.from(map, ([code, character]) => [character, code]),
  );
  function codes(bytes: number[]) {
    if (bytes.length % codeBytes) throw new Error("Incomplete character code");
    const result: number[] = [];
    for (let i = 0; i < bytes.length; i += codeBytes)
      result.push(codeBytes === 1 ? bytes[i] : bytes[i] * 256 + bytes[i + 1]);
    return result;
  }
  return {
    name: base,
    characters: Array.from(reverse.keys()).sort().join(""),
    ascent:
      (metricsSource
        .lookupMaybe(name("FontDescriptor"), PDFDict)
        ?.lookupMaybe(name("Ascent"), PDFNumber)
        ?.asNumber() ?? 800) / 1000,
    descent:
      (metricsSource
        .lookupMaybe(name("FontDescriptor"), PDFDict)
        ?.lookupMaybe(name("Descent"), PDFNumber)
        ?.asNumber() ?? -200) / 1000,
    decode(bytes) {
      return codes(bytes)
        .map((code) => {
          const character = map.get(code);
          if (character === undefined) throw new Error("Unmapped glyph");
          return character;
        })
        .join("");
    },
    encode(text) {
      return Array.from(text).flatMap((character) => {
        const code = reverse.get(character);
        if (code === undefined)
          throw new Error(
            `The original font does not contain “${character}”. Choose characters already available in this font.`,
          );
        return codeBytes === 1 ? [code] : [code >> 8, code & 255];
      });
    },
    advance(bytes, size, characterSpacing, wordSpacing) {
      if (!Number.isFinite(size) || size === 0)
        throw new Error("Invalid font size");
      return codes(bytes).reduce(
        (sum, code) =>
          sum +
          (widths.get(code) ?? defaultWidth) +
          (1000 *
            (characterSpacing +
              (codeBytes === 1 && code === 32 ? wordSpacing : 0))) /
            size,
        0,
      );
    },
  };
}

function streams(page: PDFPage): string[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  const entries =
    contents instanceof PDFArray ? contents.asArray() : [contents];
  return entries.map((ref) => {
    const stream = page.doc.context.lookup(ref);
    if (stream instanceof PDFContentStream)
      return binary(stream.getUnencodedContents());
    if (!(stream instanceof PDFRawStream))
      throw new Error("Unsupported page content stream");
    return binary(decodePDFRawStream(stream).decode());
  });
}
/** A non-security integrity stamp; detects stream rewrites before trusting IDs. */
export function pageTextFingerprint(page: PDFPage): string {
  let first = 2166136261,
    second = 3339675911,
    length = 0;
  for (const stream of streams(page)) {
    for (let index = 0; index < stream.length; index++) {
      const value = stream.charCodeAt(index);
      first = Math.imul(first ^ value, 16777619);
      second = Math.imul(second ^ value, 2246822519);
    }
    first = Math.imul(first ^ 256, 16777619);
    second = Math.imul(second ^ 256, 2246822519);
    length += stream.length;
  }
  return `${length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function runGeometry(run: Run, replacement?: string): EditableRun["geometry"] {
  if (
    !run.matrix ||
    !Number.isFinite(run.horizontalScale) ||
    Math.abs(run.horizontalScale) < 1e-12
  )
    return;
  try {
    inverseVector(run.matrix, { x: 0, y: 0 });
  } catch {
    return;
  }
  const parts =
    replacement !== undefined && replacement !== run.text
      ? [
          ...run.leading.map((raw) => ({ kind: "word", raw }) as Token),
          { kind: "string", bytes: run.codec.encode(replacement) } as Token,
        ]
      : run.parts;
  let cursor = 0,
    first = NaN,
    left = Infinity,
    right = -Infinity;
  for (const part of parts) {
    if (part.kind === "string") {
      const advance =
        (run.codec.advance(
          part.bytes ?? [],
          run.size,
          run.characterSpacing,
          run.wordSpacing,
        ) *
          run.size *
          run.horizontalScale) /
        1000;
      if (part.bytes?.length) {
        if (!Number.isFinite(first)) first = cursor;
        left = Math.min(left, cursor, cursor + advance);
        right = Math.max(right, cursor, cursor + advance);
      }
      cursor += advance;
    } else cursor -= (Number(part.raw) * run.size * run.horizontalScale) / 1000;
  }
  if (replacement === "") left = right = first = cursor;
  if (![left, right, first].every(Number.isFinite)) return;
  const top = run.codec.ascent * run.size + run.rise,
    bottom = run.codec.descent * run.size + run.rise;
  return {
    quad: [
      { x: left, y: bottom },
      { x: right, y: bottom },
      { x: right, y: top },
      { x: left, y: top },
    ].map((point) => transform(run.matrix!, point)),
    baseline: transform(run.matrix, { x: first, y: run.rise }),
  };
}

function findRuns(page: PDFPage, content: string[]): Run[] {
  const fonts = page.node.Resources()?.lookupMaybe(name("Font"), PDFDict);
  if (!fonts) return [];
  const codecs = new Map<string, Codec>();
  for (const [key, value] of fonts.entries()) {
    try {
      const codec = fontCodec(page.doc.context.lookup(value, PDFDict));
      if (codec) codecs.set(key.toString(), codec);
    } catch {
      /* Unsupported fonts stay read-only. */
    }
  }
  const runs: Run[] = [];
  let state = {
    font: "",
    size: 0,
    characterSpacing: 0,
    wordSpacing: 0,
    mode: 0,
    horizontalScale: 1,
    rise: 0,
    leading: 0,
    ctm: identity(),
  };
  const stack: (typeof state)[] = [];
  const marked: boolean[] = [];
  let inText = false;
  let textMatrix: Matrix | null = null,
    lineMatrix: Matrix | null = null;
  const nextLine = (x: number, y: number) => {
    lineMatrix = lineMatrix ? multiply(lineMatrix, [1, 0, 0, 1, x, y]) : null;
    textMatrix = lineMatrix;
  };
  content.forEach((input, stream) => {
    let tokens: Token[];
    try {
      tokens = tokenize(input);
    } catch {
      state = { ...state, font: "", mode: -1 };
      stack.length = 0;
      inText = false;
      textMatrix = null;
      lineMatrix = null;
      return;
    }
    let operands: Token[] = [];
    for (const token of tokens) {
      const operator =
        token.kind === "word" && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token.raw);
      if (!operator) {
        operands.push(token);
        continue;
      }
      const number = (offset = -1) => Number(operands.at(offset)?.raw);
      if (token.raw === "q") stack.push({ ...state });
      if (token.raw === "Q")
        state = stack.pop() ?? { ...state, font: "", mode: -1 };
      if (token.raw === "cm")
        state.ctm = multiply(
          state.ctm,
          operands.slice(-6).map((value) => Number(value.raw)) as Matrix,
        );
      if (token.raw === "Tf") {
        state.font = operands.at(-2)?.raw ?? "";
        state.size = number();
      }
      if (token.raw === "Tc") state.characterSpacing = number();
      if (token.raw === "Tw") state.wordSpacing = number();
      if (token.raw === "Tr") state.mode = number();
      if (token.raw === "Tz") state.horizontalScale = number() / 100;
      if (token.raw === "Ts") state.rise = number();
      if (token.raw === "TL") state.leading = number();
      if (token.raw === "gs") {
        const graphics = page.node
          .Resources()
          ?.lookupMaybe(name("ExtGState"), PDFDict)
          ?.lookup(name(operands.at(-1)?.raw.slice(1) ?? ""));
        if (graphics instanceof PDFDict && graphics.has(name("Font")))
          state.font = "";
      }
      if (token.raw === "BT") {
        inText = true;
        textMatrix = identity();
        lineMatrix = identity();
      }
      if (token.raw === "ET") {
        inText = false;
        textMatrix = null;
        lineMatrix = null;
      }
      if (token.raw === "Tm") {
        textMatrix = operands
          .slice(-6)
          .map((value) => Number(value.raw)) as Matrix;
        lineMatrix = textMatrix;
      }
      if (token.raw === "Td" || token.raw === "TD") {
        if (token.raw === "TD") state.leading = -number();
        nextLine(number(-2), number());
      }
      if (token.raw === "T*") nextLine(0, -state.leading);
      if (token.raw === "BMC" || token.raw === "BDC") {
        const property = operands.at(-1);
        let actual = /\/ActualText\b/.test(property?.raw ?? "");
        if (token.raw === "BDC" && property?.kind === "name") {
          const dictionary = page.node
            .Resources()
            ?.lookupMaybe(name("Properties"), PDFDict)
            ?.lookup(name(property.raw.slice(1)));
          actual =
            !(dictionary instanceof PDFDict) ||
            dictionary.has(name("ActualText"));
        }
        marked.push(token.raw === "BDC" && actual);
      }
      if (token.raw === "EMC") marked.pop();
      if (inText && ["Tj", "TJ", "'", '"'].includes(token.raw)) {
        if (token.raw === '"') {
          state.wordSpacing = number(-3);
          state.characterSpacing = number(-2);
        }
        if (token.raw === '"' || token.raw === "'") nextLine(0, -state.leading);
        const operand = operands.at(-1),
          codec = codecs.get(state.font);
        if (!operand || !codec) {
          textMatrix = null;
          operands = [];
          continue;
        }
        try {
          if (
            token.raw === "TJ"
              ? operand.kind !== "array"
              : operand.kind !== "string"
          )
            throw new Error("Invalid text operand");
          const parts =
            operand.kind === "array" ? (operand.children ?? []) : [operand];
          if (
            parts.some(
              (part) =>
                part.kind !== "string" &&
                !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part.raw),
            )
          )
            throw new Error("Unsupported text array");
          const advance = parts.reduce(
            (sum, part) =>
              sum +
              (part.kind === "string"
                ? codec.advance(
                    part.bytes ?? [],
                    state.size,
                    state.characterSpacing,
                    state.wordSpacing,
                  )
                : -Number(part.raw)),
            0,
          );
          if (
            ["Tj", "TJ"].includes(token.raw) &&
            [0, 1, 2].includes(state.mode) &&
            !marked.some(Boolean)
          ) {
            const text = parts
              .filter((part) => part.kind === "string")
              .map((part) => codec.decode(part.bytes ?? []))
              .join("");
            if (text.trim() && Number.isFinite(advance)) {
              const run: Run = {
                id: stream + ":" + operand.start,
                text,
                font: codec.name,
                characters: codec.characters,
                codec,
                stream,
                start: operand.start,
                end: token.end,
                advance,
                leading: parts
                  .slice(
                    0,
                    parts.findIndex((part) => part.kind === "string"),
                  )
                  .map((part) => part.raw),
                size: state.size,
                characterSpacing: state.characterSpacing,
                wordSpacing: state.wordSpacing,
                matrix: textMatrix
                  ? multiply(state.ctm, textMatrix)
                  : undefined,
                horizontalScale: state.horizontalScale,
                rise: state.rise,
                parts,
                textMatrix: textMatrix ?? undefined,
                lineMatrix: lineMatrix ?? undefined,
                ctm: state.ctm,
              };
              run.geometry = runGeometry(run);
              runs.push(run);
            }
          }
          if (textMatrix)
            textMatrix = multiply(textMatrix, [
              1,
              0,
              0,
              1,
              (advance * state.size * state.horizontalScale) / 1000,
              0,
            ]);
        } catch {
          textMatrix = null;
        }
      }
      operands = [];
    }
  });
  return runs;
}

export async function inspectEditableText(
  bytes: Uint8Array,
  pageIndex: number,
  replacements: TextReplacement[] = [],
  copies: TextCopy[] = [],
): Promise<EditableRun[]> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  return inspectPageText(page, replacements, copies);
}
export function inspectPageText(
  page: PDFPage,
  replacements: TextReplacement[] = [],
  copies: TextCopy[] = [],
): EditableRun[] {
  const values = new Map(
    replacements.map((edit) => [edit.runId, edit.replacement]),
  );
  return findRuns(page, streams(page)).flatMap((run) => [
    {
      id: run.id,
      text: run.text,
      font: run.font,
      characters: run.characters,
      fontSize: Math.abs(run.size),
      geometry: runGeometry(run, values.get(run.id)),
    },
    ...copies
      .filter((copy) => copy.sourceRunId === run.id)
      .map((copy) => ({
        id: `copy:${copy.id}`,
        text: copy.text,
        font: run.font,
        characters: run.characters,
        fontSize: Math.abs(run.size),
        geometry: runGeometry(run, values.get(`copy:${copy.id}`) ?? copy.text),
      })),
  ]);
}

/** Rewrite the original text operator, preserving its font, colour and matrix. */
export function replacePageText(
  page: PDFPage,
  replacements: TextReplacement[],
  offsets: TextOffset[] = [],
  transforms: TextTransform[] = [],
  copies: TextCopy[] = [],
) {
  if (transforms.length || copies.length)
    return replaceWithPlacements(
      page,
      replacements,
      offsets,
      transforms,
      copies,
    );
  if (!replacements.length && !offsets.length) return;
  const content = streams(page);
  const runs = findRuns(page, content);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const ids = new Set<string>();
  const replacementMap = new Map(
    replacements.map((edit) => [edit.runId, edit]),
  );
  const offsetMap = new Map(offsets.map((offset) => [offset.runId, offset]));
  if (
    replacementMap.size !== replacements.length ||
    offsetMap.size !== offsets.length
  )
    throw new Error("Duplicate text operation");
  const edits = [
    ...new Set([...replacementMap.keys(), ...offsetMap.keys()]),
  ].map((runId) => {
    const replacement = replacementMap.get(runId),
      offset = offsetMap.get(runId);
    const edit = replacement ?? {
      runId,
      original: offset!.original,
      replacement: offset!.original,
    };
    if (ids.has(edit.runId)) throw new Error("Duplicate text replacement");
    ids.add(edit.runId);
    const run = byId.get(edit.runId);
    if (!run || run.text !== edit.original)
      throw new Error(
        "The original text changed. Reopen this page before editing.",
      );
    if (offset && offset.original !== run.text)
      throw new Error(
        "The original text changed. Reopen this page before moving it.",
      );
    if (/[\r\n]/.test(edit.replacement))
      throw new Error("Use a single line for this text run.");
    const bytes = run.codec.encode(edit.replacement);
    const hex = `<${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}>`;
    const newAdvance =
      run.codec.advance(
        bytes,
        run.size,
        run.characterSpacing,
        run.wordSpacing,
      ) - run.leading.reduce((sum, value) => sum + Number(value), 0);
    const compensation = Number((newAdvance - run.advance).toFixed(8));
    let value =
      edit.replacement === run.text
        ? content[run.stream].slice(run.start, run.end)
        : `[${run.leading.join(" ")} ${hex} ${compensation}] TJ`;
    if (offset && (offset.dx || offset.dy)) {
      if (
        ![offset.dx, offset.dy].every(Number.isFinite) ||
        !run.geometry ||
        !run.matrix
      )
        throw new Error("This text position cannot be moved safely.");
      const local = inverseVector(run.matrix, { x: offset.dx, y: offset.dy });
      const adjustment = (-1000 * local.x) / (run.size * run.horizontalScale);
      const numeric = (value: number) => {
        if (!Number.isFinite(value) || Math.abs(value) > 1e12)
          throw new Error("Text movement is out of range.");
        return Number(value.toFixed(10)).toString();
      };
      // TJ shifts only the text cursor, never the line matrix. Ts shifts the
      // baseline. Restore both after drawing so neighbouring text stays put.
      // Zero Tc around numeric-only TJ arrays also avoids an extra character
      // advance in PDF.js text extraction. The original spacing is restored
      // before the actual glyphs and before the following source operators.
      value = `${numeric(run.rise + local.y)} Ts 0 Tc [${numeric(adjustment)}] TJ ${numeric(run.characterSpacing)} Tc\n${value}\n0 Tc [${numeric(-adjustment)}] TJ ${numeric(run.characterSpacing)} Tc ${numeric(run.rise)} Ts`;
    }
    return {
      ...run,
      value,
    };
  });
  edits
    .sort((a, b) => b.start - a.start)
    .forEach((edit) => {
      content[edit.stream] =
        content[edit.stream].slice(0, edit.start) +
        edit.value +
        content[edit.stream].slice(edit.end);
    });
  // New streams for this page only: a shared source stream must not affect copies.
  page.node.set(
    name("Contents"),
    page.doc.context.obj(
      content.map((value) =>
        page.doc.context.register(page.doc.context.flateStream(toBytes(value))),
      ),
    ),
  );
}

function replaceWithPlacements(
  page: PDFPage,
  replacements: TextReplacement[],
  offsets: TextOffset[],
  placements: TextTransform[],
  copies: TextCopy[],
) {
  const content = streams(page),
    runs = findRuns(page, content),
    source = new Map(runs.map((run) => [run.id, run]));
  const edits = new Map(replacements.map((e) => [e.runId, e])),
    moves = new Map(offsets.map((e) => [e.runId, e])),
    matrices = new Map(placements.map((e) => [e.runId, e]));
  if (
    edits.size !== replacements.length ||
    moves.size !== offsets.length ||
    matrices.size !== placements.length ||
    new Set(copies.map((c) => c.id)).size !== copies.length
  )
    throw Error("Duplicate text operation.");
  const aliases = new Map<string, { run: Run; text: string }>();
  runs.forEach((run) => aliases.set(run.id, { run, text: run.text }));
  for (const copy of copies) {
    const run = source.get(copy.sourceRunId);
    if (!run || run.text !== copy.sourceOriginal)
      throw Error("The copied source text changed. Reopen this page.");
    aliases.set(`copy:${copy.id}`, { run, text: copy.text });
  }
  const touched = new Set(copies.map((c) => c.sourceRunId));
  for (const [id, operation] of [...edits, ...moves, ...matrices]) {
    const entry = aliases.get(id);
    if (!entry || entry.text !== operation.original)
      throw Error(
        "The original text changed. Reopen this page before editing.",
      );
    touched.add(entry.run.id);
  }
  const numeric = (n: number) => {
    if (!Number.isFinite(n) || Math.abs(n) > 1e12)
      throw Error("Text transformation is out of range.");
    return String(Number(n.toFixed(10)));
  };
  const tm = (matrix: Matrix) => matrix.map(numeric).join(" ") + " Tm";
  const changes = runs
    .filter((run) => touched.has(run.id))
    .map((run) => {
      const show = (id: string, original: string) => {
        const text = edits.get(id)?.replacement ?? original;
        if (/[\r\n]/.test(text))
          throw Error("Use a single line for this text run.");
        const bytes = run.codec.encode(text),
          hex = `<${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}>`;
        const advance =
          run.codec.advance(
            bytes,
            run.size,
            run.characterSpacing,
            run.wordSpacing,
          ) - run.leading.reduce((sum, n) => sum + Number(n), 0);
        const drawing =
          text === run.text
            ? content[run.stream].slice(run.start, run.end)
            : `[${run.leading.join(" ")} ${hex} ${numeric(advance - run.advance)}] TJ`;
        const offset = moves.get(id),
          placement = matrices.get(id);
        if (
          !run.matrix ||
          !run.textMatrix ||
          !run.lineMatrix ||
          !run.geometry
        ) {
          if (offset || placement || id.startsWith("copy:"))
            throw Error("This text has an unsupported transformation.");
          return drawing;
        }
        const matrix = placement?.matrix ?? identity();
        if (matrix.length !== 6 || !matrix.every(Number.isFinite))
          throw Error("Text transformation is invalid.");
        inverse(matrix);
        const effective = multiply(
          [1, 0, 0, 1, offset?.dx ?? 0, offset?.dy ?? 0],
          matrix,
        );
        return `${tm(multiply(inverse(run.ctm), multiply(effective, run.matrix)))}\n${drawing}`;
      };
      let value = show(run.id, run.text);
      for (const copy of copies.filter((c) => c.sourceRunId === run.id))
        value += "\n" + show(`copy:${copy.id}`, copy.text);
      if (run.textMatrix && run.lineMatrix && run.geometry) {
        const after = multiply(run.textMatrix, [
          1,
          0,
          0,
          1,
          (run.advance * run.size * run.horizontalScale) / 1000,
          0,
        ]);
        const cursor = inverseVector(run.lineMatrix, {
          x: after[4] - run.lineMatrix[4],
          y: after[5] - run.lineMatrix[5],
        });
        if (Math.abs(cursor.y) > 1e-5)
          throw Error("Unable to preserve the surrounding text cursor.");
        value += `\n${tm(run.lineMatrix)} 0 Tc [${numeric((-1000 * cursor.x) / (run.size * run.horizontalScale))}] TJ ${numeric(run.characterSpacing)} Tc`;
      }
      return { ...run, value };
    });
  changes
    .sort((a, b) => b.start - a.start)
    .forEach((edit) => {
      content[edit.stream] =
        content[edit.stream].slice(0, edit.start) +
        edit.value +
        content[edit.stream].slice(edit.end);
    });
  page.node.set(
    name("Contents"),
    page.doc.context.obj(
      content.map((value) =>
        page.doc.context.register(page.doc.context.flateStream(toBytes(value))),
      ),
    ),
  );
}
