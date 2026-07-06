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

const trimGeneratedVideoSuffix = (value?: string | null) => {
  return path
    .parse(String(value ?? ""))
    .name.replace(/-弹幕版[\da-f-]*$/i, "")
    .replace(/-后处理$/i, "")
    .replace(/-合并$/i, "");
};

const parseRecorderIdentity = (value?: string | null): ParsedRecorderIdentity | null => {
  const stem = trimGeneratedVideoSuffix(value);
  const recordMatch = stem.match(/^录制-(\d+)-(\d{8})-(\d{6})(?:-\d+)?-(.+)$/);
  const compactMatch = stem.match(/^(\d{8})-(\d{6})(?:-\d+)?-(.+)$/);
  const readableMatch = stem.match(
    /^(\d{4})-(\d{2})-(\d{2})[\sT_-]+(\d{2})[-:](\d{2})[-:](\d{2})(?:[-_.]\d+)?[\s_-]+(.+)$/,
  );

  let roomId: string | undefined;
  let date: string;
  let time: string;
  let title: string;
  if (recordMatch) {
    [, roomId, date, time, title] = recordMatch;
  } else if (compactMatch) {
    [, date, time, title] = compactMatch;
  } else if (readableMatch) {
    const [, year, month, day, hour, minute, second, text] = readableMatch;
    date = `${year}${month}${day}`;
    time = `${hour}${minute}${second}`;
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
    title,
    startTime: Number.isFinite(startTime) ? startTime : undefined,
  };
};

const normalizePartIdentity = (value?: string | null) => {
  const recorderIdentity = parseRecorderIdentity(value);
  if (recorderIdentity) {
    const roomSegment = recorderIdentity.roomId ? `${recorderIdentity.roomId}-` : "";
    return normalizeMatchText(
      `录制-${roomSegment}${recorderIdentity.date}-${recorderIdentity.time}-${recorderIdentity.title}`,
    );
  }
  const normalized = normalizeMatchText(value)
    .replace(/弹幕版[\da-f]*$/i, "")
    .replace(/后处理$/i, "")
    .replace(/合并$/i, "");
  return normalized;
};

