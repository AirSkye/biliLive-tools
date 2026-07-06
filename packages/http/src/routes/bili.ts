import Router from "@koa/router";
import fs from "fs-extra";
import { omit } from "lodash-es";
import path from "node:path";

import { biliApi, validateBiliupConfig } from "@biliLive-tools/shared/task/bili.js";
import { parseMeta } from "@biliLive-tools/shared/task/video.js";
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
import { appConfig, handler } from "../index.js";
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
  archiveTitle: string;
  partTitle?: string;
  remoteFilename?: string;
  values: { label: string; normalized: string; allowFuzzy: boolean }[];
};

type LocalUploadedFileMatch = {
  localPath: string;
  fileName: string;
  root: string;
  size: number;
  mtimeMs: number;
  aid: number;
  bvid?: string;
  archiveTitle: string;
  partTitle?: string;
  remoteFilename?: string;
  confidence: "high" | "medium";
  reason: string;
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

const normalizeMatchText = (value?: string | null) => {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/i, "")
    .replace(/\s+/g, "")
    .replace(/[\[\]【】()（）{}<>《》「」『』._-]/g, "");
};

const formatDateKey = (timestamp?: number) => {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
};

const parseRecorderFileName = (stem: string): ParsedLocalMetadata => {
  const match = stem.match(/^录制-(\d+)-(\d{8})-(\d{6})(?:-\d+)?-(.+)$/);
  if (!match) return {};

  const [, roomId, date, time, title] = match;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  const startTime = new Date(year, month - 1, day, hour, minute, second).getTime();

  return {
    roomId,
    platform: "bilibili",
    title,
    startTime: Number.isFinite(startTime) ? startTime : undefined,
  };
};

const parseLocalMatchMetadata = (localFile: LocalVideoFile) => {
  const metadata = parseRecorderFileName(localFile.stem);
  const parentName = path.basename(path.dirname(localFile.localPath));
  const parentMatch = parentName.match(/^(\d+)-(.+)$/);
  const username = parentMatch?.[2];
  return {
    ...metadata,
    username: metadata.username || username,
    dateKey: formatDateKey(metadata.startTime),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const scanVideoFiles = async (roots: string[]) => {
  const files: LocalVideoFile[] = [];
  const errors: string[] = [];

  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0 && files.length < MAX_SCAN_FILES) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error) {
        errors.push(`读取目录失败：${current}`);
        continue;
      }

      for (const entry of entries) {
        const filePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(filePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;

        try {
          const stat = await fs.stat(filePath);
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
        } catch (error) {
          errors.push(`读取文件信息失败：${filePath}`);
        }

        if (files.length >= MAX_SCAN_FILES) break;
      }
    }
  }

  return { files, errors, truncated: files.length >= MAX_SCAN_FILES };
};

