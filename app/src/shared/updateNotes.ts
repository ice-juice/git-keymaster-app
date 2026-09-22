/** 应用内展示用：去掉发给 GitHub Release 的「下载建议」，清单原文不改。 */
const DOWNLOAD_GUIDE_TITLES = new Set([
  "下载建议",
  "download suggestions",
  "download advice",
]);

function isDownloadGuideHeading(title: string): boolean {
  return DOWNLOAD_GUIDE_TITLES.has(title.trim().toLowerCase());
}

export function appUpdateNotes(notes: string | null | undefined): string {
  if (!notes) return "";
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.match(/^#{2,3}[ \t]+(.+?)\s*$/);
    if (heading) {
      skipping = isDownloadGuideHeading(heading[1]);
      if (skipping) continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}
