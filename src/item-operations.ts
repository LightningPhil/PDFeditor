import type { Annotation, EditorPage } from "./pdf";
import type { EditableRun } from "./text-edit";
import { getTextBoxes } from "./text-boxes";
import { bounds, identity, multiply } from "./geometry";
import type { Matrix } from "./geometry";
import { PDFDocument, PDFName, PDFHexString } from "pdf-lib";
import { inspectPageText } from "./text-edit";
export async function readDocumentLocks(
  bytes: Uint8Array,
): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    try {
      const raw = page.node.lookup(PDFName.of("PDFeditorLockedText"));
      if (!(raw instanceof PDFHexString) || raw.sizeInBytes() > 8 * 1024 * 1024)
        return [];
      const value = JSON.parse(
        new TextDecoder("utf-16be").decode(raw.asBytes().subarray(2)),
      );
      if (!Array.isArray(value)) return [];
      const available = new Set(inspectPageText(page).map((r) => r.id));
      return [
        ...new Set(
          value.filter(
            (id: unknown) => typeof id === "string" && available.has(id),
          ),
        ),
      ] as string[];
    } catch {
      return [];
    }
  });
}
export function lockItems(
  page: EditorPage,
  runs: EditableRun[],
  ids: string[],
  shapeIds: string[],
  locked: boolean,
): EditorPage {
  const members = getTextBoxes(page, runs)
    .filter((b) => ids.includes(b.id))
    .flatMap((b) => b.runs.map((r) => r.id));
  const set = new Set(page.lockedRunIds ?? []);
  members.forEach((id) => (locked ? set.add(id) : set.delete(id)));
  return {
    ...page,
    lockedRunIds: [...set],
    annotations: page.annotations.map((a) =>
      shapeIds.includes(a.id) || members.includes(`added:${a.id}`)
        ? { ...a, locked }
        : a,
    ),
  };
}
export function rotateText(
  page: EditorPage,
  runs: EditableRun[],
  ids: string[],
  degrees: number,
): EditorPage {
  const boxes = getTextBoxes(page, runs).filter((b) => ids.includes(b.id));
  if (
    !boxes.length ||
    boxes.length !== new Set(ids).size ||
    boxes.some((b) => b.locked || !b.movable) ||
    !Number.isFinite(degrees)
  )
    throw Error("Select unlocked, positioned text and enter a valid angle.");
  const a = bounds(boxes.flatMap((b) => b.points)),
    x = a.x + a.width / 2,
    y = a.y + a.height / 2,
    r = ((degrees % 360) * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const rotation: Matrix = [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
  const transforms = new Map(
    (page.textTransforms ?? []).map((t) => [t.runId, t]),
  );
  const offsets = new Map((page.textOffsets ?? []).map((t) => [t.runId, t]));
  const members = new Set(boxes.flatMap((b) => b.runs.map((r) => r.id)));
  for (const box of boxes)
    for (const run of box.runs) {
      if (run.id.startsWith("added:")) continue;
      const offset = offsets.get(run.id),
        old = transforms.get(run.id);
      transforms.set(run.id, {
        runId: run.id,
        original: run.text,
        matrix: multiply(
          rotation,
          multiply(
            [1, 0, 0, 1, offset?.dx ?? 0, offset?.dy ?? 0],
            old?.matrix ?? identity(),
          ),
        ),
      });
      offsets.delete(run.id);
    }
  return {
    ...page,
    textTransforms: [...transforms.values()],
    textOffsets: [...offsets.values()],
    paragraphs: page.paragraphs?.filter((p) => !ids.includes(p.groupId)),
    annotations: page.annotations.map((a) => {
      if (a.kind !== "text" || !members.has(`added:${a.id}`)) return a;
      return {
        ...a,
        x: x + c * (a.x - x) - s * (a.y - y),
        y: y + s * (a.x - x) + c * (a.y - y),
        rotation: ((a.rotation ?? 0) + (degrees % 360)) % 360,
      };
    }),
  };
}
export function duplicateItems(
  page: EditorPage,
  runs: EditableRun[],
  ids: string[],
  shapeIds: string[],
  uid: () => string,
) {
  const boxes = getTextBoxes(page, runs).filter((b) => ids.includes(b.id));
  if (boxes.some((b) => !b.movable))
    throw Error("This text cannot be copied safely.");
  const annotations = [...page.annotations],
    copies = [...(page.textCopies ?? [])],
    transforms = [...(page.textTransforms ?? [])],
    groups = [...(page.textGroups ?? [])],
    paragraphs = [...(page.paragraphs ?? [])],
    newRunIds: string[] = [],
    newShapeIds: string[] = [];
  const replacements = new Map(
      (page.textReplacements ?? []).map((e) => [e.runId, e.replacement]),
    ),
    placements = new Map(
      (page.textTransforms ?? []).map((e) => [e.runId, e.matrix]),
    ),
    offsets = new Map((page.textOffsets ?? []).map((e) => [e.runId, e]));
  for (const box of boxes) {
    const members: string[] = [];
    for (const run of box.runs) {
      const text = replacements.get(run.id) ?? run.text;
      if (!text.trim()) continue;
      if (run.id.startsWith("added:")) {
        const original = page.annotations.find(
          (a) => `added:${a.id}` === run.id,
        )!;
        const id = uid();
        annotations.push({
          ...structuredClone(original),
          id,
          x: original.x + 12,
          y: original.y - 12,
          locked: false,
          role: undefined,
        });
        members.push(`added:${id}`);
      } else {
        const prior = page.textCopies?.find((c) => `copy:${c.id}` === run.id),
          id = uid(),
          alias = `copy:${id}`;
        copies.push({
          id,
          sourceRunId: prior?.sourceRunId ?? run.id,
          sourceOriginal: prior?.sourceOriginal ?? run.text,
          text,
        });
        const offset = offsets.get(run.id);
        transforms.push({
          runId: alias,
          original: text,
          matrix: multiply(
            [1, 0, 0, 1, 12 + (offset?.dx ?? 0), -12 + (offset?.dy ?? 0)],
            placements.get(run.id) ?? identity(),
          ),
        });
        members.push(alias);
      }
    }
    newRunIds.push(...members);
    if (box.joined && members.length) {
      const id = `joined:${uid()}`;
      groups.push({ id, runIds: members });
      const paragraph = page.paragraphs?.find((p) => p.groupId === box.id);
      if (paragraph)
        paragraphs.push({
          ...structuredClone(paragraph),
          groupId: id,
          x: paragraph.x + 12,
          y: paragraph.y - 12,
        });
    }
  }
  for (const shape of page.annotations.filter(
    (a) => shapeIds.includes(a.id) && a.kind === "rectangle",
  )) {
    const id = uid();
    annotations.push({
      ...structuredClone(shape),
      id,
      x: shape.x + 12,
      y: shape.y - 12,
      locked: false,
    });
    newShapeIds.push(id);
  }
  return {
    page: {
      ...page,
      annotations,
      textCopies: copies,
      textTransforms: transforms,
      textGroups: groups,
      paragraphs,
    },
    runIds: newRunIds,
    shapeIds: newShapeIds,
  };
}
export function updateShape(
  page: EditorPage,
  id: string,
  patch: Partial<Annotation>,
): EditorPage {
  const shape = page.annotations.find(
    (a) => a.id === id && a.kind === "rectangle",
  );
  if (!shape || shape.kind !== "rectangle") throw Error("Select a rectangle.");
  if (shape.locked) throw Error("Unlock this rectangle first.");
  const next = { ...shape, ...patch, id: shape.id, kind: "rectangle" as const };
  if (
    ![next.x, next.y, next.width, next.height, next.borderWidth ?? 2].every(
      Number.isFinite,
    ) ||
    next.width < 1 ||
    next.height < 1 ||
    (next.borderWidth ?? 2) < 0 ||
    (next.borderWidth ?? 2) > 100 ||
    !/^#[\da-f]{6}$/i.test(next.color) ||
    (next.fill && !/^#[\da-f]{6}$/i.test(next.fill))
  )
    throw Error("Check rectangle dimensions, colours and border width.");
  return {
    ...page,
    annotations: page.annotations.map((a) => (a.id === id ? next : a)),
  };
}
export function reorderItems(
  page: EditorPage,
  runIds: string[],
  shapeIds: string[],
  front: boolean,
  oneStep = false,
): EditorPage {
  const chosen = new Set([
    ...shapeIds,
    ...runIds.filter((id) => id.startsWith("added:")).map((id) => id.slice(6)),
  ]);
  const items = page.annotations.filter((a) => chosen.has(a.id));
  if (items.some((a) => a.locked))
    throw Error("Unlock these items before changing their order.");
  const rest = page.annotations.filter((a) => !chosen.has(a.id));
  if (oneStep) {
    const ordered = [...page.annotations];
    if (front) {
      for (let i = ordered.length - 2; i >= 0; i--)
        if (chosen.has(ordered[i].id) && !chosen.has(ordered[i + 1].id))
          [ordered[i], ordered[i + 1]] = [ordered[i + 1], ordered[i]];
    } else {
      for (let i = 1; i < ordered.length; i++)
        if (chosen.has(ordered[i].id) && !chosen.has(ordered[i - 1].id))
          [ordered[i], ordered[i - 1]] = [ordered[i - 1], ordered[i]];
    }
    return { ...page, annotations: ordered };
  }
  return {
    ...page,
    annotations: front ? [...rest, ...items] : [...items, ...rest],
  };
}
