export type ArchiveSearchKeywordType = "title" | "streamer";

export type ArchiveSearchKeywordLike = {
  normalized: string;
  type: ArchiveSearchKeywordType;
};

export const shouldUseSearchOnlyRemoteArchives = (selectedStreamerCount: number) =>
  selectedStreamerCount > 0;

const normalizeSearchText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/i, "")
    .replace(/\s+/g, "")
    .replace(/[\[\]【】()（）{}<>《》「」『』._-]/g, "");

export const archiveTitleMatchesSearchKeyword = (
  archiveTitle: unknown,
  keyword: ArchiveSearchKeywordLike,
) => {
  if (keyword.type !== "title") return true;

  const normalizedTitle = normalizeSearchText(archiveTitle);
  const normalizedKeyword = normalizeSearchText(keyword.normalized);
  if (!normalizedTitle || !normalizedKeyword) return false;

  return (
    normalizedTitle === normalizedKeyword ||
    normalizedTitle.includes(normalizedKeyword) ||
    normalizedKeyword.includes(normalizedTitle)
  );
};
