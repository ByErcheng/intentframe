/** 识别正文中的 ATX 标题，忽略围栏代码中的同形文本。 */
export function markdownHeadings(document: string) {
  const lines = document.split("\n"), headings: { index: number; level: number; title: string }[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length) fence = undefined; continue; }
    const match = !fence && line.match(/^(#{1,6})\s+(.+)$/);
    if (match) headings.push({ index, level: match[1]!.length, title: match[2]!.trim() });
  }
  return headings;
}

export function markdownSection(document: string, title: string): string {
  const lines = document.split("\n"), headings = markdownHeadings(document);
  const selected = headings.filter(value => value.title === title);
  if (selected.length !== 1) throw new Error("章节标题缺失或重复：" + title);
  const start = selected[0]!;
  const end = headings.find(value => value.index > start.index && value.level <= start.level)?.index ?? lines.length;
  return lines.slice(start.index, end).join("\n").trim();
}
