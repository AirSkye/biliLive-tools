import type { LocalUnuploadedGroup } from "@renderer/apis/bili";

export type LocalProcessMode = "direct" | "merge" | "burn" | "burnMerge";

export type PendingLocalActionGroup = {
  row: LocalUnuploadedGroup;
  uploadRawWhenNoDanmu: boolean;
};

export type PreparedLocalActionGroup = {
  uploadKey: string;
  syncKey?: string;
  roomId?: string;
  platform?: string;
  username?: string;
  title: string;
  startTime: number;
  aid?: number;
  uploadMode: "new" | "append";
  burnDanmu: boolean;
  burnFilePaths: string[];
  uploadRawWhenNoDanmu: boolean;
  mergeSegments: boolean;
  mergeFilePaths: string[];
  deleteSourceAfterSync: boolean;
  files: LocalUnuploadedGroup["files"];
};

type LocalUploadCompletion = {
  key: string;
  operation?: "upload" | "sync";
  status: "missing" | "queued" | "running" | "completed" | "error";
  filePaths?: string[];
};

const normalizePath = (filePath: string) => filePath.replace(/\\/g, "/").toLowerCase();
const isFlv = (filePath: string) => filePath.toLowerCase().endsWith(".flv");

export const buildLocalActionGroups = (options: {
  groups: PendingLocalActionGroup[];
  selectedFilePaths: string[];
  mode: LocalProcessMode;
  deleteSourceAfterSync: boolean;
}): PreparedLocalActionGroup[] => {
  const selectedPaths = new Set(options.selectedFilePaths.map(normalizePath));
  const wantsBurn = options.mode === "burn" || options.mode === "burnMerge";
  const wantsMerge = options.mode === "merge" || options.mode === "burnMerge";

  return options.groups.flatMap((item) => {
    const row = item.row;
    const files = row.files.filter((file) => selectedPaths.has(normalizePath(file.path)));
    if (files.length === 0) return [];

    const mergeFilePaths = wantsMerge
      ? files.filter((file) => isFlv(file.path)).map((file) => file.path)
      : [];
    return [
      {
        uploadKey: row.uploadKey,
        syncKey: row.syncKey,
        roomId: row.roomId,
        platform: row.platform,
        username: row.username,
        title: row.title,
        startTime: files[0].startTime ?? files[0].mtimeMs,
        aid: row.suggestedAction === "append" ? row.suggestedAid : undefined,
        uploadMode: row.suggestedAction === "append" ? "append" : "new",
        burnDanmu: wantsBurn,
        burnFilePaths: wantsBurn ? files.map((file) => file.path) : [],
        uploadRawWhenNoDanmu: item.uploadRawWhenNoDanmu,
        mergeSegments: mergeFilePaths.length > 1,
        mergeFilePaths,
        deleteSourceAfterSync: options.deleteSourceAfterSync,
        files,
      },
    ];
  });
};

export const removeCompletedLocalUploadFiles = (
  groups: LocalUnuploadedGroup[],
  items: LocalUploadCompletion[],
) => {
  const completedItems = items.filter(
    (item) => item.status === "completed" && item.operation !== "sync",
  );
  const completedPaths = new Set(
    completedItems.flatMap((item) => item.filePaths ?? []).map(normalizePath),
  );
  const completedLegacyKeys = new Set(
    completedItems.filter((item) => !item.filePaths?.length).map((item) => item.key),
  );

  return groups.flatMap((row) => {
    if (completedLegacyKeys.has(row.uploadKey)) return [];
    const files = row.files.filter((file) => !completedPaths.has(normalizePath(file.path)));
    if (files.length === 0) return [];
    if (files.length === row.files.length) return [row];

    return [
      {
        ...row,
        files,
        fileCount: files.length,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        danmuCount: files.filter((file) => file.danmuPath || file.xmlDanmuPath).length,
        mergeCandidate: files.length > 1 && files.every((file) => isFlv(file.path)),
        startTime: files[0].startTime ?? files[0].mtimeMs,
        endTime: files[files.length - 1].endTime,
        uploadStatus: undefined,
        uploadQueuedAt: undefined,
        uploadUpdatedAt: undefined,
        uploadError: undefined,
      },
    ];
  });
};
