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
  mergeAcrossGroups?: boolean;
  mergeFilePaths: string[];
  requireMergedDanmu: boolean;
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

const sortLocalFiles = <T extends { path: string; startTime?: number; mtimeMs?: number }>(
  files: T[],
) =>
  [...files].sort((left, right) => {
    const leftTime = left.startTime ?? left.mtimeMs ?? 0;
    const rightTime = right.startTime ?? right.mtimeMs ?? 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return normalizePath(left.path).localeCompare(normalizePath(right.path));
  });

const dedupeLocalFiles = <T extends { path: string }>(files: T[]) => {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = normalizePath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const buildLocalActionGroups = (options: {
  groups: PendingLocalActionGroup[];
  selectedFilePaths: string[];
  mode: LocalProcessMode;
  deleteSourceAfterSync: boolean;
  mergeAcrossGroups?: boolean;
}): PreparedLocalActionGroup[] => {
  const selectedPaths = new Set(options.selectedFilePaths.map(normalizePath));
  const wantsBurn = options.mode === "burn" || options.mode === "burnMerge";
  const wantsMerge = options.mode === "merge" || options.mode === "burnMerge";
  const selectedGroups = options.groups
    .map((item) => ({
      item,
      files: sortLocalFiles(
        item.row.files.filter((file) => selectedPaths.has(normalizePath(file.path))),
      ),
    }))
    .filter((group) => group.files.length > 0);

  if (options.mergeAcrossGroups && wantsMerge && selectedGroups.length > 1) {
    const roomIds = new Set(selectedGroups.map(({ item }) => item.row.roomId).filter(Boolean));
    if (roomIds.size !== 1 || selectedGroups.some(({ item }) => !item.row.roomId)) {
      throw new Error("跨分组合并要求所选分组属于同一个房间");
    }

    const files = sortLocalFiles(dedupeLocalFiles(selectedGroups.flatMap(({ files }) => files)));
    if (files.length < 2) {
      throw new Error("跨分组合并至少需要选择两个视频");
    }
    if (!files.every((file) => isFlv(file.path))) {
      throw new Error("跨分组合并目前只支持全部为 FLV 的原始视频");
    }
    const first = [...selectedGroups].sort(
      (left, right) =>
        (left.files[0].startTime ?? left.files[0].mtimeMs ?? 0) -
        (right.files[0].startTime ?? right.files[0].mtimeMs ?? 0),
    )[0];
    const mergeFilePaths = files.map((file) => file.path);
    return [
      {
        uploadKey: first.item.row.uploadKey,
        syncKey: first.item.row.syncKey,
        roomId: first.item.row.roomId,
        platform: first.item.row.platform,
        username: first.item.row.username,
        title: first.item.row.title,
        startTime: files[0].startTime ?? files[0].mtimeMs,
        uploadMode: "new",
        burnDanmu: wantsBurn,
        burnFilePaths: wantsBurn ? mergeFilePaths : [],
        uploadRawWhenNoDanmu: first.item.uploadRawWhenNoDanmu,
        mergeSegments: true,
        mergeAcrossGroups: true,
        mergeFilePaths,
        requireMergedDanmu: options.mode === "burnMerge",
        deleteSourceAfterSync: options.deleteSourceAfterSync,
        files,
      },
    ];
  }

  return selectedGroups.map(({ item, files }) => {
    const row = item.row;
    const mergeFilePaths = wantsMerge
      ? files.filter((file) => isFlv(file.path)).map((file) => file.path)
      : [];
    return {
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
      requireMergedDanmu: false,
      deleteSourceAfterSync: options.deleteSourceAfterSync,
      files,
    };
  });
};

export const removeInvalidLocalActionFiles = (
  groups: PreparedLocalActionGroup[],
  invalidFilePaths: string[],
): PreparedLocalActionGroup[] => {
  const invalidPaths = new Set(invalidFilePaths.map(normalizePath));
  return groups.flatMap((group) => {
    const files = group.files.filter((file) => !invalidPaths.has(normalizePath(file.path)));
    if (files.length === 0) return [];

    const mergeFilePaths = group.mergeFilePaths.filter(
      (filePath) => !invalidPaths.has(normalizePath(filePath)),
    );
    const burnFilePaths = group.burnFilePaths.filter(
      (filePath) => !invalidPaths.has(normalizePath(filePath)),
    );
    const mergeSegments = mergeFilePaths.length > 1;
    return [
      {
        ...group,
        files,
        startTime: files[0].startTime ?? files[0].mtimeMs ?? group.startTime,
        burnFilePaths,
        mergeSegments,
        mergeAcrossGroups: mergeSegments ? group.mergeAcrossGroups : false,
        mergeFilePaths: mergeSegments ? mergeFilePaths : [],
        requireMergedDanmu: mergeSegments ? group.requireMergedDanmu : false,
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

export const removeLocalUnuploadedFiles = (
  groups: LocalUnuploadedGroup[],
  deletedFilePaths: string[],
) => {
  const deletedPaths = new Set(deletedFilePaths.map(normalizePath));
  return groups.flatMap((row) => {
    const files = row.files.filter((file) => !deletedPaths.has(normalizePath(file.path)));
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
        syncStatus: undefined,
        syncQueuedAt: undefined,
        syncUpdatedAt: undefined,
        syncError: undefined,
      },
    ];
  });
};
