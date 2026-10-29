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
}
interface Run extends EditableRun {
  start: number;
  end: number;
  codec: Codec;
  stream: number;
  leading: string[];
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
  if (subtype !== "/Type1" && subtype !== "/TrueType") return null;
  const base =
    font.get(name("BaseFont"))?.toString().slice(1) ?? "Unknown font";
  const map = new Map<number, string>();
  const unicode = font.lookup(name("ToUnicode"));
  if (unicode instanceof PDFRawStream) {
    const cmap = binary(decodePDFRawStream(unicode).decode());
    // Only single-byte bfchar CMaps are currently supported.
    if (/beginbfrange/.test(cmap) || !/<00>\s*<FF>/i.test(cmap)) return null;
    for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of section[1].matchAll(
        /<([0-9a-f]{2})>\s*<([0-9a-f]+)>/gi,
      )) {
        if (pair[2].length % 4) return null;
        const decoded = String.fromCharCode(
          ...(pair[2].match(/.{4}/g) ?? []).map((value) => parseInt(value, 16)),
        );
        if (Array.from(decoded).length !== 1) return null;
        map.set(parseInt(pair[1], 16), decoded);
      }
    }
  } else {
    const encoding = font.get(name("Encoding"))?.toString();
    if (encoding !== "/WinAnsiEncoding" && encoding !== "/MacRomanEncoding")
      return null;
    const decoder = new TextDecoder(
      encoding === "/WinAnsiEncoding" ? "windows-1252" : "macintosh",
    );
    const widths = font.lookupMaybe(name("Widths"), PDFArray);
    const first =
      font.lookupMaybe(name("FirstChar"), PDFNumber)?.asNumber() ?? 0;
    const standard =
      /^(Helvetica|Times-|Courier)/.test(base) && subtype === "/Type1";
    for (let code = 32; code < 256; code++) {
      // Subset fonts may name a normal encoding yet contain only a few glyphs.
      if (
        !standard &&
        (!widths ||
          code < first ||
          code >= first + widths.size() ||
          widths.lookup(code - first, PDFNumber).asNumber() <= 0)
      )
        continue;
      const decoded = decoder.decode(Uint8Array.of(code));
      if (decoded !== "\ufffd" && !/[\x00-\x1f\x7f-\x9f]/.test(decoded))
        map.set(code, decoded);
    }
  }
  if (!map.size) return null;
  const reverse = new Map(
    Array.from(map, ([code, character]) => [character, code]),
  );
  return {
    name: base,
    characters: Array.from(reverse.keys()).sort().join(""),
    decode(bytes) {
      return bytes
        .map((code) => {
          const character = map.get(code);
          if (character === undefined) throw new Error("Unmapped glyph");
          return character;
        })
        .join("");
    },
    encode(text) {
      return Array.from(text, (character) => {
        const code = reverse.get(character);
        if (code === undefined)
          throw new Error(
            `The original font does not contain “${character}”. Choose characters already available in this font.`,
          );
        return code;
      });
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
  // Rendering modes persist across streams; do not edit text that might clip.
  if (content.some((input) => /\bTr\b/.test(input))) return [];
  const fonts = page.node.Resources()?.lookupMaybe(name("Font"), PDFDict);
  if (!fonts) return [];
  const codecs = new Map<string, Codec>();
  for (const [key, value] of fonts.entries()) {
    try {
      const codec = fontCodec(page.doc.context.lookup(value, PDFDict));
      if (codec) codecs.set(key.toString(), codec);
    } catch {
      /* Unsupported font stays read-only. */
    }
  }
  const runs: Run[] = [];
  let font = "";
  const fontStack: string[] = [];
  content.forEach((input, stream) => {
    // ActualText can contain a second textual representation. Do not leave it stale.
    if (/\/ActualText\b/.test(input)) {
      font = "";
      fontStack.length = 0;
      return;
    }
    let tokens: Token[];
    try {
      tokens = tokenize(input);
    } catch {
      font = "";
      fontStack.length = 0;
      return;
    }
    if (tokens.some((token) => token.kind === "word" && token.raw === "Tr")) {
      font = "";
      fontStack.length = 0;
      return;
    }
    let operands: Token[] = [];
    let inText = false;
    let shows: { operand: Token; operator: Token; font: string }[] = [];
    let unsupported = false;
    for (const token of tokens) {
      const operator =
        token.kind === "word" && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token.raw);
      if (!operator) {
        operands.push(token);
        continue;
      }
      if (token.raw === "q") fontStack.push(font);
      if (token.raw === "Q") font = fontStack.pop() ?? "";
      if (token.raw === "Tf") font = operands.at(-2)?.raw ?? "";
      if (token.raw === "BT") {
        inText = true;
        shows = [];
        unsupported = false;
      }
      if (inText && ["Tj", "TJ"].includes(token.raw)) {
        const operand = operands.at(-1);
        if (operand) shows.push({ operand, operator: token, font });
      }
      // Quote operators, clipping text and XObjects need richer state handling.
      if (inText && ["'", '"', "Tr", "Do"].includes(token.raw))
        unsupported = true;
      if (token.raw === "ET") {
        inText = false;
        if (!unsupported && shows.length === 1) {
          const show = shows[0];
          const codec = codecs.get(show.font);
          if (codec) {
            try {
              const parts =
                show.operand.kind === "array"
                  ? (show.operand.children ?? [])
                  : [show.operand];
              if (
                parts.some(
                  (part) =>
                    part.kind !== "string" &&
                    !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part.raw),
                )
              )
                throw new Error("Unsupported text array");
              const text = parts
                .filter((part) => part.kind === "string")
                .map((part) => codec.decode(part.bytes ?? []))
                .join("");
              if (text.trim())
                runs.push({
                  id: `${stream}:${show.operand.start}`,
                  text,
                  font: codec.name,
                  characters: codec.characters,
                  codec,
                  stream,
                  start: show.operand.start,
                  end: show.operator.end,
                  leading: parts
                    .slice(
                      0,
                      parts.findIndex((part) => part.kind === "string"),
                    )
                    .map((part) => part.raw),
                });
            } catch {
              /* Leave undecodable text read-only. */
            }
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
    return {
      ...run,
      value: run.leading.length
        ? `[${run.leading.join(" ")} ${hex}] TJ`
        : `${hex} Tj`,
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
