import type { EditorPage } from "./pdf";
export function reorderPages(
  pages: EditorPage[],
  ids: string[],
  targetId: string,
): EditorPage[] {
  const selected = new Set(ids);
  if (selected.has(targetId) || !pages.some((p) => p.id === targetId))
    return pages;
  const moving = pages.filter((p) => selected.has(p.id)),
    rest = pages.filter((p) => !selected.has(p.id));
  const index = rest.findIndex((p) => p.id === targetId);
  return [...rest.slice(0, index), ...moving, ...rest.slice(index)];
}
export function duplicatePages(
  pages: EditorPage[],
  ids: string[],
  id: () => string,
): EditorPage[] {
  const selected = new Set(ids);
  return pages.flatMap((page) =>
    selected.has(page.id)
      ? [page, { ...structuredClone(page), id: id() }]
      : [page],
  );
}
export function rotatePages(
  pages: EditorPage[],
  ids: string[],
  degrees = 90,
): EditorPage[] {
  return pages.map((page) =>
    ids.includes(page.id)
      ? { ...page, rotation: ((page.rotation ?? 0) + degrees + 360) % 360 }
      : page,
  );
}
export interface Change {
  pageId: string;
  title: string;
  detail: string;
}
export function documentChanges(
  pages: EditorPage[],
  baseline: EditorPage[],
): Change[] {
  const changes: Change[] = [];
  for (const [index, page] of pages.entries()) {
    const originalIndex = baseline.findIndex((p) => p.id === page.id);
    if (originalIndex < 0)
      changes.push({
        pageId: page.id,
        title: `Page ${index + 1}: duplicated`,
        detail: "A new copy of a source page.",
      });
    else if (originalIndex !== index)
      changes.push({
        pageId: page.id,
        title: `Page ${index + 1}: reordered`,
        detail: `Originally page ${originalIndex + 1}.`,
      });
    const summary = [
      page.rotation ? `rotated ${page.rotation}°` : "",
      page.textReplacements?.length
        ? `${page.textReplacements.length} text edits`
        : "",
      page.textOffsets?.length ? `${page.textOffsets.length} moved pieces` : "",
      page.textTransforms?.length
        ? `${page.textTransforms.length} transformed pieces`
        : "",
      page.textCopies?.length ? `${page.textCopies.length} text copies` : "",
      page.crop ? "page cropped" : "",
      page.annotations.length ? `${page.annotations.length} additions` : "",
      JSON.stringify(page.textGroups ?? []) !==
      JSON.stringify(baseline[originalIndex]?.textGroups ?? [])
        ? "text grouping changed"
        : "",
    ].filter(Boolean);
    if (summary.length)
      changes.push({
        pageId: page.id,
        title: `Page ${index + 1}: edited`,
        detail: summary.join(" · "),
      });
  }
  for (const [index, page] of baseline.entries())
    if (!pages.some((p) => p.id === page.id))
      changes.push({
        pageId: page.id,
        title: `Original page ${index + 1}: removed`,
        detail: "This page will not appear in the export.",
      });
  return changes;
}
