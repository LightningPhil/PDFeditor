import type { EditorPage } from "./pdf";
import { documentChanges } from "./page-operations";
export function ReviewPanel({
  pages,
  baseline,
  onJump,
  onClose,
}: {
  pages: EditorPage[];
  baseline: EditorPage[];
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const changes = documentChanges(pages, baseline);
  return (
    <div className="dialog-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Review changes"
        className="workspace-dialog review-dialog"
      >
        <div className="panel-title">
          Review changes
          <button onClick={onClose} aria-label="Close change review">
            ×
          </button>
        </div>
        <p>
          Compare each page with its imported source using Original / Edited.
          Highlight changes marks edited and added text.
        </p>
        <p role="status">
          {changes.length
            ? `${changes.length} change entries`
            : "No changes from the imported document."}
        </p>
        <div className="search-results">
          {changes.map((change, index) => (
            <button
              key={index}
              disabled={!pages.some((p) => p.id === change.pageId)}
              onClick={() => {
                onJump(change.pageId);
                onClose();
              }}
            >
              <strong>{change.title}</strong>
              <span>{change.detail}</span>
            </button>
          ))}
        </div>
        <p className="hint">
          Original means the source PDF you imported into this workspace.
          Changes already present in that file are part of its baseline.
        </p>
      </section>
    </div>
  );
}
