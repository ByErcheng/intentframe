type ImageBatch = { ranges: readonly unknown[]; sheets: readonly { location: string }[] };

function evenly<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[Math.floor(items.length / 2)]!];
  return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / (count - 1))]!);
}

/** 补帧复查先覆盖最近的定向材料，并留出全片概览；未附图仍由原索引提供。 */
export function selectReviewImages(batches: readonly ImageBatch[], limit = 12) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("附图上限须为正整数。");
  const all = [...new Set(batches.flatMap(batch => batch.sheets.map(sheet => sheet.location)))];
  if (all.length <= limit) return all;
  const overview = [...new Set(batches.filter(batch => !batch.ranges.length).flatMap(batch => batch.sheets.map(sheet => sheet.location)))];
  const targeted = batches.filter(batch => batch.ranges.length).toReversed();
  if (!targeted.length) return evenly(all, limit);
  const selected = new Set(evenly(overview, Math.min(3, Math.floor(limit / 3))));
  for (const batch of targeted) {
    const available = batch.sheets.map(sheet => sheet.location).filter(path => !selected.has(path));
    for (const path of evenly(available, limit - selected.size)) selected.add(path);
  }
  for (const path of evenly(all.filter(path => !selected.has(path)), limit - selected.size)) selected.add(path);
  // 输出沿原材料顺序，避免把优先级当作视频播放时序。
  return all.filter(path => selected.has(path));
}
