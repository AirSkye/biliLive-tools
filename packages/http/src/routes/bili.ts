import Router from "@koa/router";
import fs from "fs-extra";
import { omit } from "lodash-es";
import crypto from "node:crypto";
import path from "node:path";

import { biliApi, validateBiliupConfig } from "@biliLive-tools/shared/task/bili.js";
import { parseMeta, readVideoMeta } from "@biliLive-tools/shared/task/video.js";
import { recordHistoryService, streamerService } from "@biliLive-tools/shared/db/index.js";
import { TvQrcodeLogin } from "@renmu/bili-api";
import {
  formatTitle,
  formatPartTitle,
  formatDesc,
  uuid,
  replaceExtName,
} from "@biliLive-tools/shared/utils/index.js";
import type { BiliupConfig, PartTitleFormatOptions } from "@biliLive-tools/types";
import { appConfig, config as globalConfig, handler } from "../index.js";
import type { LocalUploadOptions } from "../services/webhook/webhook.js";
import type { LiveHistory } from "@biliLive-tools/shared/db/model/recordHistory.js";
import type { Streamer } from "@biliLive-tools/shared/db/model/streamer.js";

const router = new Router({
  prefix: "/bili",
});

const VIDEO_EXTENSIONS = new Set([".mp4", ".flv", ".ts", ".mkv", ".webm", ".m4v", ".mov"]);
const MAX_SCAN_FILES = 20000;
const DEFAULT_WEBHOOK_ROOM_ID = "__global__";
const DETAIL_FAILURE_LIMIT = 5;
const DEFAULT_ARCHIVE_PAGES = 3;
const DEFAULT_DETAIL_INTERVAL_MS = 1500;
const ARCHIVE_SEARCH_CONCURRENCY = 2;
const SEARCH_PRIVATE_DETAIL_LIMIT = 30;

type LocalVideoFile = {
  localPath: string;
  fileName: string;
  stem: string;
  root: string;
  size: number;
  mtimeMs: number;
  normalizedBase: string;
  normalizedStem: string;
};

type RemoteVideoPart = {
  aid: number;
  bvid?: string;
  cid?: number;
  page?: number;
  archiveTitle: string;
  partTitle?: string;
  remoteFilename?: string;
  values: { label: string; raw?: string; normalized: string }[];
  sources: string[];
  searchKeywords: ArchiveSearchKeyword[];
};

