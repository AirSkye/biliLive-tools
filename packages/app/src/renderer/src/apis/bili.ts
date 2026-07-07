import request from "./request";

import type { BiliupConfig, PartTitleFormatOptions } from "@biliLive-tools/types";
import type { BiliApi } from "../../../types";

const validUploadParams = async (data: BiliupConfig) => {
  const res = await request.post("/bili/validUploadParams", data);
  return res.data;
};

const getArchives = async (
  params: Parameters<BiliApi["getArchives"]>[0],
  uid: number,
): Promise<ReturnType<BiliApi["getArchives"]>> => {
  const res = await request.get("/bili/archives", {
    params: { ...params, uid },
  });
  return res.data;
};

const getArchiveDetail = async (
  bvid: string,
  uid?: number,
): Promise<ReturnType<BiliApi["getArchiveDetail"]>> => {
  const res = await request.get(`/bili/user/archive/${bvid}`, {
    params: { uid },
  });
  return res.data;
};

const checkTag = async (tag: string, uid: number) => {
  const res = await request.post("/bili/checkTag", {
    tag,
    uid,
  });
  return res.data;
};

const searchTopic = async (keyword: string, uid: number) => {
  const res = await request.get("/bili/searchTopic", {
    params: { keyword, uid },
  });
  return res.data;
};

const getSeasonList = async (uid: number): Promise<ReturnType<BiliApi["getSeasonList"]>> => {
  const res = await request.get("/bili/seasons", {
    params: { uid },
  });
  return res.data;
};

const getSessionId = async (aid: number, uid: number) => {
  const res = await request.get(`/bili//season/${aid}`, {
    params: { uid },
  });
  return res.data;
};

const getPlatformArchiveDetail = async (aid: number, uid: number) => {
  const res = await request.get("/bili/platformArchiveDetail", {
    params: { aid, uid },
  });
  return res.data;
};

export type LocalUploadedFileMatch = {
  localPath: string;
  fileName: string;
  root: string;
  size: number;
  mtimeMs: number;
  aid: number;
  bvid?: string;
  cid?: number;
  page?: number;
  archiveTitle: string;
  partTitle?: string;
  remoteFilename?: string;
  confidence: "high" | "medium";
  reason: string;
};

export type LocalUploadedFilesResult = {
  historyId?: string;
  detectedAt?: number;
  roots: string[];
  scannedFileCount: number;
  archiveCount: number;
  remotePartCount: number;
  truncated: boolean;
  matches: LocalUploadedFileMatch[];
  unuploadedGroups: LocalUnuploadedGroup[];
  errors: string[];
  warnings: string[];
  logs: string[];
};

export type LocalUploadedFilesHistorySummary = {
  id: string;
  uid: number;
  createdAt: number;
  options: {
    pages: number;
    pageSize: number;
    rootPath?: string;
    useArchiveDetail: boolean;
    detailIntervalMs: number;
  };
  scannedFileCount: number;
  archiveCount: number;
  remotePartCount: number;
  matchCount: number;
  initialMatchCount: number;
  unuploadedGroupCount: number;
  deletedCount: number;
};

export type LocalUploadedFilesHistoryItem = {
  id: string;
  uid: number;
  createdAt: number;
  options: LocalUploadedFilesHistorySummary["options"];
  result: LocalUploadedFilesResult;
  initialMatchCount: number;
  deletedCount: number;
};

export type LocalUploadedFileDeletionRecord = LocalUploadedFileMatch & {
  id: string;
  uid?: number;
  historyId?: string;
  deletedAt: number;
};

