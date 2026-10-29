import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { Font, FontNames, Encodings } from "@pdf-lib/standard-fonts";

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
  let defaultWidth = 0;
  if (composite) {
    const descendant = font
      .lookup(name("DescendantFonts"), PDFArray)
      .lookup(0, PDFDict);
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
    if (!(stream instanceof PDFRawStream))
      throw new Error("Unsupported page content stream");
    return binary(decodePDFRawStream(stream).decode());
  });
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
  };
  const stack: (typeof state)[] = [];
  const marked: boolean[] = [];
  let inText = false;
  content.forEach((input, stream) => {
    let tokens: Token[];
    try {
      tokens = tokenize(input);
    } catch {
      state = { ...state, font: "", mode: -1 };
      stack.length = 0;
      inText = false;
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
      if (token.raw === "Tf") {
        state.font = operands.at(-2)?.raw ?? "";
        state.size = number();
      }
      if (token.raw === "Tc") state.characterSpacing = number();
      if (token.raw === "Tw") state.wordSpacing = number();
      if (token.raw === "Tr") state.mode = number();
      if (token.raw === "BT") inText = true;
      if (token.raw === "ET") inText = false;
      if (token.raw === "BMC" || token.raw === "BDC") {
        const property = operands.at(-1);
        let hasActualText = /\/ActualText\b/.test(property?.raw ?? "");
        if (token.raw === "BDC" && property?.kind === "name") {
          const properties = page.node
            .Resources()
            ?.lookupMaybe(name("Properties"), PDFDict);
          const dictionary = properties?.lookup(name(property.raw.slice(1)));
          hasActualText =
            !(dictionary instanceof PDFDict) ||
            dictionary.has(name("ActualText"));
        }
        marked.push(token.raw === "BDC" && hasActualText);
      }
      if (token.raw === "EMC") marked.pop();
      if (
        inText &&
        ["Tj", "TJ"].includes(token.raw) &&
        [0, 1, 2].includes(state.mode) &&
        !marked.some(Boolean)
      ) {
        const operand = operands.at(-1);
        const codec = codecs.get(state.font);
        if (operand && codec) {
          try {
            if (
              (token.raw === "Tj" && operand.kind !== "string") ||
              (token.raw === "TJ" && operand.kind !== "array")
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
            const strings = parts.filter((part) => part.kind === "string");
            const text = strings
              .map((part) => codec.decode(part.bytes ?? []))
              .join("");
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
            if (text.trim() && Number.isFinite(advance))
              runs.push({
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
              });
          } catch {
            /* Leave undecodable text read-only. */
          }
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
): Promise<EditableRun[]> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  return findRuns(page, streams(page)).map(
    ({ id, text, font, characters }) => ({ id, text, font, characters }),
  );
}

/** Rewrite the original text operator, preserving its font, colour and matrix. */
export function replacePageText(
  page: PDFPage,
  replacements: TextReplacement[],
) {
  if (!replacements.length) return;
  const content = streams(page);
  const runs = findRuns(page, content);
  const ids = new Set<string>();
  const edits = replacements.map((edit) => {
    if (ids.has(edit.runId)) throw new Error("Duplicate text replacement");
    ids.add(edit.runId);
    const run = runs.find((run) => run.id === edit.runId);
    if (!run || run.text !== edit.original)
      throw new Error(
        "The original text changed. Reopen this page before editing.",
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
    return {
      ...run,
      value: `[${run.leading.join(" ")} ${hex} ${compensation}] TJ`,
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
