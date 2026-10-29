# PDFeditor

A TypeScript / React PDF workspace built with Vite. Local-first: PDF bytes stay in
the browser. There is no upload service, account system, or paid API.

## Run

Requires Node.js 22.12+ (Node 24 recommended).

```sh
npm install
npm run dev
```

Open the localhost URL printed by Vite. `npm run build` checks TypeScript and
creates the production bundle. `npm test` runs the PDF export regression tests.

## First milestone

- Open or drop one or more PDFs. Subsequent imports insert after the selected page.
- Select, reorder, or remove pages, with undo and redo.
- Preview pages and add text or outline rectangles in a chosen colour.
- Inspect extracted page text in a read-only panel.
- Edit supported original text runs using the original font, colour and position.
- Export a new PDF with original page content and new annotations.

Edits live in memory: export before closing or refreshing the tab. Export does
not change the originals. Imported sources remain in memory to support undo.

## Existing-text editing

Choose **Edit text**, change a text run in the side panel, then **Apply change**.
The page preview updates; edits participate in undo/redo and PDF export.

The custom content-stream editor in `src/text-edit.ts` rewrites the original
`Tj`/`TJ` drawing command. It does not cover text with rectangles or rasterise
the page. Original font resources, text matrices and colours are retained.
This is ordinary editing, not secure redaction or removal of metadata/history.

Current support is deliberately limited: one text-showing command per text
object, with simple WinAnsi/MacRoman fonts or single-byte `bfchar` Unicode maps.
Embedded subset fonts allow only their available glyphs. Unsupported runs stay
read-only, and missing glyphs cause an explicit error. Replacements are single
lines and do not reflow surrounding content; longer text can overlap neighbours.
Replacing a `TJ` run resets its internal kerning to the font's normal spacing.
Composite/CID fonts, range-based CMaps, split text objects, Form XObject text,
inline-image streams and text with ActualText or rendering-mode changes need
further work. Scans need OCR.

Local proof command (requires the optional PDF.js canvas dependency):

```sh
npx --yes --package tsx tsx scripts/prove-text-edit.ts samples/example.pdf "Old heading" "New heading" output/pdf/text-edit-proof
```

This edits the first page only, renders before/after PNGs and verifies the
replacement using independent PDF.js text extraction. Outputs are Git-ignored.

Put local examples and desired edits in `samples/`; they are ignored by Git.

## Current limits

This is a foundation, not a finished editor. Text annotations use Helvetica and
support basic Latin characters; unsupported characters cause an explicit export
error. Annotations are disabled for rotated pages, non-zero crop origins, and
custom user units until coordinate handling is expanded. Shapes are rectangles
only. Annotation selection/movement, thumbnails, autosave, password entry, OCR,
and broader text replacement are future work. Password-protected PDFs may fail to
open. Page export is intended for ordinary static PDFs: document-level features
such as bookmarks, signatures, forms, and tagged structure are not guaranteed
to survive page copying. Signed originals should be retained.

## Structure

- `src/App.tsx`: import, rendering, page workspace, annotations, and history.
- `src/pdf.ts`: document model and PDF export, kept independent of React.
- `src/text-edit.ts`: conservative PDF tokeniser, font decoding and text replacement.
- `src/pdf.test.ts`: generated-fixture checks for page copying and annotations.
- `samples/`: private local examples; only its README is tracked.

## Development preference

Work in this checkout. One human and one agent; do not delegate to other agents
or create extra worktrees unless requested.