const collectRemoteVideoParts = async (
  uid: number,
  pages: number,
  pageSize: number,
  useArchiveDetail = false,
  detailIntervalMs = DEFAULT_DETAIL_INTERVAL_MS,
) => {
  const archives = new Map<number, any>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];

  for (let pn = 1; pn <= pages; pn++) {
    try {
      const data = await biliApi.getArchives({ pn, ps: pageSize }, uid);
      const pageItems = data?.arc_audits ?? [];
      logs.push(`已读取B站稿件列表第 ${pn} 页：${pageItems.length} 条`);
      for (const item of pageItems) {
        const aid = Number(item?.Archive?.aid);
        if (aid) archives.set(aid, item);
      }
      const total = Number(data?.page?.count ?? 0);
      if (total > 0 && pn * pageSize >= total) break;
    } catch (error) {
      errors.push(`获取稿件列表第 ${pn} 页失败`);
      logs.push(`获取B站稿件列表第 ${pn} 页失败，检测已停止继续拉取远端列表`);
      break;
    }
  }

  const parts: RemoteVideoPart[] = [];
  if (!useArchiveDetail) {
    logs.push("本轮使用稿件列表信息匹配，未请求稿件详情接口");
  } else {
    logs.push(`本轮启用稿件详情接口匹配，详情请求间隔 ${detailIntervalMs}ms`);
  }
  let consecutiveDetailFailures = 0;
  let skipArchiveDetail = false;
  let skippedDetailCount = 0;
  let detailRequestCount = 0;
  for (const [aid, item] of archives) {
    let detail: any | null = null;
    if (useArchiveDetail && !skipArchiveDetail) {
      try {
        if (detailRequestCount > 0 && detailIntervalMs > 0) {
          await sleep(detailIntervalMs);
        }
        detailRequestCount += 1;
        detail = await biliApi.getPlatformArchiveDetail(aid, uid);
        consecutiveDetailFailures = 0;
      } catch (error) {
        consecutiveDetailFailures += 1;
        warnings.push(`稿件详情接口不可用，已使用列表信息继续匹配：${aid}`);
        logs.push(`稿件 ${aid} 详情接口不可用，已使用列表信息继续匹配`);
        if (consecutiveDetailFailures >= DETAIL_FAILURE_LIMIT) {
          skipArchiveDetail = true;
          logs.push(
            `稿件详情接口连续失败 ${DETAIL_FAILURE_LIMIT} 次，本轮后续稿件改用列表信息匹配`,
          );
        }
      }
    } else {
      if (useArchiveDetail) skippedDetailCount += 1;
    }

    const archive = detail?.archive ?? item?.Archive ?? {};
    const videos = Array.isArray(detail?.videos)
      ? detail.videos
      : Array.isArray(item?.Videos)
        ? item.Videos
        : [];
    const archiveTitle = String(archive?.title ?? item?.Archive?.title ?? "");
    const bvid = archive?.bvid ?? item?.Archive?.bvid;
    const addPart = (video?: any) => {
      const remoteFilename = video?.filename ? path.basename(String(video.filename)) : undefined;
      const remoteFilenameStem = remoteFilename ? path.parse(remoteFilename).name : undefined;
      const partTitle = video?.title ? String(video.title) : undefined;
      const values = [
        { label: "分P文件名", value: remoteFilename, allowFuzzy: true },
        { label: "分P文件名", value: remoteFilenameStem, allowFuzzy: true },
        { label: "分P标题", value: partTitle, allowFuzzy: true },
        { label: "稿件标题", value: archiveTitle, allowFuzzy: archiveTitle.length >= 12 },
      ]
        .map((value) => ({
          label: value.label,
          normalized: normalizeMatchText(value.value),
          allowFuzzy: value.allowFuzzy,
        }))
        .filter((value) => value.normalized);

      parts.push({
        aid,
        bvid,
        archiveTitle,
        partTitle,
        remoteFilename,
        values,
      });
    };

    if (videos.length === 0) {
      addPart();
    } else {
      for (const video of videos) addPart(video);
    }
  }
  if (skippedDetailCount > 0) {
    warnings.push(`已跳过 ${skippedDetailCount} 个稿件详情请求，改用稿件列表信息匹配`);
  }

  return { parts, archiveCount: archives.size, errors, warnings, logs };
};