const recorderIdentitiesMatch = (
  left: ParsedRecorderIdentity,
  right: ParsedRecorderIdentity,
  { requireTime }: { requireTime: boolean },
) => {
  const sameDate = left.date === right.date;
  const sameTime = !requireTime || left.time === right.time;
  const sameTitle = normalizeMatchText(left.title) === normalizeMatchText(right.title);
  const sameRoom = !left.roomId || !right.roomId || left.roomId === right.roomId;
  return sameDate && sameTime && sameTitle && sameRoom;
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
  const identity = parseRecorderIdentity(stem);
  if (!identity) return {};

  return {
    roomId: identity.roomId,
    platform: "bilibili",
    title: identity.title,
    startTime: identity.startTime,
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
  searchKeywords: ArchiveSearchKeyword[] = [],
) => {
  const archives = new Map<number, RemoteArchiveItem>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];

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
      try {
        const data = await biliApi.getArchives({ pn, ps: pageSize }, uid);
        const pageItems = data?.arc_audits ?? [];
        logs.push(`已读取B站稿件列表第 ${pn} 页：${pageItems.length} 条`);
        for (const item of pageItems) {
          addArchive(item, `列表第 ${pn} 页`);
        }
        const total = Number(data?.page?.count ?? 0);
        if (total > 0 && pn * pageSize >= total) break;
      } catch (error) {
        errors.push(`获取稿件列表第 ${pn} 页失败`);
        logs.push(`获取B站稿件列表第 ${pn} 页失败，检测已停止继续拉取远端列表`);
        break;
      }
    }
  };

  const collectSearchArchives = async () => {
    if (searchKeywords.length === 0) return;
    const titleCount = searchKeywords.filter((item) => item.type === "title").length;
    const streamerCount = searchKeywords.filter((item) => item.type === "streamer").length;
    logs.push(
      `开始按本地标题/主播搜索稿件：标题 ${titleCount} 个，主播 ${streamerCount} 个，并发 ${ARCHIVE_SEARCH_CONCURRENCY}`,
    );

    const results: Array<{
      keyword: ArchiveSearchKeyword;
      pageItems?: any[];
      error?: unknown;
    }> = new Array(searchKeywords.length);
    await runLimited(searchKeywords, ARCHIVE_SEARCH_CONCURRENCY, async (keyword, index) => {
      try {
        const data = await biliApi.getArchives(
          { pn: 1, ps: 10, keyword: keyword.keyword } as any,
          uid,
        );
        results[index] = {
          keyword,
          pageItems: data?.arc_audits ?? [],
        };
      } catch (error) {
        results[index] = { keyword, error };
      }
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
      logs.push(`搜索结果合并完成：${dualSearchArchiveCount} 个稿件同时命中标题和主播搜索`);
    }
  };

  await Promise.all([collectPagedArchives(), collectSearchArchives()]);

  const parts: RemoteVideoPart[] = [];
  if (!useArchiveDetail) {
    logs.push("本轮使用稿件列表信息匹配，未请求稿件详情接口");
  } else {
    logs.push(`本轮启用稿件详情接口匹配，详情请求间隔 ${detailIntervalMs}ms`);
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
          logs.push(
            `搜索命中稿件私有详情尝试达到 ${SEARCH_PRIVATE_DETAIL_LIMIT} 个，后续改用公开/列表信息`,
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
  for (const [aid, archiveItem] of archives) {
    const item = archiveItem.item;
    let detail: any | null = null;
    let publicDetail: Awaited<ReturnType<typeof fetchPublicArchiveDetail>> | null = null;
    let privateDetailTried = false;
    const isSearchHit = archiveItem.searchKeywords.length > 0;
    if (useArchiveDetail) {
      if (isSearchHit) {
        logs.push(`稿件 ${aid} 来自搜索命中，优先尝试私有详情接口`);
        try {
          privateDetailTried = searchPrivateDetailAttempts < SEARCH_PRIVATE_DETAIL_LIMIT;
          detail = await fetchPrivateDetail(aid, true);
        } catch (error) {
          consecutivePrivateDetailFailures += 1;
          logs.push(`搜索命中稿件 ${aid} 私有详情不可用，继续尝试公开详情`);
          if (consecutivePrivateDetailFailures >= DETAIL_FAILURE_LIMIT) {
            skipPrivateDetail = true;
            logs.push(
              `私有稿件详情接口连续失败 ${DETAIL_FAILURE_LIMIT} 次，非搜索命中稿件将跳过私有兜底`,
            );
          }
        }
      }

      try {
        if (!detail) {
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
          logs.push(`稿件 ${aid} 公开详情和私有详情均不可用，无法做分P级匹配`);
        } else if (skipPrivateDetail) {
          skippedPrivateDetailCount += 1;
          logs.push(`稿件 ${aid} 公开分P信息不可用，私有详情已临时跳过`);
        } else {
          logs.push(`稿件 ${aid} 公开分P信息不可用，尝试私有详情接口`);
          try {
            detail = await fetchPrivateDetail(aid, false);
          } catch (error) {
            consecutivePrivateDetailFailures += 1;
            warnings.push(`稿件分P详情不可用，已使用列表信息继续判断未上传：${aid}`);
            logs.push(`稿件 ${aid} 私有详情接口不可用，无法做分P级匹配`);
            if (consecutivePrivateDetailFailures >= DETAIL_FAILURE_LIMIT) {
              skipPrivateDetail = true;
              logs.push(
                `私有稿件详情接口连续失败 ${DETAIL_FAILURE_LIMIT} 次，本轮后续仅在公开详情失败时跳过私有兜底`,
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
      const values = [
        { label: "分P文件名", value: remoteFilename },
        { label: "分P文件名", value: remoteFilenameStem },
        { label: "分P标题", value: partTitle },
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
        partTitle,
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
  }
  if (skippedPrivateDetailCount > 0) {
    warnings.push(`已跳过 ${skippedPrivateDetailCount} 个私有稿件详情请求，改用稿件列表信息匹配`);
  }
  if (useArchiveDetail) {
    logs.push(
      `分P详情读取完成：公开接口 ${publicDetailCount} 个，私有接口 ${privateDetailCount} 个`,
    );
  }

  return { parts, archiveCount: archives.size, errors, warnings, logs };
};

const matchLocalFile = (
  localFile: LocalVideoFile,
  remotePart: RemoteVideoPart,
  hint?: LocalMatchHint,
) => {
  const candidates: LocalFileMatchResult[] = [];
  const addCandidate = (
    score: number,
    confidence: LocalFileMatchResult["confidence"],
    reason: string,
  ) => {
    candidates.push({ score, confidence, reason });
  };
  const localBase = normalizePartIdentity(localFile.fileName);
  const localStem = normalizePartIdentity(localFile.stem);
  const localIdentities = [
    parseRecorderIdentity(localFile.fileName),
    parseRecorderIdentity(localFile.stem),
  ].filter((item): item is ParsedRecorderIdentity => !!item);
  for (const value of remotePart.values) {
    const remoteIdentity = parseRecorderIdentity(value.raw);
    if (
      remoteIdentity &&
      localIdentities.some((localIdentity) =>
        recorderIdentitiesMatch(localIdentity, remoteIdentity, { requireTime: true }),
      )
    ) {
      addCandidate(100, "high", `原始标题匹配 ${value.label}`);
    }
    if (localBase && localBase === value.normalized) {
      addCandidate(98, "high", `文件名匹配 ${value.label}`);
    }
    if (localStem && localStem === value.normalized) {
      addCandidate(96, "high", `文件名主干匹配 ${value.label}`);
    }
  }

  if (localStem.length >= 8) {
    for (const value of remotePart.values) {
      if (value.normalized.length < 8) continue;
      if (value.normalized.includes(localStem) || localStem.includes(value.normalized)) {
        addCandidate(50, "medium", `疑似包含匹配 ${value.label}`);
      }
    }
  }

  const archiveTitle = normalizeMatchText(remotePart.archiveTitle);
  const fallbackMetadata = hint ? null : parseLocalMatchMetadata(localFile);
  const normalizedTitle = hint?.normalizedTitle || normalizeMatchText(fallbackMetadata?.title);
  const normalizedTitleAliases = hint?.normalizedTitleAliases?.length
    ? hint.normalizedTitleAliases
    : [normalizedTitle].filter(Boolean);
  const normalizedUsername =
    hint?.normalizedUsername || normalizeMatchText(fallbackMetadata?.username);
  const dateKey = hint?.dateKey || fallbackMetadata?.dateKey;
  const { titleSearchMatched, streamerSearchMatched, dualSearchMatched } = getSearchSignals(
    remotePart.searchKeywords,
    normalizedTitleAliases,
    normalizedUsername,
  );
  const archiveHasTitle = normalizedTitleAliases.some(
    (title) => title.length >= 6 && archiveTitle.includes(title),
  );
  const archiveHasDate = !!dateKey && archiveTitle.includes(dateKey);
  const archiveHasUser = !!normalizedUsername && archiveTitle.includes(normalizedUsername);
  if (
    archiveHasTitle &&
    (titleSearchMatched || streamerSearchMatched || archiveHasDate || archiveHasUser)
  ) {
    const signals = [
      dualSearchMatched ? "标题+主播搜索同时命中" : "",
      !dualSearchMatched && titleSearchMatched ? "标题搜索命中" : "",
      !dualSearchMatched && streamerSearchMatched ? "主播搜索命中" : "",
      archiveHasUser ? "稿件标题含主播" : "",
      archiveHasDate ? "稿件标题含日期" : "",
    ].filter(Boolean);
    const hasStrongSignal =
      dualSearchMatched || streamerSearchMatched || archiveHasDate || archiveHasUser;
    addCandidate(
      dualSearchMatched ? 90 : hasStrongSignal ? 82 : 70,
      hasStrongSignal ? "high" : "medium",
      `稿件标题匹配（${signals.join("，")}）`,
    );
  }

  if (!archiveHasTitle && dualSearchMatched && (archiveHasDate || archiveHasUser)) {
    const signals = [
      "标题+主播搜索同时命中",
      archiveHasUser ? "稿件标题含主播" : "",
      archiveHasDate ? "稿件标题含日期" : "",
    ].filter(Boolean);
    addCandidate(72, "medium", `搜索结果匹配（${signals.join("，")}）`);
  }

  return candidates.sort((left, right) => right.score - left.score)[0] ?? null;
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

const archiveMatchesLocalGroup = (context: LocalFileContext, archiveTitle: string) => {
  const normalizedArchiveTitle = normalizeMatchText(archiveTitle);
  const normalizedTitle = normalizeMatchText(context.title);
  if (!normalizedTitle || !normalizedArchiveTitle.includes(normalizedTitle)) return false;

  const normalizedUsername = normalizeMatchText(context.username);
  const dateKey = formatDateKey(context.startTime);
  const hasUserSignal = !!normalizedUsername && normalizedArchiveTitle.includes(normalizedUsername);
  const hasDateSignal = !!dateKey && normalizedArchiveTitle.includes(dateKey);
  return hasUserSignal || hasDateSignal || normalizedTitle.length >= 10;
};

const remotePartMatchesLocalGroup = (context: LocalFileContext, remotePart: RemoteVideoPart) => {
  const localIdentity = parseRecorderIdentity(context.localFile.fileName);
  const localTitle = normalizeMatchText(localIdentity?.title || context.title);
  const localTitleAliases = Array.from(
    new Set(
      [
        localTitle,
        normalizeMatchText(localIdentity?.title),
        normalizeMatchText(context.title),
        normalizeMatchText(context.localFile.stem),
      ].filter(Boolean),
    ),
  );
  const localRoomId = localIdentity?.roomId || context.roomId;
  const localDateKey = localIdentity?.date || formatDateKey(context.startTime);
  const normalizedUsername = normalizeMatchText(context.username);
  const remoteArchiveTitle = normalizeMatchText(remotePart.archiveTitle);
  const { titleSearchMatched, streamerSearchMatched, dualSearchMatched } = getSearchSignals(
    remotePart.searchKeywords,
    localTitleAliases,
    normalizedUsername,
  );
  const archiveHasTitle = localTitleAliases.some(
    (title) => title.length >= 6 && remoteArchiveTitle.includes(title),
  );
  const archiveHasUser = !!normalizedUsername && remoteArchiveTitle.includes(normalizedUsername);
  const archiveHasDate = !!localDateKey && remoteArchiveTitle.includes(localDateKey);
  if (dualSearchMatched && archiveHasTitle) {
    return true;
  }
  if (
    archiveHasTitle &&
    (titleSearchMatched || streamerSearchMatched) &&
    (archiveHasUser || archiveHasDate || localTitle.length >= 10)
  ) {
    return true;
  }

  for (const value of remotePart.values) {
    const remoteIdentity = parseRecorderIdentity(value.raw);
    if (!remoteIdentity) continue;

    if (
      localIdentity &&
      recorderIdentitiesMatch(localIdentity, remoteIdentity, { requireTime: false })
    ) {
      return true;
    }

    const sameRoom = !!localRoomId && remoteIdentity.roomId === localRoomId;
    const sameDate = !!localDateKey && remoteIdentity.date === localDateKey;
    const sameTitle = !!localTitle && normalizeMatchText(remoteIdentity.title) === localTitle;
    const roomCompatible = sameRoom || !remoteIdentity.roomId || localTitle.length >= 10;
    if (sameDate && sameTitle && roomCompatible) {
      return true;
    }
  }

  return archiveMatchesLocalGroup(context, remotePart.archiveTitle);
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
  const useArchiveDetail = queryBoolean(query.useArchiveDetail, true);
  const detailIntervalMs = queryBoundedNumber(
    query.detailIntervalMs,
    DEFAULT_DETAIL_INTERVAL_MS,
    0,
    10000,
  );
  const rootResult = await resolveScanRoots(rootPath);
  const scanResult = await scanVideoFiles(rootResult.roots);
  const searchKeywords = buildArchiveSearchKeywords(scanResult.files);
  const remoteResult = await collectRemoteVideoParts(
    uid,
    pages,
    pageSize,
    useArchiveDetail,
    detailIntervalMs,
    searchKeywords,
  );
  const localMatchHints = buildLocalMatchHints(scanResult.files);
  const matches: LocalUploadedFileMatch[] = [];

  for (const localFile of scanResult.files) {
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
  }
  const unuploadedGroups = await buildUnuploadedGroups(
    scanResult.files,
    matches,
    remoteResult.parts,
  );
  const logs = [
    `检测参数：稿件列表 ${pages} 页，每页 ${pageSize} 条，分P详情${
      useArchiveDetail ? `开启，间隔 ${detailIntervalMs}ms` : "关闭"
    }，搜索关键词 ${searchKeywords.length} 个`,
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
