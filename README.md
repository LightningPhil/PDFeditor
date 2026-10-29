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

## Move and join text boxes

In **Edit text**, drag a box on the page to reposition its text. Shift-click boxes
or tick their side-panel checkboxes to select several, then choose **Join boxes**.
You can also drag empty page space to select several sections. **Select line**
expands a single selection to connected, aligned neighbours, including rotated
text and smaller superscripts; wide gaps stop expansion to avoid crossing columns.
Review the highlighted sections before joining.
The joined selection has one outline and moves as a unit. **Ungroup** separates
it again without changing its position. Arrow keys move a selected box by one
point, or ten with Shift; the panel also has one-point nudge buttons. Original
text and newly added text can be grouped together.

Joining is structural: each piece keeps its exact original glyph commands, font,
colour, baseline, kerning and relative position. It does not concatenate and
re-typeset the text. The inspector retains an input for each styled piece inside
the joined box; there is no automatic paragraph reflow. Edits, moves, joins and
ungrouping participate in undo/redo.

Movement converts the requested page displacement into the run's text space,
temporarily shifts its cursor and rise, then restores them. This preserves the
line matrix and the starting positions of following, unselected text, including
rotated/skewed text, page rotation, cropping, scaling and text rise.

Exports retain grouping in a private page dictionary (`PDFeditorTextGroups`).
Reopening the exported PDF in PDFeditor restores the joined boxes, including
previously added text. Other viewers ignore the metadata and display the same
standard PDF text drawing operations. Export does not rasterise text.

Group membership is disjoint and follows the original source ordering, even
after merging interleaved groups. Stale selections and conflicting identifiers
are rejected; damaged groups cannot cause a piece to move twice. A joined outline
does not intercept clicks or drag-selection on unrelated text in its empty interior.
Pending text changes must be applied or discarded before joining, and undo updates
both the rendered page and editor fields. Selection follows the constituent pieces
through joins, splits and undo/redo.

Current group metadata is version 2, stored as Unicode-safe PDF strings. It
records text/font/position anchors as well as a content stamp. Unchanged exports
restore exact IDs; harmless content-stream rewrites can be recovered using unique
anchors. Missing or ambiguous pieces cause that group to remain ungrouped, rather
than silently attaching it to the wrong text. Legacy version-1 exports remain
readable. Metadata decoding is bounded and avoids JavaScript argument limits for
large groups; write/read limits use the same bounded metadata size and maximum
of 100,000 pieces per page.

The custom content-stream editor in `src/text-edit.ts` rewrites the original
`Tj`/`TJ` drawing command. It does not cover text with rectangles or rasterise
the page. Original font resources, text matrices and colours are retained.
This is ordinary editing, not secure redaction or removal of metadata/history.

Current support includes multiple text commands per text object, simple
WinAnsi/MacRoman fonts and horizontal Identity-H composite fonts. Single-byte
and two-byte Unicode maps support `bfchar` and both `bfrange` forms.
Embedded subset fonts allow only their available glyphs. Unsupported runs stay
read-only, and missing glyphs cause an explicit error. Replacements are single
lines and do not reflow surrounding content; longer text can overlap neighbours.
Replacing a `TJ` run resets its internal kerning to the font's normal spacing.
The engine calculates glyph advances and retains the original final text position,
including character/word spacing and leading adjustments, so later text commands
do not shift. Fill, stroke and combined visible text modes are supported, along
with optional-content layers. Invisible/clipping text, unsupported encodings,
Form XObject text, inline-image streams and runs with ActualText stay read-only.
Scans need a separate OCR-guided pixel-editing workflow.

Local proof command (requires the optional PDF.js canvas dependency):

```sh
npx --yes --package tsx tsx scripts/prove-text-edit.ts samples/example.pdf "Old heading" "New heading" output/pdf/text-edit-proof
```

This edits the first page only, renders before/after PNGs and verifies the
replacement using independent PDF.js text extraction. Outputs are Git-ignored.

Put local examples and desired edits in `samples/`; they are ignored by Git.

## Batch sample verification

`scripts/audit-samples.ts` opens and renders the first page of every local sample.
`scripts/edit-all-samples.ts` takes a private JSON plan containing exactly one
edit per sample and exports complete documents, preserving their remaining pages.
It reopens outputs, checks page sizes/counts and annotation counts, checks original
file hashes, independently extracts text, and renders before/after comparisons.
Its private outputs and report are written under `output/pdf/edited-samples/`.

The local scan proof in `scripts/prove-scan-edit.ts` uses Tesseract.js on the
computer to locate a word, replaces one image glyph with an existing glyph from
the same line, and checks the resulting image with OCR again. It is a constrained
proof for a single-image page, not an interactive OCR feature or general scan editor.
It preserves the scan's dimensions and annotations and drops the replaced image
from the copied document. OCR downloads language data; documents are not uploaded.

`scripts/verify-text-layout.ts` tests joins, movement, PDF grouping metadata and
reversible placement against all local text samples. It compares rendered pixels
before/after joining and after restoring a move. `src/text-layout.test.ts` also
checks mixed fonts, existing edits/offsets, kerning, neighbouring text, added text,
page rotation, crop boxes, user units, skew and export/reimport.
`src/text-boxes.test.ts` exercises 1,000 deterministic mixed join/move/ungroup
operations and large selections. Selection tests cover column gaps, rotated
quads and empty group interiors. Storage tests cover Unicode, large metadata,
legacy files, malformed entries and rewritten streams. Render fuzz tests use
mixed fonts, colours, opacity, skew and pre-existing edits across repeated exports.

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
