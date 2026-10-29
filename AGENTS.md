# Working on PDFeditor

Use this checkout directly. The user wants one human and one robot working on
this project: do not spawn agents, delegate work, or create worktrees unless
explicitly asked.

Use TypeScript. Keep document processing local by default. Never commit local
sample PDFs or notes. Existing-text editing is a core requirement; do not label
an overlay or white rectangle as genuine text editing or secure redaction.

Run `npm test` and `npm run build` for changes to document handling.