export type LocalUploadedFilesDetectionProgress = {
  id: string;
  status: "running" | "completed" | "error";
  stage:
    | "prepare"
    | "scan"
    | "archives"
    | "search"
    | "details"
    | "matching"
    | "grouping"
    | "completed"
    | "error";
  stageLabel: string;
  message: string;
  current?: string;
  processed: number;
  total: number;
  remaining: number;
  percent: number;
  logs: string[];
  result?: LocalUploadedFilesResult;
  error?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type LocalUploadCandidateFile = {
  path: string;
  fileName: string;
  size: number;
  mtimeMs: number;
  title: string;
  startTime?: number;
  endTime?: number;
  danmuPath?: string;
  xmlDanmuPath?: string;
  recordId?: number;
};

export type LocalUnuploadedGroup = {
  id: string;
  groupKey: string;
  roomId?: string;
  platform?: string;
  username?: string;
  title: string;
  startTime: number;
  endTime?: number;
  fileCount: number;
  totalSize: number;
  danmuCount: number;
  files: LocalUploadCandidateFile[];
  suggestedAction: "new" | "append" | "ambiguous";
  suggestedAid?: number;
  archiveTitle?: string;
  mergeCandidate: boolean;
  hasWebhookUploadConfig: boolean;
  warnings: string[];
};

const detectLocalUploadedFiles = async (
  uid: number,
  options: {
    rootPath?: string;
    pages?: number;
    pageSize?: number;
    useArchiveDetail?: boolean;
    detailIntervalMs?: number;
  } = {},
): Promise<LocalUploadedFilesResult> => {
  const res = await request.get("/bili/localUploadedFiles", {
    params: { uid, ...options },
  });
  return res.data;
};

const getLocalUploadedFilesHistory = async (
  uid: number,
): Promise<{
  items: LocalUploadedFilesHistorySummary[];
  latest: LocalUploadedFilesHistorySummary | null;
}> => {
  const res = await request.get("/bili/localUploadedFiles/history", {
    params: { uid },
  });
  return res.data;
};

const getLocalUploadedFilesHistoryItem = async (
  id: string,
  uid?: number,
): Promise<LocalUploadedFilesHistoryItem> => {
  const res = await request.get(`/bili/localUploadedFiles/history/${id}`, {
    params: { uid },
  });
  return res.data;
};

const getLocalUploadedFileDeletions = async (
  uid: number,
  options: {
    historyId?: string;
    limit?: number;
  } = {},
): Promise<{
  items: LocalUploadedFileDeletionRecord[];
}> => {
  const res = await request.get("/bili/localUploadedFiles/deletions", {
    params: { uid, ...options },
  });
  return res.data;
};

const recordLocalUploadedFileDeletions = async (data: {
  uid?: number;
  historyId?: string;
  items: LocalUploadedFileMatch[];
}): Promise<{
  items: LocalUploadedFileDeletionRecord[];
}> => {
  const res = await request.post("/bili/localUploadedFiles/deletions", data);
  return res.data;
};

const startLocalUploadedFilesDetection = async (
  uid: number,
  options: {
    rootPath?: string;
    pages?: number;
    pageSize?: number;
    useArchiveDetail?: boolean;
    detailIntervalMs?: number;
  } = {},
): Promise<LocalUploadedFilesDetectionProgress> => {
  const res = await request.post("/bili/localUploadedFiles/detect", {
    uid,
    ...options,
  });
  return res.data;
};

const getLocalUploadedFilesDetection = async (
  id: string,
): Promise<LocalUploadedFilesDetectionProgress> => {
  const res = await request.get(`/bili/localUploadedFiles/detect/${id}`);
  return res.data;
};

const qrcode = async (): Promise<{
  url: string;
  id: string;
}> => {
  const res = await request.post("/bili/login");
  return res.data;
};

const loginCancel = async (id: string) => {
  const res = await request.post("/bili/login/cancel", {
    id,
  });
  return res.data;
};

const loginPoll = async (
  id: string,
): Promise<{ res: string; status: "scan" | "completed" | "error"; failReason: string }> => {
  const res = await request.get("/bili/login/poll", {
    params: { id },
  });
  return res.data;
};

const upload = async (options: {
  uid: number;
  vid?: number;
  videos:
    | string[]
    | {
        path: string;
        title?: string;
      }[];
  config: BiliupConfig;
  options?: {
    removeOriginAfterUploadCheck: boolean;
  };
}): Promise<{
  taskId: string;
}> => {
  const res = await request.post("/bili/upload", options);
  return res.data;
};

const uploadLocalUnuploaded = async (data: {
  groups: Array<{
    roomId?: string;
    platform?: string;
    username?: string;
    title?: string;
    startTime?: number;
    aid?: number;
    uploadMode?: "auto" | "new" | "append";
    files: LocalUploadCandidateFile[];
  }>;
  options: {
    burnDanmu: boolean;
    uploadRawWhenNoDanmu: boolean;
    mergeSegments: boolean;
  };
}): Promise<{
  status: string;
  items: Array<{
    roomId: string;
    title?: string;
    status: "queued" | "skipped";
    reason?: string;
  }>;
}> => {
  const res = await request.post("/bili/uploadLocalUnuploaded", data);
  return res.data;
};

export const formatWebhookTitle = async (
  template: string,
  options?: {
    title: string;
    username: string;
    time: string;
    roomId: string | number;
    filename: string;
  },
): Promise<string> => {
  const res = await request.post(`/bili/formatTitle`, {
    template,
    options: options || {
      title: "标题",
      username: "主播名",
      time: new Date().toISOString(),
      roomId: 123456,
      filename: "文件名",
    },
  });
  return res.data;
};

export const formatWebhookPartTitle = async (
  template: string,
  options?: PartTitleFormatOptions,
): Promise<string> => {
  const res = await request.post(`/bili/formatPartTitle`, {
    template,
    options: options,
  });
  return res.data;
};

export const formatWebhookDesc = async (
  template: string,
  options?: {
    title: string;
    username: string;
    time: string;
    roomId: string | number;
    filename: string;
  },
): Promise<string> => {
  const res = await request.post(`/bili/formatDesc`, {
    template,
    options: options || {
      title: "标题",
      username: "主播名",
      time: new Date().toISOString(),
      roomId: 123456,
      filename: "文件名",
    },
  });
  return res.data;
};

const bili = {
  validUploadParams,
  getArchives,
  checkTag,
  searchTopic,
  getSeasonList,
  getArchiveDetail,
  getSessionId,
  getPlatformArchiveDetail,
  detectLocalUploadedFiles,
  getLocalUploadedFilesHistory,
  getLocalUploadedFilesHistoryItem,
  getLocalUploadedFileDeletions,
  recordLocalUploadedFileDeletions,
  startLocalUploadedFilesDetection,
  getLocalUploadedFilesDetection,
  qrcode,
  loginCancel,
  loginPoll,
  upload,
  uploadLocalUnuploaded,
  formatWebhookTitle,
  formatWebhookPartTitle,
  formatWebhookDesc,
};

export default bili;
