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