const matchLocalFile = (localFile: LocalVideoFile, remotePart: RemoteVideoPart) => {
  for (const value of remotePart.values) {
    if (localFile.normalizedBase && localFile.normalizedBase === value.normalized) {
      return { confidence: "high" as const, reason: `文件名匹配 ${value.label}` };
    }
    if (localFile.normalizedStem && localFile.normalizedStem === value.normalized) {
      return { confidence: "high" as const, reason: `文件名主干匹配 ${value.label}` };
    }
  }

  if (localFile.normalizedStem.length < 8) return null;
  for (const value of remotePart.values) {
    if (!value.allowFuzzy || value.normalized.length < 8) continue;
    if (
      value.normalized.includes(localFile.normalizedStem) ||
      localFile.normalizedStem.includes(value.normalized)
    ) {
      return { confidence: "medium" as const, reason: `疑似包含匹配 ${value.label}` };
    }
  }

  const localMetadata = parseLocalMatchMetadata(localFile);
  const localTitle = normalizeMatchText(localMetadata.title);
  const localUsername = normalizeMatchText(localMetadata.username);
  const archiveTitle = normalizeMatchText(remotePart.archiveTitle);
  if (localTitle.length >= 6 && archiveTitle.includes(localTitle)) {
    const hasUserSignal = !!localUsername && archiveTitle.includes(localUsername);
    const hasDateSignal = !!localMetadata.dateKey && archiveTitle.includes(localMetadata.dateKey);
    if (hasUserSignal || hasDateSignal || localTitle.length >= 10) {
      return {
        confidence: hasUserSignal || hasDateSignal ? ("high" as const) : ("medium" as const),
        reason: `录制标题匹配稿件标题${hasUserSignal ? "，主播一致" : ""}${
          hasDateSignal ? "，日期一致" : ""
        }`,
      };
    }
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

  try {
    const danmaFilePath = danmuFiles.xmlDanmuPath || danmuFiles.danmuPath;
    const shouldReadVideoMeta = !fromName.roomId && !danmaFilePath;
    const meta = await parseMeta({
      videoFilePath: shouldReadVideoMeta ? localFile.localPath : undefined,
      danmaFilePath,
    });

    return {
      roomId: meta.roomId || fromName.roomId,
      platform: meta.platform && meta.platform !== "unknown" ? meta.platform : fromName.platform,
      username: meta.username || fromName.username,
      title: meta.title || fromName.title,
      startTime: meta.startTimestamp ? meta.startTimestamp * 1000 : fromName.startTime,
    };
  } catch {
    return fromName;
  }
};

const buildLocalFileContexts = async (
  localFiles: LocalVideoFile[],
  matches: LocalUploadedFileMatch[],
) => {
  const recordLookup = buildRecordLookup();
  const matchMap = new Map(matches.map((item) => [normalizeLocalPath(item.localPath), item]));
  const streamerByRoomId = new Map<string, Streamer>();
  for (const streamer of streamerService.list()) {
    streamerByRoomId.set(streamer.room_id, streamer);
  }
  const contexts: LocalFileContext[] = [];

  for (const localFile of localFiles) {
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
    const groupKey =
      roomId
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
  }

  return contexts;
};

const hasWebhookUploadConfig = (roomId?: string) => {
  try {
    const config = handler.configManager.getConfig(roomId || DEFAULT_WEBHOOK_ROOM_ID);
    return !!config.uid && !!config.uploadPresetId;
  } catch {
    return false;
  }
};

const buildUnuploadedGroups = async (
  localFiles: LocalVideoFile[],
  matches: LocalUploadedFileMatch[],
  remoteParts: RemoteVideoPart[],
): Promise<LocalUnuploadedGroup[]> => {
  const contexts = await buildLocalFileContexts(localFiles, matches);
  const grouped = new Map<string, LocalFileContext[]>();
  for (const context of contexts) {
    const list = grouped.get(context.groupKey) ?? [];
    list.push(context);
    grouped.set(context.groupKey, list);
  }

  const groups: LocalUnuploadedGroup[] = [];
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
      const normalizedGroupTitle = normalizeMatchText(first.title);
      const titleAidMap = new Map<number, RemoteVideoPart>();
      for (const remotePart of remoteParts) {
        if (!normalizedGroupTitle) continue;
        if (normalizeMatchText(remotePart.archiveTitle) !== normalizedGroupTitle) continue;
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

    groups.push({
      id: uuid(),
      groupKey,
      roomId: first.roomId,
      platform: first.platform,
      username: first.username,
      title: first.title,
      startTime: first.startTime,
      endTime: unuploaded[unuploaded.length - 1].endTime,
      fileCount: unuploaded.length,
      totalSize,
      danmuCount,
      files: unuploaded.map((item) => ({
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
      })),
      suggestedAction,
      suggestedAid,
      archiveTitle: matchedArchive?.archiveTitle || titleMatchedArchiveTitle,
      mergeCandidate,
      hasWebhookUploadConfig: groupHasWebhookConfig,
      warnings,
    });
  }

  return groups.sort((left, right) => right.startTime - left.startTime);
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
  const useArchiveDetail = queryBoolean(query.useArchiveDetail, false);
  const detailIntervalMs = queryBoundedNumber(
    query.detailIntervalMs,
    DEFAULT_DETAIL_INTERVAL_MS,
    0,
    10000,
  );
  const rootResult = await resolveScanRoots(rootPath);
  const scanResult = await scanVideoFiles(rootResult.roots);
  const remoteResult = await collectRemoteVideoParts(
    uid,
    pages,
    pageSize,
    useArchiveDetail,
    detailIntervalMs,
  );
  const matches: LocalUploadedFileMatch[] = [];

  for (const localFile of scanResult.files) {
    for (const remotePart of remoteResult.parts) {
      const match = matchLocalFile(localFile, remotePart);
      if (!match) continue;
      matches.push({
        localPath: localFile.localPath,
        fileName: localFile.fileName,
        root: localFile.root,
        size: localFile.size,
        mtimeMs: localFile.mtimeMs,
        aid: remotePart.aid,
        bvid: remotePart.bvid,
        archiveTitle: remotePart.archiveTitle,
        partTitle: remotePart.partTitle,
        remoteFilename: remotePart.remoteFilename,
        confidence: match.confidence,
        reason: match.reason,
      });
      break;
    }
  }
  const unuploadedGroups = await buildUnuploadedGroups(
    scanResult.files,
    matches,
    remoteResult.parts,
  );
  const logs = [
    `检测参数：稿件列表 ${pages} 页，每页 ${pageSize} 条，分P详情${
      useArchiveDetail ? `开启，间隔 ${detailIntervalMs}ms` : "关闭"
    }`,
    `扫描目录：${rootResult.roots.join("；") || "未找到可扫描目录"}`,
    `本地视频扫描完成：${scanResult.files.length} 个视频文件`,
    ...remoteResult.logs,
    `B站稿件读取完成：${remoteResult.archiveCount} 个稿件，${remoteResult.parts.length} 个可匹配项`,
    `比对完成：疑似已上传未删除 ${matches.length} 个，本地未上传 ${unuploadedGroups.length} 组`,
  ];
  if (scanResult.truncated) {
    logs.push(`本地视频数量达到扫描上限 ${MAX_SCAN_FILES}，结果可能不完整`);
  }

  ctx.body = {
    roots: rootResult.roots,
    scannedFileCount: scanResult.files.length,
    archiveCount: remoteResult.archiveCount,
    remotePartCount: remoteResult.parts.length,
    truncated: scanResult.truncated,
    matches,
    unuploadedGroups,
    errors: [...rootResult.errors, ...scanResult.errors, ...remoteResult.errors],
    warnings: remoteResult.warnings,
    logs,
  };
});

router.post("/uploadLocalUnuploaded", async (ctx) => {
  const data = ctx.request.body as {
    groups?: Array<
      Pick<
        LocalUploadOptions,
        "roomId" | "platform" | "username" | "title" | "startTime" | "aid" | "files"
      > & {
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

    const uploadOptions: LocalUploadOptions = {
      roomId: group.roomId,
      platform: group.platform,
      username: group.username,
      title: group.title,
      startTime: group.startTime,
      aid: group.aid,
      uploadMode: group.uploadMode ?? "auto",
      burnDanmu: data.options?.burnDanmu ?? false,
      uploadRawWhenNoDanmu: data.options?.uploadRawWhenNoDanmu ?? true,
      mergeSegments: data.options?.mergeSegments ?? false,
      files: group.files,
    };

    handler.uploadLocalFiles(uploadOptions).catch((error) => {
      console.error("uploadLocalUnuploaded failed", error);
    });
    items.push({
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
