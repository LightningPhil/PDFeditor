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
- Export a new PDF with original page content and new annotations.

Edits live in memory: export before closing or refreshing the tab. Export does
not change the originals. Imported sources remain in memory to support undo.

## Existing-text editing: the priority for milestone two

Existing page text cannot yet be changed. The UI deliberately distinguishes
adding text from inspecting original text. Covering a word with a rectangle is
not text removal or redaction, and is not our planned editing implementation.

PDF.js renders and extracts text. pdf-lib copies pages and writes annotations;
it does not provide ordinary page-text replacement. Sample documents will guide
the choice of an engine/content-stream editing layer and font handling. Before
choosing an engine, assess licensing, browser support, text deletion/replacement,
embedded subset fonts, layout fidelity, and whether OCR is needed for scans.

Put local examples and desired edits in `samples/`; they are ignored by Git.

## Current limits

This is a foundation, not a finished editor. Text annotations use Helvetica and
support basic Latin characters; unsupported characters cause an explicit export
error. Annotations are disabled for rotated pages, non-zero crop origins, and
custom user units until coordinate handling is expanded. Shapes are rectangles
only. Annotation selection/movement, thumbnails, autosave, password entry, OCR,
and true text replacement are future work. Password-protected PDFs may fail to
open. Page export is intended for ordinary static PDFs: document-level features
such as bookmarks, signatures, forms, and tagged structure are not guaranteed
to survive page copying. Signed originals should be retained.

## Structure

- `src/App.tsx`: import, rendering, page workspace, annotations, and history.
- `src/pdf.ts`: document model and PDF export, kept independent of React.
- `src/pdf.test.ts`: generated-fixture checks for page copying and annotations.
- `samples/`: private local examples; only its README is tracked.

## Development preference

Work in this checkout. One human and one agent; do not delegate to other agents
or create extra worktrees unless requested.