type LocalUploadedFileMatch = {
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

type LocalInvalidMp4File = {
  localPath: string;
  fileName: string;
  root: string;
  size: number;
  mtimeMs: number;
  reason: string;
};

type LocalDuplicateVideoFile = LocalInvalidMp4File & {
  recordingKey: string;
  primaryLocalPath: string;
  primaryFileName: string;
};

type RecordWithStreamer = LiveHistory & {
  streamer?: Streamer | null;
};

type LocalUploadCandidateFile = {
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

type LocalUnuploadedGroup = {
  id: string;
  groupKey: string;
  uploadKey: string;
  uploadStatus?: LocalUploadQueueStatus;
  uploadQueuedAt?: number;
  uploadUpdatedAt?: number;
  uploadError?: string;
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

type LocalUploadStreamerOption = {
  key: string;
  roomId: string;
  platform: string;
  name: string;
  hasWebhookUploadConfig: boolean;
  localSizeBytes: number;
  localFolderCount: number;
};

type SelectedLocalStreamer = {
  roomId: string;
  platform?: string;
};

type RemoteArchiveItem = {
  aid: number;
  item: any;
  sources: string[];
  searchKeywords: ArchiveSearchKeyword[];
};

type ArchiveSearchKeyword = {
  keyword: string;
  normalized: string;
  type: "title" | "streamer";
};

type LocalFileContext = {
  localFile: LocalVideoFile;
  record?: RecordWithStreamer | null;
  match?: LocalUploadedFileMatch;
  groupKey: string;
  roomId?: string;
  platform?: string;
  username?: string;
  title: string;
  startTime: number;
  endTime?: number;
  danmuPath?: string;
  xmlDanmuPath?: string;
};

type ParsedLocalMetadata = {
  roomId?: string;
  platform?: string;
  username?: string;
  title?: string;
  startTime?: number;
};

type ParsedRecorderIdentity = {
  roomId?: string;
  date: string;
  time: string;
  sequence?: string;
  title: string;
  startTime?: number;
};

type LocalMatchHint = {
  title?: string;
  username?: string;
  dateKey?: string;
  normalizedTitle: string;
  normalizedTitleAliases: string[];
  normalizedUsername: string;
};

type LocalFileMatchResult = {
  confidence: "high" | "medium";
  reason: string;
  score: number;
};

type LocalUploadedFilesResult = {
  historyId?: string;
  detectedAt?: number;
  roots: string[];
  scannedFileCount: number;
  skippedSmallUnuploadedGroupCount?: number;
  archiveCount: number;
  remotePartCount: number;
  truncated: boolean;
  matches: LocalUploadedFileMatch[];
  invalidMp4Files?: LocalInvalidMp4File[];
  duplicateFiles?: LocalDuplicateVideoFile[];
  unuploadedGroups: LocalUnuploadedGroup[];
  errors: string[];
  warnings: string[];
  logs: string[];
};

type LocalDetectStatus = "running" | "completed" | "error";

type LocalDetectStage =
  | "prepare"
  | "scan"
  | "validate"
  | "archives"
  | "search"
  | "details"
  | "matching"
  | "grouping"
  | "completed"
  | "error";

type LocalDetectProgress = {
  id: string;
  status: LocalDetectStatus;
  stage: LocalDetectStage;
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

type LocalDetectProgressPatch = Partial<
  Pick<LocalDetectProgress, "stage" | "stageLabel" | "message" | "current" | "processed" | "total">
> & {
  log?: string;
};

type LocalDetectProgressReporter = (patch: LocalDetectProgressPatch) => void;

const MAX_LOCAL_DETECT_LOGS = 1200;
const LOCAL_DETECT_JOB_TTL_MS = 1000 * 60 * 30;
const localDetectJobs = new Map<string, LocalDetectProgress>();
const LOCAL_DETECT_HISTORY_FILE = "localUploadedFilesHistory.json";
const LOCAL_DETECT_HISTORY_LIMIT = 30;
const LOCAL_DETECT_DELETION_LIMIT = 3000;

type LocalDetectOptions = {
  pages: number;
  pageSize: number;
  rootPath?: string;
  useArchiveDetail: boolean;
  detailIntervalMs: number;
  minVideoSizeMb: number;
  selectedStreamers?: SelectedLocalStreamer[];
};

type LocalDetectHistoryItem = {
  id: string;
  uid: number;
  createdAt: number;
  options: LocalDetectOptions;
  result: LocalUploadedFilesResult;
  initialMatchCount: number;
  deletedCount: number;
};

type LocalDetectHistorySummary = {
  id: string;
  uid: number;
  createdAt: number;
  options: LocalDetectOptions;
  scannedFileCount: number;
  archiveCount: number;
  remotePartCount: number;
  matchCount: number;
  initialMatchCount: number;
  invalidMp4Count: number;
  duplicateFileCount: number;
  unuploadedGroupCount: number;
  deletedCount: number;
};

type LocalDetectedDeletionItem = Partial<
  Pick<
    LocalUploadedFileMatch,
    "aid" | "bvid" | "cid" | "page" | "archiveTitle" | "partTitle" | "remoteFilename" | "confidence"
  >
> &
  Pick<LocalUploadedFileMatch, "localPath" | "fileName" | "root" | "size" | "mtimeMs" | "reason">;

type LocalUploadedFileDeletionRecord = LocalDetectedDeletionItem & {
  id: string;
  uid?: number;
  historyId?: string;
  deletedAt: number;
};

type LocalUploadQueueStatus = "queued" | "running" | "completed" | "error";

type LocalDetectHistoryStore = {
  version: 1;
  histories: LocalDetectHistoryItem[];
  deletions: LocalUploadedFileDeletionRecord[];
  localUploads: LocalUploadQueueItem[];
};

type LocalUploadQueueItem = {
  key: string;
  roomId?: string;
  platform?: string;
  title?: string;
  filePaths: string[];
  status: LocalUploadQueueStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
};

const LOCAL_UPLOAD_QUEUE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const localUploadQueueItems = new Map<string, LocalUploadQueueItem>();

const getQueryValue = (value: unknown) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const queryNumber = (value: unknown, fallback: number) => {
  const parsed = Number(getQueryValue(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const queryBoundedNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = queryNumber(value, fallback);
  return Math.min(Math.max(parsed, min), max);
};

const queryBoundedNonNegativeNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Number(getQueryValue(value));
  const result = Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  return Math.min(Math.max(result, min), max);
};

const queryString = (value: unknown) => {
  const data = getQueryValue(value);
  return typeof data === "string" && data.trim() ? data.trim() : undefined;
};

const queryBoolean = (value: unknown, fallback = false) => {
  const data = getQueryValue(value);
  if (typeof data === "boolean") return data;
  if (typeof data !== "string") return fallback;
  return ["1", "true", "yes"].includes(data.trim().toLowerCase());
};

const querySelectedStreamers = (value: unknown): SelectedLocalStreamer[] => {
  const data = Array.isArray(value) ? value : getQueryValue(value);
  if (!data) return [];
  let list: unknown = data;
  if (typeof data === "string") {
    const text = data.trim();
    if (!text) return [];
    try {
      list = JSON.parse(text);
    } catch {
      list = text.split(",").map((item) => {
        const [platform, roomId] = item.includes(":") ? item.split(":") : ["bilibili", item];
        return { platform, roomId };
      });
    }
  }
  if (!Array.isArray(list)) return [];
  const items: SelectedLocalStreamer[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const [platform, roomId] = item.includes(":") ? item.split(":") : ["bilibili", item];
      if (roomId) items.push({ platform, roomId });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as { roomId?: unknown; room_id?: unknown; platform?: unknown };
    const roomId = String(record.roomId ?? record.room_id ?? "").trim();
    if (!roomId) continue;
    const selected: SelectedLocalStreamer = { roomId };
    if (typeof record.platform === "string") selected.platform = record.platform;
    items.push(selected);
  }
  return items;
};

const clampProgressNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const touchLocalDetectProgress = (
  progress: LocalDetectProgress,
  patch: LocalDetectProgressPatch,
) => {
  if (patch.stage) progress.stage = patch.stage;
  if (patch.stageLabel !== undefined) progress.stageLabel = patch.stageLabel;
  if (patch.message !== undefined) progress.message = patch.message;
  if (patch.current !== undefined) progress.current = patch.current;
  if (patch.total !== undefined) progress.total = clampProgressNumber(patch.total, progress.total);
  if (patch.processed !== undefined) {
    progress.processed = clampProgressNumber(patch.processed, progress.processed);
  }
  if (patch.log) {
    progress.logs.push(patch.log);
    if (progress.logs.length > MAX_LOCAL_DETECT_LOGS) {
      progress.logs.splice(0, progress.logs.length - MAX_LOCAL_DETECT_LOGS);
    }
  }

  progress.processed = Math.min(progress.processed, progress.total || progress.processed);
  progress.remaining = progress.total > 0 ? Math.max(progress.total - progress.processed, 0) : 0;
  progress.percent =
    progress.total > 0 ? Math.min(100, Math.floor((progress.processed / progress.total) * 100)) : 0;
  progress.updatedAt = Date.now();
};

const createLocalDetectProgress = (): LocalDetectProgress => {
  const now = Date.now();
  return {
    id: uuid(),
    status: "running",
    stage: "prepare",
    stageLabel: "准备检测",
    message: "等待开始检测",
    processed: 0,
    total: 0,
    remaining: 0,
    percent: 0,
    logs: [],
    startedAt: now,
    updatedAt: now,
  };
};

const cleanupLocalDetectJobs = () => {
  const now = Date.now();
  for (const [id, job] of localDetectJobs) {
    const finishedAt = job.completedAt ?? job.updatedAt;
    if (job.status !== "running" && now - finishedAt > LOCAL_DETECT_JOB_TTL_MS) {
      localDetectJobs.delete(id);
    }
  }
};

const formatProgressCount = (processed: number, total: number) => {
  return total > 0
    ? `${processed}/${total}，剩余 ${Math.max(total - processed, 0)}`
    : `${processed}`;
};

const getLocalDetectHistoryFile = () => {
  const basePath =
    globalConfig?.userDataPath ||
    (appConfig?.filepath ? path.dirname(appConfig.filepath) : process.cwd());
  return path.join(basePath, LOCAL_DETECT_HISTORY_FILE);
};

const createEmptyLocalDetectHistoryStore = (): LocalDetectHistoryStore => ({
  version: 1,
  histories: [],
  deletions: [],
  localUploads: [],
});

const normalizeLocalDetectHistoryResult = (
  result: Partial<LocalUploadedFilesResult> | undefined,
): LocalUploadedFilesResult => ({
  historyId: result?.historyId,
  detectedAt: result?.detectedAt,
  roots: Array.isArray(result?.roots) ? result.roots : [],
  scannedFileCount: Number(result?.scannedFileCount ?? 0),
  skippedSmallUnuploadedGroupCount: Number(result?.skippedSmallUnuploadedGroupCount ?? 0),
  archiveCount: Number(result?.archiveCount ?? 0),
  remotePartCount: Number(result?.remotePartCount ?? 0),
  truncated: !!result?.truncated,
  matches: Array.isArray(result?.matches) ? result.matches : [],
  invalidMp4Files: Array.isArray(result?.invalidMp4Files) ? result.invalidMp4Files : [],
  duplicateFiles: Array.isArray(result?.duplicateFiles) ? result.duplicateFiles : [],
  unuploadedGroups: Array.isArray(result?.unuploadedGroups) ? result.unuploadedGroups : [],
  errors: Array.isArray(result?.errors) ? result.errors : [],
  warnings: Array.isArray(result?.warnings) ? result.warnings : [],
  logs: Array.isArray(result?.logs) ? result.logs : [],
});

const normalizeLocalDetectHistoryItem = (
  item: Partial<LocalDetectHistoryItem>,
): LocalDetectHistoryItem => {
  const result = normalizeLocalDetectHistoryResult(item.result);
  return {
    id: item.id || uuid(),
    uid: Number(item.uid ?? 0),
    createdAt: Number(item.createdAt ?? result.detectedAt ?? Date.now()),
    options: (item.options ?? {}) as LocalDetectOptions,
    result,
    initialMatchCount: Number(item.initialMatchCount ?? result.matches.length),
    deletedCount: Number(item.deletedCount ?? 0),
  };
};

const readLocalDetectHistoryStore = async (): Promise<LocalDetectHistoryStore> => {
  const filePath = getLocalDetectHistoryFile();
  if (!(await fs.pathExists(filePath))) {
    return createEmptyLocalDetectHistoryStore();
  }
  try {
    const data = (await fs.readJson(filePath)) as Partial<LocalDetectHistoryStore>;
    return {
      version: 1,
      histories: Array.isArray(data.histories)
        ? data.histories.map((item) => normalizeLocalDetectHistoryItem(item))
        : [],
      deletions: Array.isArray(data.deletions) ? data.deletions : [],
      localUploads: Array.isArray(data.localUploads) ? data.localUploads : [],
    };
  } catch (error) {
    console.error(`read local detect history failed: ${filePath}`, error);
    throw new Error(`读取本地检测历史失败：${filePath}`);
  }
};

const writeLocalDetectHistoryStore = async (store: LocalDetectHistoryStore) => {
  const filePath = getLocalDetectHistoryFile();
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(
    filePath,
    {
      version: 1,
      histories: store.histories.slice(0, LOCAL_DETECT_HISTORY_LIMIT),
      deletions: store.deletions.slice(0, LOCAL_DETECT_DELETION_LIMIT),
      localUploads: store.localUploads
        .filter((item) => Date.now() - item.updatedAt <= LOCAL_UPLOAD_QUEUE_TTL_MS)
        .slice(0, 3000),
    },
    { spaces: 2 },
  );
};

const normalizeLocalUploadFilePath = (filePath: string) => normalizeLocalPath(filePath);

const buildLocalUploadKey = (files: Array<{ path: string }>) => {
  const filePaths = Array.from(
    new Set(files.map((file) => normalizeLocalUploadFilePath(file.path)).filter(Boolean)),
  ).sort();
  const key = crypto.createHash("sha1").update(filePaths.join("\n")).digest("hex");
  return { key, filePaths };
};

const isActiveLocalUploadStatus = (status?: LocalUploadQueueItem["status"]) =>
  status === "queued" || status === "running" || status === "completed";

const cleanupLocalUploadQueueStore = (store: LocalDetectHistoryStore) => {
  const now = Date.now();
  store.localUploads = (store.localUploads ?? []).filter(
    (item) => now - item.updatedAt <= LOCAL_UPLOAD_QUEUE_TTL_MS,
  );
  for (const [key, item] of localUploadQueueItems) {
    if (now - item.updatedAt > LOCAL_UPLOAD_QUEUE_TTL_MS) {
      localUploadQueueItems.delete(key);
    }
  }
};

const getLocalUploadQueueItem = async (key: string) => {
  const memoryItem = localUploadQueueItems.get(key);
  if (memoryItem && Date.now() - memoryItem.updatedAt <= LOCAL_UPLOAD_QUEUE_TTL_MS) {
    return memoryItem;
  }
  const store = await readLocalDetectHistoryStore();
  cleanupLocalUploadQueueStore(store);
  const stored = store.localUploads.find((item) => item.key === key);
  if (stored) localUploadQueueItems.set(key, stored);
  return stored;
};

const saveLocalUploadQueueItem = async (item: LocalUploadQueueItem) => {
  localUploadQueueItems.set(item.key, item);
  const store = await readLocalDetectHistoryStore();
  cleanupLocalUploadQueueStore(store);
  store.localUploads = [item, ...store.localUploads.filter((record) => record.key !== item.key)];
  await writeLocalDetectHistoryStore(store);
};

const updateLocalUploadQueueStatus = async (
  key: string,
  status: LocalUploadQueueItem["status"],
  error?: string,
) => {
  const current = localUploadQueueItems.get(key) ?? (await getLocalUploadQueueItem(key));
  if (!current) return;
  const now = Date.now();
  const next: LocalUploadQueueItem = {
    ...current,
    status,
    updatedAt: now,
    completedAt: status === "completed" || status === "error" ? now : current.completedAt,
    error,
  };
  await saveLocalUploadQueueItem(next);
};

const summarizeLocalDetectHistory = (item: LocalDetectHistoryItem): LocalDetectHistorySummary => ({
  id: item.id,
  uid: item.uid,
  createdAt: item.createdAt,
  options: item.options,
  scannedFileCount: item.result.scannedFileCount,
  archiveCount: item.result.archiveCount,
  remotePartCount: item.result.remotePartCount,
  matchCount: item.result.matches.length,
  initialMatchCount: item.initialMatchCount ?? item.result.matches.length,
  invalidMp4Count: item.result.invalidMp4Files?.length ?? 0,
  duplicateFileCount: item.result.duplicateFiles?.length ?? 0,
  unuploadedGroupCount: item.result.unuploadedGroups.length,
  deletedCount: item.deletedCount ?? 0,
});

const saveLocalDetectHistory = async (
  uid: number,
  options: LocalDetectOptions,
  result: LocalUploadedFilesResult,
) => {
  const store = await readLocalDetectHistoryStore();
  const id = uuid();
  const createdAt = Date.now();
  const savedResult: LocalUploadedFilesResult = {
    ...result,
    historyId: id,
    detectedAt: createdAt,
  };
  const item: LocalDetectHistoryItem = {
    id,
    uid,
    createdAt,
    options,
    result: savedResult,
    initialMatchCount: savedResult.matches.length,
    deletedCount: 0,
  };
  store.histories = [item, ...store.histories.filter((history) => history.id !== id)].slice(
    0,
    LOCAL_DETECT_HISTORY_LIMIT,
  );
  await writeLocalDetectHistoryStore(store);
  return savedResult;
};

const recordLocalUploadedFileDeletions = async (data: {
  uid?: number;
  historyId?: string;
  items: LocalDetectedDeletionItem[];
}) => {
  const store = await readLocalDetectHistoryStore();
  const deletedAt = Date.now();
  const records = data.items.map((item) => ({
    ...item,
    id: uuid(),
    uid: data.uid,
    historyId: data.historyId,
    deletedAt,
  }));
  store.deletions = [...records, ...store.deletions].slice(0, LOCAL_DETECT_DELETION_LIMIT);

  if (data.historyId) {
    const history = store.histories.find((item) => item.id === data.historyId);
    if (history) {
      const deletedPaths = new Set(records.map((item) => normalizeLocalPath(item.localPath)));
      history.result.matches = history.result.matches.filter(
        (item) => !deletedPaths.has(normalizeLocalPath(item.localPath)),
      );
      history.result.invalidMp4Files = (history.result.invalidMp4Files ?? []).filter(
        (item) => !deletedPaths.has(normalizeLocalPath(item.localPath)),
      );
      history.result.duplicateFiles = (history.result.duplicateFiles ?? []).filter(
        (item) => !deletedPaths.has(normalizeLocalPath(item.localPath)),
      );
      history.deletedCount = (history.deletedCount ?? 0) + records.length;
    }
  }

  await writeLocalDetectHistoryStore(store);
  return records;
};

const normalizeMatchText = (value?: string | null) => {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/i, "")
    .replace(/\s+/g, "")
    .replace(/[\[\]【】()（）{}<>《》「」『』._-]/g, "");
};

const trimGeneratedVideoSuffix = (value?: string | null) => {
  return path
    .parse(String(value ?? ""))
    .name.replace(/-弹幕版[\da-f-]*$/i, "")
    .replace(/-后处理$/i, "")
    .replace(/-合并$/i, "");
};

const parseRecorderIdentity = (value?: string | null): ParsedRecorderIdentity | null => {
  const stem = trimGeneratedVideoSuffix(value);
  const recordMatch = stem.match(/^录制-(\d+)-(\d{8})-(\d{6})(?:-(\d+))?-(.+)$/);
  const compactMatch = stem.match(/^(\d{8})-(\d{6})(?:-(\d+))?-(.+)$/);
  const readableMatch = stem.match(
    /^(\d{4})-(\d{2})-(\d{2})[\sT_-]+(\d{2})[-:](\d{2})[-:](\d{2})(?:[-_.](\d+))?[\s_-]+(.+)$/,
  );

  let roomId: string | undefined;
  let date: string;
  let time: string;
  let sequence: string | undefined;
  let title: string;
  if (recordMatch) {
    [, roomId, date, time, sequence, title] = recordMatch;
  } else if (compactMatch) {
    [, date, time, sequence, title] = compactMatch;
  } else if (readableMatch) {
    const [, year, month, day, hour, minute, second, suffix, text] = readableMatch;
    date = `${year}${month}${day}`;
    time = `${hour}${minute}${second}`;
    sequence = suffix;
    title = text;
  } else {
    return null;
  }

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  const startTime = new Date(year, month - 1, day, hour, minute, second).getTime();

  return {
    roomId,
    date,
    time,
    sequence,
    title,
    startTime: Number.isFinite(startTime) ? startTime : undefined,
  };
};

const getRecorderIdentityKey = (identity?: ParsedRecorderIdentity | null) => {
  if (!identity?.date || !identity.time || !identity.sequence) return undefined;
  const roomSegment = identity.roomId ? `${identity.roomId}-` : "";
  return `${roomSegment}${identity.date}-${identity.time}-${identity.sequence}`;
};

const buildRecorderIdentityKeys = (...values: Array<string | undefined | null>) => {
  const keys = new Set<string>();
  for (const value of values) {
    const key = getRecorderIdentityKey(parseRecorderIdentity(value));
    if (key) keys.add(key);
  }
  return Array.from(keys);
};

const normalizePartIdentity = (value?: string | null) => {
  const recorderIdentity = parseRecorderIdentity(value);
  if (recorderIdentity) {
    const roomSegment = recorderIdentity.roomId ? `${recorderIdentity.roomId}-` : "";
    const sequenceSegment = recorderIdentity.sequence ? `-${recorderIdentity.sequence}` : "";
    return normalizeMatchText(
      `录制-${roomSegment}${recorderIdentity.date}-${recorderIdentity.time}${sequenceSegment}-${recorderIdentity.title}`,
    );
  }
  const normalized = normalizeMatchText(value)
    .replace(/弹幕版[\da-f]*$/i, "")
    .replace(/后处理$/i, "")
    .replace(/合并$/i, "");
  return normalized;
};

const formatDateKey = (timestamp?: number) => {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
};

const shiftDateKey = (dateKey: string, offsetDays: number) => {
  if (!/^\d{8}$/.test(dateKey)) return undefined;
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const date = new Date(year, month - 1, day + offsetDays);
  return formatDateKey(date.getTime());
};

const getRecorderHour = (timestamp?: number, time?: string) => {
  if (timestamp && Number.isFinite(timestamp)) return new Date(timestamp).getHours();
  if (time && /^\d{6}$/.test(time)) {
    const hour = Number(time.slice(0, 2));
    return Number.isFinite(hour) ? hour : undefined;
  }
  return undefined;
};

const buildLiveDateKeyCandidates = (dateKey?: string, timestamp?: number, time?: string) => {
  const keys = new Set<string>();
  if (!dateKey) return keys;
  keys.add(dateKey);

  const hour = getRecorderHour(timestamp, time);
  if (hour === undefined) return keys;
  if (hour < 8) {
    const previous = shiftDateKey(dateKey, -1);
    if (previous) keys.add(previous);
  }
  if (hour >= 18) {
    const next = shiftDateKey(dateKey, 1);
    if (next) keys.add(next);
  }

  return keys;
};

const parseRecorderFileName = (stem: string): ParsedLocalMetadata => {
  const identity = parseRecorderIdentity(stem);
  if (!identity) return {};

  return {
    roomId: identity.roomId,
    platform: "bilibili",
    title: identity.title,
    startTime: identity.startTime,
  };
};

const parseRoomDirectoryName = (dirName: string) => {
  const match = dirName.match(/^(\d+)[-_](.+)$/);
  if (!match) return null;
  const username = match[2].trim();
  if (!username) return null;
  return {
    roomId: match[1],
    username,
  };
};

const parseLocalPathRoomMetadata = (filePath: string, expectedRoomId?: string) => {
  const candidates: Array<{ roomId: string; username: string }> = [];
  let current = path.dirname(filePath);
  while (current && current !== path.dirname(current)) {
    const parsed = parseRoomDirectoryName(path.basename(current));
    if (parsed) {
      if (expectedRoomId && parsed.roomId === expectedRoomId) return parsed;
      candidates.push(parsed);
    }
    current = path.dirname(current);
  }
  return candidates[0] ?? null;
};

const parseLocalMatchMetadata = (localFile: LocalVideoFile) => {
  const metadata = parseRecorderFileName(localFile.stem);
  const pathMetadata = parseLocalPathRoomMetadata(localFile.localPath, metadata.roomId);
  return {
    ...metadata,
    roomId: metadata.roomId || pathMetadata?.roomId,
    username: metadata.username || pathMetadata?.username,
    dateKey: formatDateKey(metadata.startTime),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runLimited = async <T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
) => {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
};

const mergeArchiveItem = (current: any, incoming: any) => {
  if (!current) return incoming;
  if (!incoming) return current;

  const currentVideos = Array.isArray(current?.Videos) ? current.Videos : [];
  const incomingVideos = Array.isArray(incoming?.Videos) ? incoming.Videos : [];
  const merged = {
    ...current,
    ...incoming,
    Archive: {
      ...(current?.Archive ?? {}),
      ...(incoming?.Archive ?? {}),
    },
  };
  if (currentVideos.length > 0 && incomingVideos.length === 0) {
    merged.Videos = currentVideos;
  }
  return merged;
};

const buildArchiveSearchKeywords = (localFiles: LocalVideoFile[]) => {
  const titleKeywords = new Map<string, ArchiveSearchKeyword>();
  const userKeywords = new Map<string, ArchiveSearchKeyword>();
  const recordLookup = buildRecordLookup();
  const addKeyword = (
    map: Map<string, ArchiveSearchKeyword>,
    type: ArchiveSearchKeyword["type"],
    value?: string | null,
    minLength = 2,
  ) => {
    const keyword = value?.trim();
    if (!keyword || keyword.length < minLength) return;
    const normalized = normalizeMatchText(keyword);
    if (!normalized || map.has(normalized)) return;
    map.set(normalized, { keyword, normalized, type });
  };

  for (const localFile of localFiles) {
    const metadata = parseLocalMatchMetadata(localFile);
    const record = findRecordByLocalFile(localFile, recordLookup);
    addKeyword(titleKeywords, "title", record?.title || metadata.title, 4);
    addKeyword(titleKeywords, "title", record?.video_filename, 4);
    addKeyword(userKeywords, "streamer", record?.streamer?.name || metadata.username, 2);
  }
  const keywords: ArchiveSearchKeyword[] = [];
  const appendKeyword = (keyword: ArchiveSearchKeyword) => {
    if (
      keywords.length >= 60 ||
      keywords.some((item) => item.type === keyword.type && item.normalized === keyword.normalized)
    ) {
      return;
    }
    keywords.push(keyword);
  };
  const titleList = Array.from(titleKeywords.values());
  const userList = Array.from(userKeywords.values());
  const maxLength = Math.max(titleList.length, userList.length);
  for (let index = 0; index < maxLength; index++) {
    if (titleList[index]) appendKeyword(titleList[index]);
    if (userList[index]) appendKeyword(userList[index]);
  }
  return keywords;
};

const buildLocalMatchHints = (localFiles: LocalVideoFile[]) => {
  const recordLookup = buildRecordLookup();
  const hints = new Map<string, LocalMatchHint>();
  const buildAliases = (...values: Array<string | undefined | null>) => {
    return Array.from(new Set(values.map((value) => normalizeMatchText(value)).filter(Boolean)));
  };
  for (const localFile of localFiles) {
    const metadata = parseLocalMatchMetadata(localFile);
    const record = findRecordByLocalFile(localFile, recordLookup);
    const title = record?.title || metadata.title;
    const username = record?.streamer?.name || metadata.username;
    const identity = parseRecorderIdentity(localFile.stem);
    const normalizedTitle = normalizeMatchText(title);
    const normalizedTitleAliases = buildAliases(
      title,
      metadata.title,
      record?.video_filename,
      identity?.title,
      localFile.stem,
    );
    const dateKey = record?.record_start_time
      ? formatDateKey(record.record_start_time)
      : metadata.dateKey;
    hints.set(normalizeLocalPath(localFile.localPath), {
      title,
      username,
      dateKey,
      normalizedTitle,
      normalizedTitleAliases,
      normalizedUsername: normalizeMatchText(username),
    });
  }
  return hints;
};

const getSearchSignals = (
  searchKeywords: ArchiveSearchKeyword[],
  normalizedTitles?: string | string[],
  normalizedUsername?: string,
) => {
  const titleList = Array.isArray(normalizedTitles)
    ? normalizedTitles
    : normalizedTitles
      ? [normalizedTitles]
      : [];
  const titleSearchMatched =
    titleList.length > 0 &&
    searchKeywords.some(
      (keyword) => keyword.type === "title" && titleList.includes(keyword.normalized),
    );
  const streamerSearchMatched =
    !!normalizedUsername &&
    searchKeywords.some(
      (keyword) => keyword.type === "streamer" && keyword.normalized === normalizedUsername,
    );
  return {
    titleSearchMatched,
    streamerSearchMatched,
    dualSearchMatched: titleSearchMatched && streamerSearchMatched,
  };
};

const fetchPublicArchiveDetail = async (archive: { aid?: number; bvid?: string }) => {
  const params = archive.bvid
    ? `bvid=${encodeURIComponent(String(archive.bvid))}`
    : `aid=${encodeURIComponent(String(archive.aid))}`;
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${params}`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      referer: "https://www.bilibili.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    code?: number;
    message?: string;
    data?: {
      title?: string;
      bvid?: string;
      pages?: Array<{
        cid?: number;
        page?: number;
        part?: string;
        duration?: number;
      }>;
    };
  };
  if (data.code !== 0 || !data.data) {
    throw new Error(data.message || `code ${data.code}`);
  }
  return data.data;
};

const resolveScanRoots = async (rootPath?: string) => {
  const config = appConfig.getAll();
  const rawRoots = rootPath
    ? [rootPath]
    : [config?.webhook?.recoderFolder, config?.recorder?.savePath];
  const roots: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const item of rawRoots) {
    if (!item) continue;
    const resolved = path.resolve(item);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      errors.push(`目录不存在：${resolved}`);
      continue;
    }
    if (!stat.isDirectory()) {
      errors.push(`不是目录：${resolved}`);
      continue;
    }
    roots.push(resolved);
  }

  return { roots, errors };
};

const scanVideoFiles = async (roots: string[], progress?: LocalDetectProgressReporter) => {
  const files: LocalVideoFile[] = [];
  const errors: string[] = [];
  let discoveredVideoCount = 0;
  let followedLinkDirectoryCount = 0;
  const visitedDirs = new Set<string>();
  const visitedFiles = new Set<string>();

  for (const [rootIndex, root] of roots.entries()) {
    progress?.({
      stage: "scan",
      stageLabel: "扫描本地视频",
      total: roots.length,
      processed: rootIndex,
      current: root,
      message: `正在扫描目录 ${rootIndex + 1}/${roots.length}：${root}`,
      log: `扫描目录 ${rootIndex + 1}/${roots.length}：${root}`,
    });
    const stack = [root];
    while (stack.length > 0 && files.length < MAX_SCAN_FILES) {
      const current = stack.pop()!;
      const realCurrent = await fs.realpath(current).catch(() => current);
      const currentKey = normalizeLocalPath(realCurrent);
      if (visitedDirs.has(currentKey)) continue;
      visitedDirs.add(currentKey);

      let entries: fs.Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error) {
        errors.push(`读取目录失败：${current}`);
        continue;
      }

      for (const entry of entries) {
        const filePath = path.join(current, entry.name);
        let stat: any;
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (!isDirectory && !isFile) {
          stat = await fs.stat(filePath).catch(() => null);
          isDirectory = !!stat?.isDirectory();
          isFile = !!stat?.isFile();
        }
        if (isDirectory) {
          if (entry.isSymbolicLink()) {
            followedLinkDirectoryCount += 1;
            progress?.({
              stage: "scan",
              stageLabel: "扫描本地视频",
              total: roots.length,
              processed: rootIndex,
              current: filePath,
              message: `发现软链接目录，已加入扫描：${filePath}`,
              log: `发现软链接目录，已加入扫描：${filePath}`,
            });
          }
          stack.push(filePath);
          continue;
        }
        if (!isFile) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;

        try {
          stat = stat ?? (await fs.stat(filePath));
          discoveredVideoCount += 1;
          const realFile = await fs.realpath(filePath).catch(() => filePath);
          const fileKey = normalizeLocalPath(realFile);
          if (visitedFiles.has(fileKey)) continue;
          visitedFiles.add(fileKey);
          const fileName = path.basename(filePath);
          const stem = path.parse(fileName).name;
          files.push({
            localPath: filePath,
            fileName,
            stem,
            root,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            normalizedBase: normalizeMatchText(fileName),
            normalizedStem: normalizeMatchText(stem),
          });
          if (files.length === 1 || files.length % 25 === 0) {
            progress?.({
              stage: "scan",
              stageLabel: "扫描本地视频",
              total: roots.length,
              processed: rootIndex,
              current: filePath,
              message: `已发现 ${files.length} 个视频，当前：${fileName}`,
              log: `本地扫描进度：已发现 ${files.length} 个视频，当前 ${fileName}`,
            });
          } else {
            progress?.({
              stage: "scan",
              stageLabel: "扫描本地视频",
              total: roots.length,
              processed: rootIndex,
              current: filePath,
              message: `已发现 ${files.length} 个视频，当前：${fileName}`,
            });
          }
        } catch (error) {
          errors.push(`读取文件信息失败：${filePath}`);
        }

        if (files.length >= MAX_SCAN_FILES) break;
      }
    }
    progress?.({
      stage: "scan",
      stageLabel: "扫描本地视频",
      total: roots.length,
      processed: rootIndex + 1,
      current: root,
      message: `目录扫描完成：${root}`,
      log: `目录扫描完成：${root}，累计 ${files.length} 个视频`,
    });
  }

  return {
    files,
    errors,
    truncated: files.length >= MAX_SCAN_FILES,
    discoveredVideoCount,
    followedLinkDirectoryCount,
  };
};

const getInvalidMp4Reason = async (localFile: LocalVideoFile) => {
  if (path.extname(localFile.fileName).toLowerCase() !== ".mp4") return null;

  const shortReason = (value: unknown) => {
    const text = String(value ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "ffprobe 无法读取文件，文件可能损坏";
    const normalized = text
      .replace(/^ffprobe exited with code \d+:\s*/i, "")
      .replace(/^ffprobe was killed with signal [^:]+:\s*/i, "")
      .trim();
    const summary = normalized || text;
    return summary.length > 140 ? `${summary.slice(0, 140)}...` : summary;
  };

  try {
    const meta = await readVideoMeta(localFile.localPath, { json: true });
    const formatDuration = Number(meta?.format?.duration ?? 0);
    const videoStream = meta?.streams?.find((stream: any) => stream.codec_type === "video");
    const streamDuration = Number(videoStream?.duration ?? 0);
    if (!videoStream) {
      return "ffprobe 未识别到视频流";
    }
    if (!Number.isFinite(formatDuration) && !Number.isFinite(streamDuration)) {
      return "ffprobe 未读取到有效时长";
    }
    if (Math.max(formatDuration || 0, streamDuration || 0) <= 0) {
      return "视频时长为 0 或不可读";
    }
    return null;
  } catch (error) {
    return `ffprobe 读取失败：${shortReason(error instanceof Error ? error.message : error)}`;
  }
};

const detectInvalidMp4Files = async (
  localFiles: LocalVideoFile[],
  progress?: LocalDetectProgressReporter,
) => {
  const invalidMp4Files: LocalInvalidMp4File[] = [];
  const playableFiles: LocalVideoFile[] = [];
  const mp4Files = localFiles.filter(
    (localFile) => path.extname(localFile.fileName).toLowerCase() === ".mp4",
  );
  const mp4PathSet = new Set(mp4Files.map((localFile) => normalizeLocalPath(localFile.localPath)));
  let checkedCount = 0;

  await runLimited(mp4Files, 2, async (localFile) => {
    const startCount = checkedCount;
    progress?.({
      stage: "validate",
      stageLabel: "校验 MP4",
      total: mp4Files.length,
      processed: startCount,
      current: localFile.localPath,
      message: `正在校验 MP4 ${formatProgressCount(startCount, mp4Files.length)}：${localFile.fileName}`,
    });
    const reason = await getInvalidMp4Reason(localFile);
    checkedCount += 1;
    if (reason) {
      invalidMp4Files.push({
        localPath: localFile.localPath,
        fileName: localFile.fileName,
        root: localFile.root,
        size: localFile.size,
        mtimeMs: localFile.mtimeMs,
        reason,
      });
      progress?.({
        stage: "validate",
        stageLabel: "校验 MP4",
        total: mp4Files.length,
        processed: checkedCount,
        current: localFile.localPath,
        message: `发现无效 MP4：${localFile.fileName}`,
        log: `发现无效 MP4：${localFile.fileName}，${reason}`,
      });
      return;
    }
    if (checkedCount === 1 || checkedCount % 20 === 0 || checkedCount === mp4Files.length) {
      progress?.({
        stage: "validate",
        stageLabel: "校验 MP4",
        total: mp4Files.length,
        processed: checkedCount,
        current: localFile.localPath,
        message: `MP4 校验进度 ${formatProgressCount(checkedCount, mp4Files.length)}：${localFile.fileName}`,
      });
    }
  });

  const invalidPathSet = new Set(
    invalidMp4Files.map((localFile) => normalizeLocalPath(localFile.localPath)),
  );
  for (const localFile of localFiles) {
    const key = normalizeLocalPath(localFile.localPath);
    if (mp4PathSet.has(key) && invalidPathSet.has(key)) continue;
    playableFiles.push(localFile);
  }

  progress?.({
    stage: "validate",
    stageLabel: "校验 MP4",
    total: mp4Files.length,
    processed: mp4Files.length,
    current: "MP4 校验完成",
    message: `MP4 校验完成：无效 ${invalidMp4Files.length} 个`,
    log: `MP4 校验完成：检查 ${mp4Files.length} 个，无效 ${invalidMp4Files.length} 个`,
  });

  return {
    files: playableFiles,
    invalidMp4Files,
  };
};

const getRecordingDedupKey = (localFile: LocalVideoFile) => {
  return buildRecorderIdentityKeys(localFile.fileName, localFile.stem)[0];
};

const SUSPICIOUS_PROCESSED_MP4_MAX_BYTES = 128 * 1024 * 1024;
const SUSPICIOUS_PROCESSED_MP4_SOURCE_BYTES = 1024 * 1024 * 1024;
const SUSPICIOUS_PROCESSED_MP4_MAX_RATIO = 0.1;
const processedMp4Pattern =
  /(?:\u5f39\u5e55\u7248|danmu|subtitle|\u540e\u5904\u7406|\u5408\u5e76|handled|merged)/i;

const isProcessedMp4Candidate = (localFile: LocalVideoFile) => {
  return (
    path.extname(localFile.fileName).toLowerCase() === ".mp4" &&
    processedMp4Pattern.test(localFile.stem)
  );
};

const isSuspiciousProcessedMp4 = (localFile: LocalVideoFile, groupMaxSize: number) => {
  return (
    isProcessedMp4Candidate(localFile) &&
    groupMaxSize >= SUSPICIOUS_PROCESSED_MP4_SOURCE_BYTES &&
    localFile.size < SUSPICIOUS_PROCESSED_MP4_MAX_BYTES &&
    localFile.size < groupMaxSize * SUSPICIOUS_PROCESSED_MP4_MAX_RATIO
  );
};

const getLocalFilePriority = (localFile: LocalVideoFile, groupMaxSize = localFile.size) => {
  const ext = path.extname(localFile.fileName).toLowerCase();
  const stem = localFile.stem.toLowerCase();
  if (isSuspiciousProcessedMp4(localFile, groupMaxSize)) return 150;
  if (ext === ".mp4" && /弹幕版|danmu|subtitle/.test(stem)) return 500;
  if (ext === ".mp4" && /后处理|合并|handled|merged/.test(stem)) return 450;
  if (ext === ".mp4") return 400;
  if ([".mkv", ".mov", ".m4v", ".webm"].includes(ext)) return 300;
  if (ext === ".flv") return 200;
  return 100;
};

const choosePrimaryLocalRecordingFile = (files: LocalVideoFile[]) => {
  const groupMaxSize = Math.max(...files.map((file) => file.size));
  return [...files].sort((left, right) => {
    const priorityDiff =
      getLocalFilePriority(right, groupMaxSize) - getLocalFilePriority(left, groupMaxSize);
    if (priorityDiff !== 0) return priorityDiff;
    const mtimeDiff = right.mtimeMs - left.mtimeMs;
    if (mtimeDiff !== 0) return mtimeDiff;
    return right.size - left.size;
  })[0];
};

const dedupeLocalRecordingFiles = (
  localFiles: LocalVideoFile[],
  progress?: LocalDetectProgressReporter,
) => {
  const grouped = new Map<string, LocalVideoFile[]>();
  const passthrough: LocalVideoFile[] = [];
  for (const localFile of localFiles) {
    const key = getRecordingDedupKey(localFile);
    if (!key) {
      passthrough.push(localFile);
      continue;
    }
    const files = grouped.get(key) ?? [];
    files.push(localFile);
    grouped.set(key, files);
  }

  const files: LocalVideoFile[] = [...passthrough];
  const duplicateFiles: LocalDuplicateVideoFile[] = [];
  for (const [recordingKey, groupFiles] of grouped) {
    if (groupFiles.length === 1) {
      files.push(groupFiles[0]);
      continue;
    }
    const primary = choosePrimaryLocalRecordingFile(groupFiles);
    files.push(primary);
    for (const localFile of groupFiles) {
      if (normalizeLocalPath(localFile.localPath) === normalizeLocalPath(primary.localPath)) {
        continue;
      }
      duplicateFiles.push({
        localPath: localFile.localPath,
        fileName: localFile.fileName,
        root: localFile.root,
        size: localFile.size,
        mtimeMs: localFile.mtimeMs,
        reason: `同场录播已折叠，主候选：${primary.fileName}`,
        recordingKey,
        primaryLocalPath: primary.localPath,
        primaryFileName: primary.fileName,
      });
    }
  }

  if (duplicateFiles.length > 0) {
    progress?.({
      stage: "scan",
      stageLabel: "折叠同场文件",
      total: localFiles.length,
      processed: localFiles.length,
      current: "同场文件折叠完成",
      message: `同场文件折叠完成：主候选 ${files.length} 个，重复 ${duplicateFiles.length} 个`,
      log: `同场文件折叠完成：主候选 ${files.length} 个，重复 ${duplicateFiles.length} 个`,
    });
  }

  return {
    files,
    duplicateFiles,
  };
};

const collectRemoteVideoParts = async (
  uid: number,
  pages: number,
  pageSize: number,
  useArchiveDetail = false,
  detailIntervalMs = DEFAULT_DETAIL_INTERVAL_MS,
  searchKeywords: ArchiveSearchKeyword[] = [],
  progress?: LocalDetectProgressReporter,
) => {
  const archives = new Map<number, RemoteArchiveItem>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const pushLog = (message: string, patch: LocalDetectProgressPatch = {}) => {
    logs.push(message);
    progress?.({
      message,
      ...patch,
      log: message,
    });
  };

  const addArchive = (item: any, source: string, searchKeyword?: ArchiveSearchKeyword) => {
    const aid = Number(item?.Archive?.aid);
    if (!aid) return;
    const existing = archives.get(aid);
    if (existing) {
      existing.item = mergeArchiveItem(existing.item, item);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (
        searchKeyword &&
        !existing.searchKeywords.some(
          (keyword) =>
            keyword.type === searchKeyword.type && keyword.normalized === searchKeyword.normalized,
        )
      ) {
        existing.searchKeywords.push(searchKeyword);
      }
      return;
    }
    archives.set(aid, {
      aid,
      item,
      sources: [source],
      searchKeywords: searchKeyword ? [searchKeyword] : [],
    });
  };

  const collectPagedArchives = async () => {
    for (let pn = 1; pn <= pages; pn++) {
      progress?.({
        stage: "archives",
        stageLabel: "读取稿件列表",
        total: pages,
        processed: pn - 1,
        current: `稿件列表第 ${pn} 页`,
        message: `正在读取B站投稿中心列表第 ${pn}/${pages} 页`,
      });
      try {
        const data = await biliApi.getArchives({ pn, ps: pageSize }, uid);
        const pageItems = data?.arc_audits ?? [];
        pushLog(`已读取B站稿件列表第 ${pn} 页：${pageItems.length} 条`, {
          stage: "archives",
          stageLabel: "读取稿件列表",
          total: pages,
          processed: pn,
          current: `稿件列表第 ${pn} 页`,
        });
        for (const item of pageItems) {
          addArchive(item, `列表第 ${pn} 页`);
        }
        const total = Number(data?.page?.count ?? 0);
        if (total > 0 && pn * pageSize >= total) break;
      } catch (error) {
        errors.push(`获取稿件列表第 ${pn} 页失败`);
        pushLog(`获取B站稿件列表第 ${pn} 页失败，检测已停止继续拉取远端列表`, {
          stage: "archives",
          stageLabel: "读取稿件列表",
          total: pages,
          processed: pn,
          current: `稿件列表第 ${pn} 页`,
        });
        break;
      }
    }
  };

  const collectSearchArchives = async () => {
    if (searchKeywords.length === 0) return;
    const titleCount = searchKeywords.filter((item) => item.type === "title").length;
    const streamerCount = searchKeywords.filter((item) => item.type === "streamer").length;
    pushLog(
      `开始按本地标题/主播搜索稿件：标题 ${titleCount} 个，主播 ${streamerCount} 个，并发 ${ARCHIVE_SEARCH_CONCURRENCY}`,
      {
        stage: "search",
        stageLabel: "搜索稿件",
        total: searchKeywords.length,
        processed: 0,
        current: "等待搜索关键词",
      },
    );

    const results: Array<{
      keyword: ArchiveSearchKeyword;
      pageItems?: any[];
      error?: unknown;
    }> = new Array(searchKeywords.length);
    let completedSearchCount = 0;
    await runLimited(searchKeywords, ARCHIVE_SEARCH_CONCURRENCY, async (keyword, index) => {
      const label = keyword.type === "streamer" ? "主播" : "标题";
      let finishMessage = "";
      progress?.({
        stage: "search",
        stageLabel: "搜索稿件",
        total: searchKeywords.length,
        processed: completedSearchCount,
        current: `${label}：${keyword.keyword}`,
        message: `正在搜索${label}“${keyword.keyword}”`,
      });
      try {
        const data = await biliApi.getArchives(
          { pn: 1, ps: 10, keyword: keyword.keyword } as any,
          uid,
        );
        const pageItems = data?.arc_audits ?? [];
        results[index] = {
          keyword,
          pageItems,
        };
        finishMessage = `搜索${label}“${keyword.keyword}”：${pageItems.length} 条`;
      } catch (error) {
        results[index] = { keyword, error };
        finishMessage = `搜索${label}“${keyword.keyword}”失败，已跳过`;
      }
      completedSearchCount += 1;
      const searchProgressPatch: LocalDetectProgressPatch = {
        stage: "search",
        stageLabel: "搜索稿件",
        total: searchKeywords.length,
        processed: completedSearchCount,
        current: `${label}：${keyword.keyword}`,
        message:
          finishMessage ||
          `搜索进度 ${formatProgressCount(completedSearchCount, searchKeywords.length)}：${label}“${keyword.keyword}”`,
      };
      if (finishMessage) searchProgressPatch.log = finishMessage;
      progress?.(searchProgressPatch);
    });

    for (const result of results) {
      if (!result) continue;
      const label = result.keyword.type === "streamer" ? "主播" : "标题";
      if (result.error) {
        warnings.push(`搜索${label}稿件失败：${result.keyword.keyword}`);
        logs.push(`搜索${label}“${result.keyword.keyword}”失败，已跳过`);
        continue;
      }
      const pageItems = result.pageItems ?? [];
      logs.push(`搜索${label}“${result.keyword.keyword}”：${pageItems.length} 条`);
      for (const item of pageItems) {
        addArchive(item, `搜索${label}：${result.keyword.keyword}`, result.keyword);
      }
    }

    const dualSearchArchiveCount = Array.from(archives.values()).filter((archive) => {
      const hasTitle = archive.searchKeywords.some((keyword) => keyword.type === "title");
      const hasStreamer = archive.searchKeywords.some((keyword) => keyword.type === "streamer");
      return hasTitle && hasStreamer;
    }).length;
    if (dualSearchArchiveCount > 0) {
      pushLog(`搜索结果合并完成：${dualSearchArchiveCount} 个稿件同时命中标题和主播搜索`, {
        stage: "search",
        stageLabel: "搜索稿件",
        total: searchKeywords.length,
        processed: searchKeywords.length,
        current: "搜索结果合并",
      });
    }
  };

  await Promise.all([collectPagedArchives(), collectSearchArchives()]);

  const parts: RemoteVideoPart[] = [];
  if (!useArchiveDetail) {
    pushLog("本轮使用稿件列表信息匹配，未请求稿件详情接口", {
      stage: "details",
      stageLabel: "读取分P详情",
      total: archives.size,
      processed: archives.size,
      current: "列表信息",
    });
  } else {
    pushLog(`本轮启用稿件详情接口匹配，详情请求间隔 ${detailIntervalMs}ms`, {
      stage: "details",
      stageLabel: "读取分P详情",
      total: archives.size,
      processed: 0,
      current: "准备读取详情",
    });
  }
  let consecutivePrivateDetailFailures = 0;
  let skipPrivateDetail = false;
  let skippedPrivateDetailCount = 0;
  let detailRequestCount = 0;
  let publicDetailCount = 0;
  let privateDetailCount = 0;
  let searchPrivateDetailAttempts = 0;
  let searchPrivateDetailLimitLogged = false;
  const waitDetailInterval = async () => {
    if (detailRequestCount > 0 && detailIntervalMs > 0) {
      await sleep(detailIntervalMs);
    }
    detailRequestCount += 1;
  };
  const fetchPrivateDetail = async (aid: number, forceForSearch: boolean) => {
    if (!forceForSearch && skipPrivateDetail) {
      return null;
    }
    if (forceForSearch) {
      if (searchPrivateDetailAttempts >= SEARCH_PRIVATE_DETAIL_LIMIT) {
        if (!searchPrivateDetailLimitLogged) {
          pushLog(
            `搜索命中稿件私有详情尝试达到 ${SEARCH_PRIVATE_DETAIL_LIMIT} 个，后续改用公开/列表信息`,
            {
              stage: "details",
              stageLabel: "读取分P详情",
              current: `AV${aid}`,
            },
          );
          searchPrivateDetailLimitLogged = true;
        }
        return null;
      }
      searchPrivateDetailAttempts += 1;
    }
    await waitDetailInterval();
    const data = await biliApi.getPlatformArchiveDetail(aid, uid);
    privateDetailCount += 1;
    consecutivePrivateDetailFailures = 0;
    return data;
  };
  const archiveEntries = Array.from(archives);
  for (const [archiveIndex, [aid, archiveItem]] of archiveEntries.entries()) {
    const item = archiveItem.item;
    const archiveTitleForProgress = String(item?.Archive?.title ?? `AV${aid}`);
    progress?.({
      stage: "details",
      stageLabel: "读取分P详情",
      total: archiveEntries.length,
      processed: archiveIndex,
      current: `AV${aid} ${archiveTitleForProgress}`,
      message: `${
        useArchiveDetail ? "正在处理稿件详情" : "正在使用列表信息生成匹配项"
      } ${formatProgressCount(archiveIndex, archiveEntries.length)}：AV${aid} ${archiveTitleForProgress}`,
    });
    let detail: any | null = null;
    let publicDetail: Awaited<ReturnType<typeof fetchPublicArchiveDetail>> | null = null;
    let privateDetailTried = false;
    const isSearchHit = archiveItem.searchKeywords.length > 0;
    if (useArchiveDetail) {
      if (isSearchHit) {
        pushLog(`稿件 ${aid} 来自搜索命中，优先尝试私有详情接口`, {
          stage: "details",
          stageLabel: "读取分P详情",
          total: archiveEntries.length,
          processed: archiveIndex,
          current: `AV${aid} ${archiveTitleForProgress}`,
        });
        try {
          privateDetailTried = searchPrivateDetailAttempts < SEARCH_PRIVATE_DETAIL_LIMIT;
          progress?.({
            stage: "details",
            stageLabel: "读取分P详情",
            total: archiveEntries.length,
            processed: archiveIndex,
            current: `AV${aid} ${archiveTitleForProgress}`,
            message: `正在请求私有稿件详情：AV${aid}`,
          });
          detail = await fetchPrivateDetail(aid, true);
        } catch (error) {
          consecutivePrivateDetailFailures += 1;
          pushLog(`搜索命中稿件 ${aid} 私有详情不可用，继续尝试公开详情`, {
            stage: "details",
            stageLabel: "读取分P详情",
            total: archiveEntries.length,
            processed: archiveIndex,
            current: `AV${aid} ${archiveTitleForProgress}`,
          });
          if (consecutivePrivateDetailFailures >= DETAIL_FAILURE_LIMIT) {
            skipPrivateDetail = true;
            pushLog(
              `私有稿件详情接口连续失败 ${DETAIL_FAILURE_LIMIT} 次，非搜索命中稿件将跳过私有兜底`,
              {
                stage: "details",
                stageLabel: "读取分P详情",
                total: archiveEntries.length,
                processed: archiveIndex,
                current: `AV${aid} ${archiveTitleForProgress}`,
              },
            );
          }
        }
      }

      try {
        if (!detail) {
          pushLog(`稿件 ${aid} 正在请求公开视频分P接口`, {
            stage: "details",
            stageLabel: "读取分P详情",
            total: archiveEntries.length,
            processed: archiveIndex,
            current: `AV${aid} ${archiveTitleForProgress}`,
          });
          await waitDetailInterval();
          publicDetail = await fetchPublicArchiveDetail({
            aid,
            bvid: item?.Archive?.bvid,
          });
          publicDetailCount += 1;
        }
      } catch (publicError) {
        if (privateDetailTried) {
          warnings.push(`稿件分P详情不可用，已使用列表信息继续判断未上传：${aid}`);
          pushLog(`稿件 ${aid} 公开详情和私有详情均不可用，无法做分P级匹配`, {
            stage: "details",
            stageLabel: "读取分P详情",
            total: archiveEntries.length,
            processed: archiveIndex,
            current: `AV${aid} ${archiveTitleForProgress}`,
          });
        } else if (skipPrivateDetail) {
          skippedPrivateDetailCount += 1;
          pushLog(`稿件 ${aid} 公开分P信息不可用，私有详情已临时跳过`, {
            stage: "details",
            stageLabel: "读取分P详情",
            total: archiveEntries.length,
            processed: archiveIndex,
            current: `AV${aid} ${archiveTitleForProgress}`,
          });
        } else {
          pushLog(`稿件 ${aid} 公开分P信息不可用，尝试私有详情接口`, {
            stage: "details",
            stageLabel: "读取分P详情",
            total: archiveEntries.length,
            processed: archiveIndex,
            current: `AV${aid} ${archiveTitleForProgress}`,
          });
          try {
            progress?.({
              stage: "details",
              stageLabel: "读取分P详情",
              total: archiveEntries.length,
              processed: archiveIndex,
              current: `AV${aid} ${archiveTitleForProgress}`,
              message: `正在请求私有稿件详情：AV${aid}`,
            });
            detail = await fetchPrivateDetail(aid, false);
          } catch (error) {
            consecutivePrivateDetailFailures += 1;
            warnings.push(`稿件分P详情不可用，已使用列表信息继续判断未上传：${aid}`);
            pushLog(`稿件 ${aid} 私有详情接口不可用，无法做分P级匹配`, {
              stage: "details",
              stageLabel: "读取分P详情",
              total: archiveEntries.length,
              processed: archiveIndex,
              current: `AV${aid} ${archiveTitleForProgress}`,
            });
            if (consecutivePrivateDetailFailures >= DETAIL_FAILURE_LIMIT) {
              skipPrivateDetail = true;
              pushLog(
                `私有稿件详情接口连续失败 ${DETAIL_FAILURE_LIMIT} 次，本轮后续仅在公开详情失败时跳过私有兜底`,
                {
                  stage: "details",
                  stageLabel: "读取分P详情",
                  total: archiveEntries.length,
                  processed: archiveIndex,
                  current: `AV${aid} ${archiveTitleForProgress}`,
                },
              );
            }
          }
        }
      }
    }

    const archive = detail?.archive ?? publicDetail ?? item?.Archive ?? {};
    const videos = Array.isArray(detail?.videos)
      ? detail.videos
      : Array.isArray(publicDetail?.pages)
        ? publicDetail.pages
        : Array.isArray(item?.Videos)
          ? item.Videos
          : [];
    const archiveTitle = String(archive?.title ?? item?.Archive?.title ?? "");
    const bvid = archive?.bvid ?? publicDetail?.bvid ?? item?.Archive?.bvid;
    const addPart = (video?: any) => {
      const remoteFilename = video?.filename ? path.basename(String(video.filename)) : undefined;
      const remoteFilenameStem = remoteFilename ? path.parse(remoteFilename).name : undefined;
      const partTitle = video?.title
        ? String(video.title)
        : video?.part
          ? String(video.part)
          : undefined;
      const effectivePartTitle = partTitle || (videos.length <= 1 ? archiveTitle : undefined);
      const values = [
        { label: "分P文件名", value: remoteFilename },
        { label: "分P文件名", value: remoteFilenameStem },
        { label: "分P标题", value: effectivePartTitle },
      ]
        .map((value) => ({
          label: value.label,
          raw: value.value,
          normalized: normalizePartIdentity(value.value),
        }))
        .filter((value) => value.normalized);

      parts.push({
        aid,
        bvid,
        cid: video?.cid ? Number(video.cid) : undefined,
        page: video?.page ? Number(video.page) : undefined,
        archiveTitle,
        partTitle: effectivePartTitle,
        remoteFilename,
        values,
        sources: archiveItem.sources,
        searchKeywords: archiveItem.searchKeywords,
      });
    };

    if (videos.length === 0) {
      addPart();
    } else {
      for (const video of videos) addPart(video);
    }
    progress?.({
      stage: "details",
      stageLabel: "读取分P详情",
      total: archiveEntries.length,
      processed: archiveIndex + 1,
      current: `AV${aid} ${archiveTitle}`,
      message: `稿件详情处理进度 ${formatProgressCount(archiveIndex + 1, archiveEntries.length)}：AV${aid}`,
    });
  }
  if (skippedPrivateDetailCount > 0) {
    warnings.push(`已跳过 ${skippedPrivateDetailCount} 个私有稿件详情请求，改用稿件列表信息匹配`);
  }
  if (useArchiveDetail) {
    pushLog(
      `分P详情读取完成：公开接口 ${publicDetailCount} 个，私有接口 ${privateDetailCount} 个`,
      {
        stage: "details",
        stageLabel: "读取分P详情",
        total: archiveEntries.length,
        processed: archiveEntries.length,
        current: "分P详情读取完成",
      },
    );
  }

  return { parts, archiveCount: archives.size, errors, warnings, logs };
};

const matchLocalFile = (
  localFile: LocalVideoFile,
  remotePart: RemoteVideoPart,
  hint?: LocalMatchHint,
) => {
  void hint;
  const localKeys = buildRecorderIdentityKeys(localFile.fileName, localFile.stem);
  const remoteKeys = new Set(
    buildRecorderIdentityKeys(
      ...remotePart.values.map((value) => value.raw),
      !remotePart.partTitle && (!remotePart.page || remotePart.page === 1)
        ? remotePart.archiveTitle
        : undefined,
    ),
  );
  if (localKeys.length > 0 && localKeys.some((key) => remoteKeys.has(key))) {
    return {
      score: 100,
      confidence: "high" as const,
      reason: `录制标识匹配分P标题${remotePart.page ? ` P${remotePart.page}` : ""}`,
    };
  }

  return null;
};

const normalizeLocalPath = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const normalizeRecordStem = (value?: string | null) => {
  return normalizeMatchText(value)
    .replace(/寮瑰箷鐗?[\da-f-]*$/i, "")
    .replace(/弹幕版[\da-f-]*$/i, "")
    .replace(/鍚庡鐞?$/i, "")
    .replace(/后处理$/i, "")
    .replace(/鍚堝苟$/i, "")
    .replace(/合并$/i, "");
};

const buildRecordLookup = () => {
  const pathMap = new Map<string, RecordWithStreamer>();
  const stemMap = new Map<string, RecordWithStreamer[]>();
  const streamers = new Map<number, Streamer>();
  for (const streamer of streamerService.list()) {
    streamers.set(streamer.id, streamer);
  }

  for (const record of recordHistoryService.list({})) {
    if (!record.video_file) continue;
    const item: RecordWithStreamer = {
      ...record,
      streamer: streamers.get(record.streamer_id) ?? null,
    };
    pathMap.set(normalizeLocalPath(record.video_file), item);
    pathMap.set(normalizeLocalPath(replaceExtName(record.video_file, ".mp4")), item);

    const stems = new Set([
      normalizeRecordStem(record.video_filename),
      normalizeRecordStem(path.parse(record.video_file).name),
    ]);
    for (const stem of stems) {
      if (!stem) continue;
      const records = stemMap.get(stem) ?? [];
      records.push(item);
      stemMap.set(stem, records);
    }
  }

  return { pathMap, stemMap };
};

const findDanmuFiles = async (videoPath: string) => {
  const assFile = replaceExtName(videoPath, ".ass");
  const xmlFile = replaceExtName(videoPath, ".xml");
  const assExists = await fs.pathExists(assFile);
  const xmlExists = await fs.pathExists(xmlFile);

  return {
    danmuPath: assExists ? assFile : xmlExists ? xmlFile : undefined,
    xmlDanmuPath: xmlExists ? xmlFile : undefined,
  };
};

const findRecordByLocalFile = (
  localFile: LocalVideoFile,
  recordLookup: ReturnType<typeof buildRecordLookup>,
) => {
  const byPath = recordLookup.pathMap.get(normalizeLocalPath(localFile.localPath));
  if (byPath) return byPath;

  const records = recordLookup.stemMap.get(normalizeRecordStem(localFile.stem)) ?? [];
  return records.length === 1 ? records[0] : null;
};

const parseLocalFileMetadata = async (
  localFile: LocalVideoFile,
  danmuFiles: { danmuPath?: string; xmlDanmuPath?: string },
): Promise<ParsedLocalMetadata> => {
  const fromName = parseRecorderFileName(localFile.stem);
  const fromPath = parseLocalPathRoomMetadata(localFile.localPath, fromName.roomId);

  try {
    const danmaFilePath = danmuFiles.xmlDanmuPath || danmuFiles.danmuPath;
    const shouldReadVideoMeta = !fromName.roomId && !danmaFilePath;
    const meta = await parseMeta({
      videoFilePath: shouldReadVideoMeta ? localFile.localPath : undefined,
      danmaFilePath,
    });

    return {
      roomId: meta.roomId || fromName.roomId || fromPath?.roomId,
      platform: meta.platform && meta.platform !== "unknown" ? meta.platform : fromName.platform,
      username: meta.username || fromName.username || fromPath?.username,
      title: meta.title || fromName.title,
      startTime: meta.startTimestamp ? meta.startTimestamp * 1000 : fromName.startTime,
    };
  } catch {
    return {
      ...fromName,
      roomId: fromName.roomId || fromPath?.roomId,
      username: fromName.username || fromPath?.username,
    };
  }
};

const buildLocalFileContexts = async (
  localFiles: LocalVideoFile[],
  matches: LocalUploadedFileMatch[],
  progress?: LocalDetectProgressReporter,
) => {
  const recordLookup = buildRecordLookup();
  const matchMap = new Map(matches.map((item) => [normalizeLocalPath(item.localPath), item]));
  const streamerByRoomId = new Map<string, Streamer>();
  for (const streamer of streamerService.list()) {
    streamerByRoomId.set(String(streamer.room_id), streamer);
  }
  const contexts: LocalFileContext[] = [];

  for (const [index, localFile] of localFiles.entries()) {
    progress?.({
      stage: "grouping",
      stageLabel: "识别未上传分组",
      total: localFiles.length,
      processed: index,
      current: localFile.localPath,
      message: `正在识别本地视频归属 ${formatProgressCount(index, localFiles.length)}：${localFile.fileName}`,
    });
    const normalizedPath = normalizeLocalPath(localFile.localPath);
    const danmuFiles = await findDanmuFiles(localFile.localPath);
    const record = findRecordByLocalFile(localFile, recordLookup);
    const metadata =
      record && record.streamer && record.title
        ? {}
        : await parseLocalFileMetadata(localFile, danmuFiles);
    const roomId = record?.streamer?.room_id ?? metadata.roomId;
    const streamer = record?.streamer ?? (roomId ? streamerByRoomId.get(roomId) : null) ?? null;
    const platform = streamer?.platform ?? metadata.platform ?? (roomId ? "bilibili" : undefined);
    const username = streamer?.name ?? metadata.username;
    const title = record?.title || metadata.title || localFile.stem;
    const startTime = record?.record_start_time ?? metadata.startTime ?? localFile.mtimeMs;
    const parentDir = path.dirname(localFile.localPath);
    const fallbackDay = new Date(localFile.mtimeMs).toISOString().slice(0, 10);
    const dayKey = new Date(startTime).toISOString().slice(0, 10);
    const groupKey = roomId
      ? `${platform || "bilibili"}:${roomId}:${record?.live_id || `${dayKey}:${normalizeMatchText(title)}`}`
      : `dir:${normalizeLocalPath(parentDir)}:${fallbackDay}`;

    contexts.push({
      localFile,
      record,
      match: matchMap.get(normalizedPath),
      groupKey,
      roomId,
      platform,
      username,
      title,
      startTime,
      endTime: record?.record_end_time,
      ...danmuFiles,
    });

    if (index === 0 || (index + 1) % 25 === 0 || index === localFiles.length - 1) {
      progress?.({
        stage: "grouping",
        stageLabel: "识别未上传分组",
        total: localFiles.length,
        processed: index + 1,
        current: localFile.localPath,
        message: `本地视频归属识别进度 ${formatProgressCount(index + 1, localFiles.length)}：${localFile.fileName}`,
        log: `本地视频归属识别 ${index + 1}/${localFiles.length}：${localFile.fileName}`,
      });
    } else {
      progress?.({
        stage: "grouping",
        stageLabel: "识别未上传分组",
        total: localFiles.length,
        processed: index + 1,
        current: localFile.localPath,
        message: `本地视频归属识别进度 ${formatProgressCount(index + 1, localFiles.length)}：${localFile.fileName}`,
      });
    }
  }

  return contexts;
};

const buildLocalFileStreamerKeys = async (
  localFile: LocalVideoFile,
  recordLookup: ReturnType<typeof buildRecordLookup>,
) => {
  const keys = new Set<string>();
  const appendKey = (roomId?: string | number | null, platform?: string | null) => {
    const key = getStreamerFilterKey(roomId, platform);
    if (key) keys.add(key);
  };

  const record = findRecordByLocalFile(localFile, recordLookup);
  appendKey(record?.streamer?.room_id, record?.streamer?.platform);

  const filenameIdentity = parseRecorderIdentity(localFile.fileName);
  const stemIdentity = parseRecorderIdentity(localFile.stem);
  appendKey(filenameIdentity?.roomId, "bilibili");
  appendKey(stemIdentity?.roomId, "bilibili");

  const matchMetadata = parseLocalMatchMetadata(localFile);
  appendKey(matchMetadata.roomId, matchMetadata.platform);

  if (keys.size === 0) {
    const danmuFiles = await findDanmuFiles(localFile.localPath);
    const metadata = await parseLocalFileMetadata(localFile, danmuFiles);
    appendKey(metadata.roomId, metadata.platform);
  }

  return keys;
};

const filterLocalFilesBySelectedStreamers = async (
  localFiles: LocalVideoFile[],
  selectedStreamers: SelectedLocalStreamer[],
  progress?: LocalDetectProgressReporter,
) => {
  const selectedKeys = new Set(
    selectedStreamers
      .map((item) => getStreamerFilterKey(item.roomId, item.platform))
      .filter((item): item is string => !!item),
  );
  if (selectedKeys.size === 0) {
    return {
      files: localFiles,
      skipped: 0,
    };
  }

  const recordLookup = buildRecordLookup();
  const files: LocalVideoFile[] = [];
  let skipped = 0;
  for (const [index, localFile] of localFiles.entries()) {
    const fileKeys = await buildLocalFileStreamerKeys(localFile, recordLookup);
    if (Array.from(fileKeys).some((key) => selectedKeys.has(key))) {
      files.push(localFile);
    } else {
      skipped += 1;
    }

    if (index === 0 || (index + 1) % 50 === 0 || index === localFiles.length - 1) {
      progress?.({
        stage: "scan",
        stageLabel: "按主播筛选",
        total: localFiles.length,
        processed: index + 1,
        current: localFile.localPath,
        message: `按主播筛选本地视频 ${formatProgressCount(index + 1, localFiles.length)}，保留 ${files.length} 个`,
      });
    }
  }

  return {
    files,
    skipped,
  };
};

const hasWebhookUploadConfig = (roomId?: string) => {
  try {
    const config = handler.configManager.getConfig(roomId || DEFAULT_WEBHOOK_ROOM_ID);
    return !!config.uid && !!config.uploadPresetId;
  } catch {
    return false;
  }
};

const normalizeStreamerPlatform = (platform?: string | null) =>
  String(platform || "bilibili").toLowerCase();

const getStreamerFilterKey = (roomId?: string | number | null, platform?: string | null) => {
  if (!roomId) return undefined;
  return `${normalizeStreamerPlatform(platform)}:${String(roomId)}`;
};

const normalizeSelectedStreamers = (items?: SelectedLocalStreamer[]) => {
  const map = new Map<string, SelectedLocalStreamer>();
  for (const item of items ?? []) {
    if (!item?.roomId) continue;
    const platform = normalizeStreamerPlatform(item.platform);
    const key = getStreamerFilterKey(item.roomId, platform);
    if (!key) continue;
    map.set(key, {
      roomId: String(item.roomId),
      platform,
    });
  }
  return Array.from(map.values());
};

const addLocalUploadStreamerOption = (
  map: Map<string, LocalUploadStreamerOption>,
  item: {
    roomId: string | number;
    platform?: string | null;
    name?: string | null;
    localSizeBytes?: number;
    localFolderCount?: number;
  },
) => {
  const key = getStreamerFilterKey(item.roomId, item.platform);
  if (!key) return;
  const roomId = String(item.roomId);
  const name = String(item.name || "").trim() || roomId;
  const localSizeBytes = Math.max(0, item.localSizeBytes ?? 0);
  const localFolderCount = Math.max(0, item.localFolderCount ?? 0);
  const existing = map.get(key);
  if (existing) {
    if ((!existing.name || existing.name === existing.roomId) && name !== roomId) {
      existing.name = name;
    }
    existing.hasWebhookUploadConfig ||= hasWebhookUploadConfig(roomId);
    existing.localSizeBytes += localSizeBytes;
    existing.localFolderCount += localFolderCount;
    return;
  }
  map.set(key, {
    key,
    roomId,
    platform: normalizeStreamerPlatform(item.platform),
    name,
    hasWebhookUploadConfig: hasWebhookUploadConfig(roomId),
    localSizeBytes,
    localFolderCount,
  });
};

type KnownLocalStreamer = {
  roomId: string;
  username: string;
  platform: string;
};

const normalizeDirectoryPlatform = (value?: string | null) => {
  const normalized = normalizeMatchText(value);
  if (!normalized) return undefined;
  const aliases: Record<string, string> = {
    bilibili: "bilibili",
    哔哩哔哩: "bilibili",
    b站: "bilibili",
    douyin: "douyin",
    抖音: "douyin",
    douyu: "douyu",
    斗鱼: "douyu",
    huya: "huya",
    虎牙: "huya",
    xhs: "xhs",
    小红书: "xhs",
  };
  return aliases[normalized];
};

const buildKnownLocalStreamerIndexes = (streamers: Streamer[]) => {
  const byName = new Map<string, KnownLocalStreamer[]>();
  const byRoomId = new Map<string, KnownLocalStreamer[]>();

  const append = (
    map: Map<string, KnownLocalStreamer[]>,
    key: string,
    item: KnownLocalStreamer,
  ) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  };

  for (const streamer of streamers) {
    const item: KnownLocalStreamer = {
      roomId: String(streamer.room_id),
      username: streamer.name,
      platform: normalizeStreamerPlatform(streamer.platform),
    };
    append(byName, normalizeMatchText(streamer.name), item);
    append(byRoomId, String(streamer.room_id), item);
  }

  const pick = (items: KnownLocalStreamer[] | undefined, platform?: string) => {
    if (!items?.length) return null;
    const normalizedPlatform = platform ? normalizeStreamerPlatform(platform) : undefined;
    const filtered = normalizedPlatform
      ? items.filter((item) => item.platform === normalizedPlatform)
      : items;
    if (filtered.length === 1) return filtered[0];
    return null;
  };

  return {
    matchDirectoryName(dirName: string, platform?: string) {
      const normalizedName = normalizeMatchText(dirName);
      return pick(byName.get(normalizedName), platform) ?? pick(byRoomId.get(dirName), platform);
    },
  };
};

const scanStreamerDirsFromRoots = async (roots: string[], knownStreamers: Streamer[]) => {
  type DirectoryStreamer = {
    roomId: string;
    username: string;
    platform: string;
    localSizeBytes: number;
    localFolderCount: number;
  };
  const streamers = new Map<string, DirectoryStreamer>();
  const knownStreamerIndexes = buildKnownLocalStreamerIndexes(knownStreamers);
  const visitedDirs = new Set<string>();
  const countedStreamerDirs = new Set<string>();
  const maxDepth = 8;
  const maxDirs = 12000;
  let visitedCount = 0;

  for (const root of roots) {
    const stack: Array<{
      dir: string;
      depth: number;
      platform?: string;
      streamer?: KnownLocalStreamer;
    }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && visitedCount < maxDirs) {
      const { dir, depth, platform, streamer } = stack.pop()!;
      const realDir = await fs.realpath(dir).catch(() => dir);
      const dirKey = normalizeLocalPath(realDir);
      if (visitedDirs.has(dirKey)) continue;
      visitedDirs.add(dirKey);
      visitedCount += 1;

      const dirName = path.basename(dir);
      const currentPlatform = normalizeDirectoryPlatform(dirName) ?? platform;
      const roomDirStreamer = parseRoomDirectoryName(dirName);
      const ownStreamer =
        roomDirStreamer && roomDirStreamer.roomId
          ? {
              ...roomDirStreamer,
              platform: currentPlatform ?? "bilibili",
            }
          : knownStreamerIndexes.matchDirectoryName(dirName, currentPlatform);
      const currentStreamer = ownStreamer ?? streamer;
      if (ownStreamer && !countedStreamerDirs.has(dirKey)) {
        countedStreamerDirs.add(dirKey);
        const key =
          getStreamerFilterKey(ownStreamer.roomId, ownStreamer.platform) ?? ownStreamer.roomId;
        const current = streamers.get(key);
        if (current) {
          if (!current.username || current.username === current.roomId) {
            current.username = ownStreamer.username;
          }
          current.localFolderCount += 1;
        } else {
          streamers.set(key, {
            ...ownStreamer,
            localSizeBytes: 0,
            localFolderCount: 1,
          });
        }
      }

      let entries: fs.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        if (!isDirectory && entry.isSymbolicLink()) {
          const stat = await fs.stat(fullPath).catch(() => null);
          isDirectory = !!stat?.isDirectory();
        }
        if (isDirectory) {
          if (depth < maxDepth) {
            stack.push({
              dir: fullPath,
              depth: depth + 1,
              platform: currentPlatform,
              streamer: currentStreamer,
            });
          }
          continue;
        }

        if (currentStreamer) {
          const stat = await fs.stat(fullPath).catch(() => null);
          if (stat?.isFile()) {
            const key =
              getStreamerFilterKey(currentStreamer.roomId, currentStreamer.platform) ??
              currentStreamer.roomId;
            const current = streamers.get(key);
            if (current) {
              current.localSizeBytes += stat.size;
            } else {
              streamers.set(key, {
                ...currentStreamer,
                localSizeBytes: stat.size,
                localFolderCount: 0,
              });
            }
          }
        }
      }
    }
  }

  return Array.from(streamers.values());
};

const listLocalUploadStreamers = async (): Promise<LocalUploadStreamerOption[]> => {
  const map = new Map<string, LocalUploadStreamerOption>();
  const knownStreamers = streamerService.list();
  for (const streamer of knownStreamers) {
    addLocalUploadStreamerOption(map, {
      roomId: streamer.room_id,
      platform: streamer.platform,
      name: streamer.name,
    });
  }

  const rootResult = await resolveScanRoots();
  const directoryStreamers = await scanStreamerDirsFromRoots(rootResult.roots, knownStreamers);
  for (const streamer of directoryStreamers) {
    addLocalUploadStreamerOption(map, {
      roomId: streamer.roomId,
      platform: streamer.platform,
      name: streamer.username,
      localSizeBytes: streamer.localSizeBytes,
      localFolderCount: streamer.localFolderCount,
    });
  }

  return Array.from(map.values()).sort((left, right) => {
    const sizeCompare = right.localSizeBytes - left.localSizeBytes;
    if (sizeCompare !== 0) return sizeCompare;
    const nameCompare = left.name.localeCompare(right.name, "zh-Hans-CN");
    if (nameCompare !== 0) return nameCompare;
    return left.roomId.localeCompare(right.roomId);
  });
};

const remotePartMatchesLocalGroup = (context: LocalFileContext, remotePart: RemoteVideoPart) => {
  const localIdentity = parseRecorderIdentity(context.localFile.fileName);
  const localRoomId = localIdentity?.roomId || context.roomId;
  const localDateKey = localIdentity?.date || formatDateKey(context.startTime);
  const liveDateKeys = buildLiveDateKeyCandidates(
    localDateKey,
    localIdentity?.startTime ?? context.startTime,
    localIdentity?.time,
  );
  const normalizedUsername = normalizeMatchText(context.username);
  const remoteArchiveTitle = normalizeMatchText(remotePart.archiveTitle);
  if (liveDateKeys.size === 0) return false;

  const { streamerSearchMatched } = getSearchSignals(
    remotePart.searchKeywords,
    [],
    normalizedUsername,
  );
  const archiveHasUser = !!normalizedUsername && remoteArchiveTitle.includes(normalizedUsername);
  const archiveHasDate = Array.from(liveDateKeys).some((dateKey) =>
    remoteArchiveTitle.includes(dateKey),
  );
  let hasSameStreamer = streamerSearchMatched || archiveHasUser;
  let hasSameDate = archiveHasDate;

  for (const value of remotePart.values) {
    if (Array.from(liveDateKeys).some((dateKey) => value.normalized.includes(dateKey))) {
      hasSameDate = true;
    }

    const remoteIdentity = parseRecorderIdentity(value.raw);
    if (!remoteIdentity) continue;

    if (liveDateKeys.has(remoteIdentity.date)) hasSameDate = true;
    if (localRoomId && remoteIdentity.roomId === localRoomId) hasSameStreamer = true;
  }

  return hasSameStreamer && hasSameDate;
};

const buildUnuploadedGroups = async (
  localFiles: LocalVideoFile[],
  matches: LocalUploadedFileMatch[],
  remoteParts: RemoteVideoPart[],
  options: { minTotalSizeBytes?: number } = {},
  progress?: LocalDetectProgressReporter,
): Promise<{ groups: LocalUnuploadedGroup[]; skippedSmallGroupCount: number }> => {
  const contexts = await buildLocalFileContexts(localFiles, matches, progress);
  const uploadStore = await readLocalDetectHistoryStore();
  cleanupLocalUploadQueueStore(uploadStore);
  const localUploadStatusByKey = new Map<string, LocalUploadQueueItem>();
  for (const item of uploadStore.localUploads) {
    localUploadStatusByKey.set(item.key, item);
  }
  for (const [key, item] of localUploadQueueItems) {
    if (Date.now() - item.updatedAt <= LOCAL_UPLOAD_QUEUE_TTL_MS) {
      localUploadStatusByKey.set(key, item);
    }
  }
  const grouped = new Map<string, LocalFileContext[]>();
  for (const context of contexts) {
    const list = grouped.get(context.groupKey) ?? [];
    list.push(context);
    grouped.set(context.groupKey, list);
  }

  const groups: LocalUnuploadedGroup[] = [];
  const minTotalSizeBytes = Math.max(0, options.minTotalSizeBytes ?? 0);
  let skippedSmallGroupCount = 0;
  for (const [groupKey, groupContexts] of grouped) {
    const unuploaded = groupContexts
      .filter((item) => !item.match)
      .sort((left, right) => left.startTime - right.startTime);
    if (unuploaded.length === 0) continue;

    const first = unuploaded[0];
    const aidMap = new Map<number, LocalUploadedFileMatch>();
    for (const context of groupContexts) {
      if (!context.match) continue;
      aidMap.set(context.match.aid, context.match);
    }
    let matchedAids = Array.from(aidMap.keys());
    let titleMatchedArchiveTitle: string | undefined;
    if (matchedAids.length === 0) {
      const titleAidMap = new Map<number, RemoteVideoPart>();
      for (const remotePart of remoteParts) {
        if (!unuploaded.some((context) => remotePartMatchesLocalGroup(context, remotePart))) {
          continue;
        }
        titleAidMap.set(remotePart.aid, remotePart);
      }
      matchedAids = Array.from(titleAidMap.keys());
      if (matchedAids.length === 1) {
        titleMatchedArchiveTitle = titleAidMap.get(matchedAids[0])?.archiveTitle;
      }
    }
    const suggestedAction =
      matchedAids.length === 0 ? "new" : matchedAids.length === 1 ? "append" : "ambiguous";
    const suggestedAid = suggestedAction === "append" ? matchedAids[0] : undefined;
    const matchedArchive = suggestedAid ? aidMap.get(suggestedAid) : undefined;
    const totalSize = unuploaded.reduce((sum, item) => sum + item.localFile.size, 0);
    if (minTotalSizeBytes > 0 && totalSize < minTotalSizeBytes) {
      skippedSmallGroupCount += 1;
      continue;
    }
    const danmuCount = unuploaded.filter((item) => item.danmuPath).length;
    const mergeCandidate =
      unuploaded.length > 1 &&
      unuploaded.every((item) => path.extname(item.localFile.fileName).toLowerCase() === ".flv");
    const groupHasWebhookConfig = hasWebhookUploadConfig(first.roomId);
    const warnings: string[] = [];
    if (!first.roomId) warnings.push("未从录制历史识别到房间号，无法复用 webhook 房间配置");
    if (suggestedAction === "ambiguous") {
      warnings.push("同组文件匹配到多个远端稿件，默认不会自动续传");
    }
    if (!groupHasWebhookConfig) {
      warnings.push("该房间未配置 webhook 上传账号或上传预设");
    }

    const files = unuploaded.map((item) => ({
      path: item.localFile.localPath,
      fileName: item.localFile.fileName,
      size: item.localFile.size,
      mtimeMs: item.localFile.mtimeMs,
      title: item.title,
      startTime: item.startTime,
      endTime: item.endTime,
      danmuPath: item.danmuPath,
      xmlDanmuPath: item.xmlDanmuPath,
      recordId: item.record?.id,
    }));
    const { key: uploadKey } = buildLocalUploadKey(files);
    const uploadStatus = localUploadStatusByKey.get(uploadKey);

    groups.push({
      id: uuid(),
      groupKey,
      uploadKey,
      uploadStatus: uploadStatus?.status,
      uploadQueuedAt: uploadStatus?.createdAt,
      uploadUpdatedAt: uploadStatus?.updatedAt,
      uploadError: uploadStatus?.error,
      roomId: first.roomId,
      platform: first.platform,
      username: first.username,
      title: first.title,
      startTime: first.startTime,
      endTime: unuploaded[unuploaded.length - 1].endTime,
      fileCount: unuploaded.length,
      totalSize,
      danmuCount,
      files,
      suggestedAction,
      suggestedAid,
      archiveTitle: matchedArchive?.archiveTitle || titleMatchedArchiveTitle,
      mergeCandidate,
      hasWebhookUploadConfig: groupHasWebhookConfig,
      warnings,
    });
  }

  progress?.({
    stage: "grouping",
    stageLabel: "识别未上传分组",
    total: localFiles.length,
    processed: localFiles.length,
    current: "未上传分组完成",
    message: `未上传分组识别完成：${groups.length} 组，大小过滤 ${skippedSmallGroupCount} 组`,
    log: `未上传分组识别完成：${groups.length} 组，大小过滤 ${skippedSmallGroupCount} 组`,
  });

  return {
    groups: groups.sort((left, right) => right.startTime - left.startTime),
    skippedSmallGroupCount,
  };
};

const runLocalUploadedFilesDetection = async (
  uid: number,
  options: LocalDetectOptions,
  progress?: LocalDetectProgressReporter,
): Promise<LocalUploadedFilesResult> => {
  const logs: string[] = [];
  const pushLog = (message: string, patch: LocalDetectProgressPatch = {}) => {
    logs.push(message);
    progress?.({
      message,
      ...patch,
      log: message,
    });
  };

  pushLog(
    `检测参数：稿件列表 ${options.pages} 页，每页 ${options.pageSize} 条，分P详情${
      options.useArchiveDetail ? `开启，间隔 ${options.detailIntervalMs}ms` : "关闭"
    }，未上传分组合计最小大小 ${options.minVideoSizeMb || 0} MB，主播筛选 ${
      options.selectedStreamers?.length ? `${options.selectedStreamers.length} 个` : "全部"
    }`,
    {
      stage: "prepare",
      stageLabel: "准备检测",
      total: 0,
      processed: 0,
      current: "检测参数",
    },
  );

  const rootResult = await resolveScanRoots(options.rootPath);
  pushLog(`扫描目录：${rootResult.roots.join("；") || "未找到可扫描目录"}`, {
    stage: "scan",
    stageLabel: "扫描本地视频",
    total: rootResult.roots.length,
    processed: 0,
    current: rootResult.roots.join("；") || "未找到可扫描目录",
  });
  const scanResult = await scanVideoFiles(rootResult.roots, progress);
  pushLog(
    `本地视频扫描完成：发现 ${scanResult.discoveredVideoCount} 个视频文件，进入匹配 ${scanResult.files.length} 个`,
    {
      stage: "scan",
      stageLabel: "扫描本地视频",
      total: rootResult.roots.length,
      processed: rootResult.roots.length,
      current: "本地扫描完成",
    },
  );
  if (scanResult.followedLinkDirectoryCount > 0) {
    pushLog(`软链接目录扫描：已跟随 ${scanResult.followedLinkDirectoryCount} 个目录链接`, {
      stage: "scan",
      stageLabel: "扫描本地视频",
      total: rootResult.roots.length,
      processed: rootResult.roots.length,
      current: "软链接目录",
    });
  }

  const selectedStreamers = normalizeSelectedStreamers(options.selectedStreamers);
  const filterResult = await filterLocalFilesBySelectedStreamers(
    scanResult.files,
    selectedStreamers,
    progress,
  );
  const validationResult = await detectInvalidMp4Files(filterResult.files, progress);
  const dedupeResult = dedupeLocalRecordingFiles(validationResult.files, progress);
  const localFiles = dedupeResult.files;
  const invalidMp4Files = validationResult.invalidMp4Files;
  const duplicateFiles = dedupeResult.duplicateFiles;
  if (selectedStreamers.length > 0) {
    pushLog(
      `主播筛选完成：选中 ${selectedStreamers.length} 个主播，保留 ${localFiles.length} 个本地视频，跳过 ${filterResult.skipped} 个`,
      {
        stage: "scan",
        stageLabel: "按主播筛选",
        total: scanResult.files.length,
        processed: scanResult.files.length,
        current: "主播筛选完成",
      },
    );
  }
  if (invalidMp4Files.length > 0) {
    pushLog(`无效 MP4 已排除：${invalidMp4Files.length} 个，可在“无效 MP4”页签确认删除`, {
      stage: "validate",
      stageLabel: "校验 MP4",
      total: filterResult.files.length,
      processed: filterResult.files.length,
      current: "无效 MP4",
    });
  }
  if (duplicateFiles.length > 0) {
    pushLog(`同场重复文件已折叠：${duplicateFiles.length} 个，不再参与匹配或上传`, {
      stage: "scan",
      stageLabel: "折叠同场文件",
      total: validationResult.files.length,
      processed: validationResult.files.length,
      current: "同场重复文件",
    });
  }

  const searchKeywords = buildArchiveSearchKeywords(localFiles);
  pushLog(`搜索关键词生成完成：${searchKeywords.length} 个，将按本地标题和主播名搜索投稿中心`, {
    stage: "search",
    stageLabel: "搜索稿件",
    total: searchKeywords.length,
    processed: 0,
    current: "搜索关键词",
  });
  const remoteResult = await collectRemoteVideoParts(
    uid,
    options.pages,
    options.pageSize,
    options.useArchiveDetail,
    options.detailIntervalMs,
    searchKeywords,
    progress,
  );

  const localMatchHints = buildLocalMatchHints(localFiles);
  const matches: LocalUploadedFileMatch[] = [];
  for (const [index, localFile] of localFiles.entries()) {
    progress?.({
      stage: "matching",
      stageLabel: "比对本地视频",
      total: localFiles.length,
      processed: index,
      current: localFile.localPath,
      message: `正在比对本地视频 ${formatProgressCount(index, localFiles.length)}：${localFile.fileName}`,
    });
    const hint = localMatchHints.get(normalizeLocalPath(localFile.localPath));
    let bestMatch:
      | {
          remotePart: RemoteVideoPart;
          match: LocalFileMatchResult;
        }
      | undefined;
    for (const remotePart of remoteResult.parts) {
      const match = matchLocalFile(localFile, remotePart, hint);
      if (!match) continue;
      if (!bestMatch || match.score > bestMatch.match.score) {
        bestMatch = { remotePart, match };
      }
    }
    if (bestMatch) {
      const { remotePart, match } = bestMatch;
      matches.push({
        localPath: localFile.localPath,
        fileName: localFile.fileName,
        root: localFile.root,
        size: localFile.size,
        mtimeMs: localFile.mtimeMs,
        aid: remotePart.aid,
        bvid: remotePart.bvid,
        cid: remotePart.cid,
        page: remotePart.page,
        archiveTitle: remotePart.archiveTitle,
        partTitle: remotePart.partTitle,
        remoteFilename: remotePart.remoteFilename,
        confidence: match.confidence,
        reason: match.reason,
      });
    }
    if (index === 0 || (index + 1) % 25 === 0 || index === localFiles.length - 1) {
      progress?.({
        stage: "matching",
        stageLabel: "比对本地视频",
        total: localFiles.length,
        processed: index + 1,
        current: localFile.localPath,
        message: `本地视频比对进度 ${formatProgressCount(index + 1, localFiles.length)}：${localFile.fileName}`,
        log: `本地视频比对 ${index + 1}/${localFiles.length}：${localFile.fileName}`,
      });
    } else {
      progress?.({
        stage: "matching",
        stageLabel: "比对本地视频",
        total: localFiles.length,
        processed: index + 1,
        current: localFile.localPath,
        message: `本地视频比对进度 ${formatProgressCount(index + 1, localFiles.length)}：${localFile.fileName}`,
      });
    }
  }

  pushLog(`本地视频比对完成：疑似已上传未删除 ${matches.length} 个`, {
    stage: "matching",
    stageLabel: "比对本地视频",
    total: localFiles.length,
    processed: localFiles.length,
    current: "本地视频比对完成",
  });

  const unuploadedResult = await buildUnuploadedGroups(
    localFiles,
    matches,
    remoteResult.parts,
    { minTotalSizeBytes: Math.max(0, options.minVideoSizeMb || 0) * 1024 * 1024 },
    progress,
  );
  const unuploadedGroups = unuploadedResult.groups;
  const resultLogs = [
    ...logs,
    ...remoteResult.logs,
    `B站稿件读取完成：${remoteResult.archiveCount} 个稿件，${remoteResult.parts.length} 个可匹配项`,
    selectedStreamers.length > 0
      ? `主播筛选：选中 ${selectedStreamers.length} 个主播，保留 ${localFiles.length} 个本地视频，跳过 ${filterResult.skipped} 个`
      : "",
    invalidMp4Files.length > 0
      ? `无效 MP4：${invalidMp4Files.length} 个，已从匹配和未上传分组中排除`
      : "",
    duplicateFiles.length > 0
      ? `同场重复：${duplicateFiles.length} 个，已从匹配和未上传分组中排除`
      : "",
    `比对完成：疑似已上传未删除 ${matches.length} 个，本地未上传 ${unuploadedGroups.length} 组，大小过滤 ${unuploadedResult.skippedSmallGroupCount} 组`,
  ].filter(Boolean);
  if (scanResult.truncated) {
    resultLogs.push(`本地视频数量达到扫描上限 ${MAX_SCAN_FILES}，结果可能不完整`);
  }

  progress?.({
    stage: "completed",
    stageLabel: "检测完成",
    total: 1,
    processed: 1,
    current: "检测完成",
    message: `检测完成：已上传未删除 ${matches.length} 个，无效 MP4 ${invalidMp4Files.length} 个，同场重复 ${duplicateFiles.length} 个，本地未上传 ${unuploadedGroups.length} 组`,
    log: `检测完成：已上传未删除 ${matches.length} 个，无效 MP4 ${invalidMp4Files.length} 个，同场重复 ${duplicateFiles.length} 个，本地未上传 ${unuploadedGroups.length} 组`,
  });

  const result: LocalUploadedFilesResult = {
    roots: rootResult.roots,
    scannedFileCount: localFiles.length,
    skippedSmallUnuploadedGroupCount: unuploadedResult.skippedSmallGroupCount,
    archiveCount: remoteResult.archiveCount,
    remotePartCount: remoteResult.parts.length,
    truncated: scanResult.truncated,
    matches,
    invalidMp4Files,
    duplicateFiles,
    unuploadedGroups,
    errors: [...rootResult.errors, ...scanResult.errors, ...remoteResult.errors],
    warnings: remoteResult.warnings,
    logs: resultLogs,
  };
  return saveLocalDetectHistory(uid, options, result);
};

// 验证视频上传参数
router.post("/validUploadParams", async (ctx) => {
  const params = ctx.request.body;
  // @ts-ignore
  const [status, msg] = await validateBiliupConfig(params);
  if (status) {
    ctx.body = "success";
    return;
  }
  ctx.body = msg;
  ctx.status = 400;
});

/**
 * 投稿中心视频列表
 */
router.get("/archives", async (ctx) => {
  const params = ctx.request.query as unknown as { pn: number; ps: number; uid: number };
  const { uid } = params;
  const data = await biliApi.getArchives(params, uid);
  ctx.body = data;
});

/**
 * 用户视频详情
 */
router.get("/user/archive/:bvid", async (ctx) => {
  const params = ctx.request.query as unknown as { uid: number };
  const { uid } = params;
  const { bvid } = ctx.params;
  const data = await biliApi.getArchiveDetail(bvid, uid);
  ctx.body = data;
});

router.post("/checkTag", async (ctx) => {
  const {
    tag,
    uid,
  }: {
    tag: string;
    uid: number;
  } = ctx.request.body;
  const data = await biliApi.checkTag(tag, uid);
  ctx.body = data;
});

router.get("/searchTopic", async (ctx) => {
  const { keyword, uid } = ctx.request.query as unknown as {
    keyword: string;
    uid: number;
  };
  const data = await biliApi.searchTopic(keyword, uid);
  ctx.body = data;
});

router.get("/seasons", async (ctx) => {
  const { uid } = ctx.request.query as unknown as { uid: number };
  const data = await biliApi.getSeasonList(uid);
  ctx.body = data;
});
router.get("/season/:aid", async (ctx) => {
  const { uid } = ctx.request.query as unknown as { uid: number };
  const { aid } = ctx.params;
  const data = await biliApi.getSessionId(Number(aid), uid);
  ctx.body = data;
});

router.get("/platformArchiveDetail", async (ctx) => {
  const { aid, uid } = ctx.request.query as unknown as { aid: number; uid: number };
  const data = await biliApi.getPlatformArchiveDetail(aid, uid);
  ctx.body = data;
});

router.get("/localUploadedFiles/streamers", async (ctx) => {
  ctx.body = {
    items: await listLocalUploadStreamers(),
  };
});

router.get("/localUploadedFiles", async (ctx) => {
  const query = ctx.request.query;
  const uid = queryNumber(query.uid, 0);
  if (!uid) {
    ctx.body = "uid required";
    ctx.status = 400;
    return;
  }

  const pages = queryBoundedNumber(query.pages, DEFAULT_ARCHIVE_PAGES, 1, 10);
  const pageSize = queryBoundedNumber(query.pageSize, 20, 1, 50);
  const rootPath = queryString(query.rootPath);
  const useArchiveDetail = queryBoolean(query.useArchiveDetail, true);
  const detailIntervalMs = queryBoundedNonNegativeNumber(
    query.detailIntervalMs,
    DEFAULT_DETAIL_INTERVAL_MS,
    0,
    10000,
  );
  const minVideoSizeMb = queryBoundedNonNegativeNumber(query.minVideoSizeMb, 0, 0, 1024 * 10);
  const selectedStreamers = querySelectedStreamers(query.selectedStreamers);
  ctx.body = await runLocalUploadedFilesDetection(uid, {
    pages,
    pageSize,
    rootPath,
    useArchiveDetail,
    detailIntervalMs,
    minVideoSizeMb,
    selectedStreamers,
  });
});

router.get("/localUploadedFiles/history", async (ctx) => {
  const uid = queryNumber(ctx.request.query.uid, 0);
  const store = await readLocalDetectHistoryStore();
  const items = store.histories
    .filter((item) => !uid || item.uid === uid)
    .map(summarizeLocalDetectHistory);
  ctx.body = {
    items,
    latest: items[0] ?? null,
  };
});

router.get("/localUploadedFiles/history/:id", async (ctx) => {
  const uid = queryNumber(ctx.request.query.uid, 0);
  const store = await readLocalDetectHistoryStore();
  const item = store.histories.find(
    (history) => history.id === ctx.params.id && (!uid || history.uid === uid),
  );
  if (!item) {
    ctx.body = "history not found";
    ctx.status = 404;
    return;
  }
  ctx.body = item;
});

router.get("/localUploadedFiles/deletions", async (ctx) => {
  const uid = queryNumber(ctx.request.query.uid, 0);
  const historyId = queryString(ctx.request.query.historyId);
  const limit = queryBoundedNumber(ctx.request.query.limit, 200, 1, LOCAL_DETECT_DELETION_LIMIT);
  const store = await readLocalDetectHistoryStore();
  ctx.body = {
    items: store.deletions
      .filter((item) => (!uid || item.uid === uid) && (!historyId || item.historyId === historyId))
      .slice(0, limit),
  };
});

router.post("/localUploadedFiles/deletions", async (ctx) => {
  const body = (ctx.request.body ?? {}) as {
    uid?: number;
    historyId?: string;
    items?: LocalDetectedDeletionItem[];
  };
  if (!Array.isArray(body.items) || body.items.length === 0) {
    ctx.body = "items required";
    ctx.status = 400;
    return;
  }
  const uid = queryNumber(body.uid, 0) || undefined;
  const records = await recordLocalUploadedFileDeletions({
    uid,
    historyId: body.historyId,
    items: body.items,
  });
  ctx.body = {
    items: records,
  };
});

router.post("/localUploadedFiles/detect", async (ctx) => {
  const body = (ctx.request.body ?? {}) as {
    uid?: number;
    rootPath?: string;
    pages?: number;
    pageSize?: number;
    useArchiveDetail?: boolean;
    detailIntervalMs?: number;
    minVideoSizeMb?: number;
    selectedStreamers?: SelectedLocalStreamer[];
  };
  const uid = queryNumber(body.uid, 0);
  if (!uid) {
    ctx.body = "uid required";
    ctx.status = 400;
    return;
  }

  cleanupLocalDetectJobs();
  const job = createLocalDetectProgress();
  localDetectJobs.set(job.id, job);
  const pages = queryBoundedNumber(body.pages, DEFAULT_ARCHIVE_PAGES, 1, 10);
  const pageSize = queryBoundedNumber(body.pageSize, 20, 1, 50);
  const rootPath = queryString(body.rootPath);
  const useArchiveDetail =
    typeof body.useArchiveDetail === "boolean" ? body.useArchiveDetail : true;
  const detailIntervalMs = queryBoundedNonNegativeNumber(
    body.detailIntervalMs,
    DEFAULT_DETAIL_INTERVAL_MS,
    0,
    10000,
  );
  const minVideoSizeMb = queryBoundedNonNegativeNumber(body.minVideoSizeMb, 0, 0, 1024 * 10);
  const selectedStreamers = querySelectedStreamers(body.selectedStreamers);

  void runLocalUploadedFilesDetection(
    uid,
    {
      pages,
      pageSize,
      rootPath,
      useArchiveDetail,
      detailIntervalMs,
      minVideoSizeMb,
      selectedStreamers,
    },
    (patch) => touchLocalDetectProgress(job, patch),
  )
    .then((result) => {
      job.status = "completed";
      job.result = result;
      job.completedAt = Date.now();
      touchLocalDetectProgress(job, {
        stage: "completed",
        stageLabel: "检测完成",
        total: 1,
        processed: 1,
        current: "检测完成",
        message: `检测完成：已上传未删除 ${result.matches.length} 个，无效 MP4 ${
          result.invalidMp4Files?.length ?? 0
        } 个，同场重复 ${result.duplicateFiles?.length ?? 0} 个，本地未上传 ${
          result.unuploadedGroups.length
        } 组`,
      });
    })
    .catch((error) => {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = Date.now();
      touchLocalDetectProgress(job, {
        stage: "error",
        stageLabel: "检测失败",
        current: "检测失败",
        message: job.error,
        log: `检测失败：${job.error}`,
      });
    });

  ctx.body = job;
});

router.get("/localUploadedFiles/detect/:id", async (ctx) => {
  cleanupLocalDetectJobs();
  const job = localDetectJobs.get(ctx.params.id);
  if (!job) {
    ctx.body = "detect job not found";
    ctx.status = 404;
    return;
  }
  ctx.body = job;
});

router.get("/uploadLocalUnuploaded/status", async (ctx) => {
  const rawKeys = Array.isArray(ctx.request.query.keys)
    ? ctx.request.query.keys.join(",")
    : String(ctx.request.query.keys ?? "");
  const keys = Array.from(
    new Set(
      rawKeys
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ).slice(0, 200);

  const items: Array<
    Omit<Partial<LocalUploadQueueItem>, "status"> & {
      key: string;
      status: LocalUploadQueueStatus | "missing";
    }
  > = [];
  for (const key of keys) {
    const item = await getLocalUploadQueueItem(key);
    if (!item) {
      items.push({ key, status: "missing" });
      continue;
    }
    items.push({
      key,
      roomId: item.roomId,
      platform: item.platform,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt,
      error: item.error,
    });
  }

  ctx.body = { items };
});

router.post("/uploadLocalUnuploaded", async (ctx) => {
  const data = ctx.request.body as {
    groups?: Array<
      Pick<
        LocalUploadOptions,
        | "roomId"
        | "platform"
        | "username"
        | "title"
        | "startTime"
        | "aid"
        | "files"
        | "burnDanmu"
        | "uploadRawWhenNoDanmu"
        | "mergeSegments"
      > & {
        uploadKey?: string;
        uploadMode?: "auto" | "new" | "append";
      }
    >;
    options?: {
      burnDanmu?: boolean;
      uploadRawWhenNoDanmu?: boolean;
      mergeSegments?: boolean;
    };
  };

  if (!data.groups?.length) {
    ctx.body = "groups required";
    ctx.status = 400;
    return;
  }

  const items: Array<{
    uploadKey?: string;
    roomId: string;
    title?: string;
    status: "queued" | "skipped";
    reason?: string;
  }> = [];

  for (const group of data.groups) {
    if (!group.roomId) {
      items.push({
        roomId: "",
        title: group.title,
        status: "skipped",
        reason: "missing roomId",
      });
      continue;
    }
    if (!group.files?.length) {
      items.push({
        roomId: group.roomId,
        title: group.title,
        status: "skipped",
        reason: "missing files",
      });
      continue;
    }

    const { key: uploadKey, filePaths } = buildLocalUploadKey(group.files);
    const existingUpload = await getLocalUploadQueueItem(uploadKey);
    const activeUpload = [existingUpload, localUploadQueueItems.get(uploadKey)].find((item) =>
      isActiveLocalUploadStatus(item?.status),
    );
    if (activeUpload) {
      items.push({
        uploadKey,
        roomId: group.roomId,
        title: group.title,
        status: "skipped",
        reason: `duplicate:${activeUpload.status}`,
      });
      continue;
    }

    const now = Date.now();
    await saveLocalUploadQueueItem({
      key: uploadKey,
      roomId: group.roomId,
      platform: group.platform,
      title: group.title,
      filePaths,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      error: undefined,
    });

    const uploadOptions: LocalUploadOptions = {
      roomId: group.roomId,
      platform: group.platform,
      username: group.username,
      title: group.title,
      startTime: group.startTime,
      aid: group.aid,
      uploadMode: group.uploadMode ?? "auto",
      burnDanmu: group.burnDanmu ?? data.options?.burnDanmu ?? false,
      uploadRawWhenNoDanmu:
        group.uploadRawWhenNoDanmu ?? data.options?.uploadRawWhenNoDanmu ?? true,
      mergeSegments: group.mergeSegments ?? data.options?.mergeSegments ?? false,
      files: group.files,
    };

    void (async () => {
      try {
        await updateLocalUploadQueueStatus(uploadKey, "running");
        await handler.uploadLocalFiles(uploadOptions);
        await updateLocalUploadQueueStatus(uploadKey, "completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("uploadLocalUnuploaded failed", error);
        await updateLocalUploadQueueStatus(uploadKey, "error", message).catch((updateError) => {
          console.error("updateLocalUploadQueueStatus failed", updateError);
        });
      }
    })();
    items.push({
      uploadKey,
      roomId: group.roomId,
      title: group.title,
      status: "queued",
    });
  }

  ctx.body = {
    status: "success",
    items,
  };
});

/**
 * 上传以及续传视频
 */
router.post("/upload", async (ctx) => {
  const data = ctx.request.body as {
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
      removeOriginAfterUploadCheck?: boolean;
    };
  };
  if (!data.uid) {
    ctx.body = "uid required";
    ctx.status = 400;
    return;
  }
  if (!data.videos || !data.videos.length) {
    ctx.body = "videos required ";
    ctx.status = 400;
    return;
  }
  if (!data.config) {
    ctx.body = "config required when upload video";
    ctx.status = 400;
    return;
  }

  if (data.vid) {
    const task = await biliApi.editMedia(data.vid as number, data.videos, data.config, data.uid, {
      afterUploadDeletAction: data.options?.removeOriginAfterUploadCheck
        ? "deleteAfterCheck"
        : "none",
    });
    ctx.body = {
      taskId: task.taskId,
    };
  } else {
    const task = await biliApi.addMedia(data.videos, data.config, data.uid, {
      afterUploadDeletAction: data.options?.removeOriginAfterUploadCheck
        ? "deleteAfterCheck"
        : "none",
    });
    ctx.body = {
      taskId: task.taskId,
    };
  }
});

// 登录相关
const loginObj: {
  [id: string]: {
    client: TvQrcodeLogin;
    res: string;
    status: "scan" | "completed" | "error";
    failReason: string;
  };
} = {};
router.post("/login", async (ctx) => {
  const tv = new TvQrcodeLogin();
  const id = uuid();
  loginObj[id] = {
    client: tv,
    res: "",
    status: "scan",
    failReason: "",
  };
  tv.on("error", (res) => {
    console.log("error", res);
    loginObj[id].res = JSON.stringify(res);
    loginObj[id].failReason = res.message;
    loginObj[id].status = "error";
  });
  tv.on("scan", (res) => {
    console.log("scan", res);
    loginObj[id].res = JSON.stringify(res);
    loginObj[id].status = "scan";
  });
  tv.on("completed", async (res) => {
    loginObj[id].res = JSON.stringify(res);
    loginObj[id].status = "completed";

    const data = res.data;
    await biliApi.addUser(data);
  });
  const url = await tv.login();

  ctx.body = {
    url,
    id,
  };
});

router.post("/login/cancel", async (ctx) => {
  const { id } = ctx.request.body;
  if (!id) {
    ctx.body = "id required";
    ctx.status = 400;
    return;
  }
  const loginInfo = loginObj[id];
  if (!loginInfo) {
    ctx.body = "login info not found";
    ctx.status = 400;
    return;
  }
  const tv = loginInfo.client;
  tv.interrupt();
  ctx.body = "success";
});

router.get("/login/poll", async (ctx) => {
  const { id } = ctx.request.query as unknown as { id: string };
  if (!id) {
    ctx.body = "id required";
    ctx.status = 400;
    return;
  }
  const loginInfo = loginObj[id];
  if (!loginInfo) {
    ctx.body = "login info not found";
    ctx.status = 400;
    return;
  }

  ctx.body = omit(loginInfo, ["client"]);
});

router.post("/formatTitle", async (ctx) => {
  const data = ctx.request.body as {
    template: string;
    options?: any;
  };
  const template = (data.template || "") as string;

  const title = formatTitle(data.options, template);
  ctx.body = title;
});

router.post("/formatPartTitle", async (ctx) => {
  const data = ctx.request.body as {
    template: string;
    options?: PartTitleFormatOptions;
  };
  const template = (data.template || "") as string;

  const title = formatPartTitle(
    data.options ?? {
      title: "标题",
      username: "主播名",
      time: new Date().toISOString(),
      roomId: 123456,
      filename: "文件名",
      index: 1,
    },
    template,
  );
  ctx.body = title;
});

router.post("/formatDesc", async (ctx) => {
  const data = ctx.request.body as {
    template: string;
    options?: any;
  };
  const template = (data.template || "") as string;

  const desc = formatDesc(
    data.options ?? {
      title: "标题",
      username: "主播名",
      time: new Date().toISOString(),
      roomId: 123456,
      filename: "文件名",
    },
    template,
  );
  ctx.body = desc;
});

export default router;
