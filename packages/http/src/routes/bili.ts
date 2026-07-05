import Router from "@koa/router";
import fs from "fs-extra";
import { omit } from "lodash-es";
import path from "node:path";

import { biliApi, validateBiliupConfig } from "@biliLive-tools/shared/task/bili.js";
import { TvQrcodeLogin } from "@renmu/bili-api";
import {
  formatTitle,
  formatPartTitle,
  formatDesc,
  uuid,
} from "@biliLive-tools/shared/utils/index.js";
import type { BiliupConfig, PartTitleFormatOptions } from "@biliLive-tools/types";
import { appConfig } from "../index.js";

const router = new Router({
  prefix: "/bili",
});

const VIDEO_EXTENSIONS = new Set([".mp4", ".flv", ".ts", ".mkv", ".webm", ".m4v", ".mov"]);
const MAX_SCAN_FILES = 20000;

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

const getQueryValue = (value: unknown) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const queryNumber = (value: unknown, fallback: number) => {
  const parsed = Number(getQueryValue(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const queryString = (value: unknown) => {
  const data = getQueryValue(value);
  return typeof data === "string" && data.trim() ? data.trim() : undefined;
};

const normalizeMatchText = (value?: string | null) => {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/i, "")
    .replace(/\s+/g, "")
    .replace(/[\[\]【】()（）{}<>《》「」『』._-]/g, "");
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

const collectRemoteVideoParts = async (uid: number, pages: number, pageSize: number) => {
  const archives = new Map<number, any>();
  const errors: string[] = [];

  for (let pn = 1; pn <= pages; pn++) {
    try {
      const data = await biliApi.getArchives({ pn, ps: pageSize }, uid);
      for (const item of data?.arc_audits ?? []) {
        const aid = Number(item?.Archive?.aid);
        if (aid) archives.set(aid, item);
      }
      const total = Number(data?.page?.count ?? 0);
      if (total > 0 && pn * pageSize >= total) break;
    } catch (error) {
      errors.push(`获取稿件列表第 ${pn} 页失败`);
      break;
    }
  }

  const parts: RemoteVideoPart[] = [];
  for (const [aid, item] of archives) {
    let detail: any | null = null;
    try {
      detail = await biliApi.getPlatformArchiveDetail(aid, uid);
    } catch (error) {
      errors.push(`获取稿件详情失败：${aid}`);
    }

    const archive = detail?.archive ?? item?.Archive ?? {};
    const videos = Array.isArray(detail?.videos) ? detail.videos : [];
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

  return { parts, archiveCount: archives.size, errors };
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

  return null;
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

  const pages = Math.min(queryNumber(query.pages, 3), 10);
  const pageSize = Math.min(queryNumber(query.pageSize, 20), 50);
  const rootPath = queryString(query.rootPath);
  const rootResult = await resolveScanRoots(rootPath);
  const scanResult = await scanVideoFiles(rootResult.roots);
  const remoteResult = await collectRemoteVideoParts(uid, pages, pageSize);
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

  ctx.body = {
    roots: rootResult.roots,
    scannedFileCount: scanResult.files.length,
    archiveCount: remoteResult.archiveCount,
    remotePartCount: remoteResult.parts.length,
    truncated: scanResult.truncated,
    matches,
    errors: [...rootResult.errors, ...scanResult.errors, ...remoteResult.errors],
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
