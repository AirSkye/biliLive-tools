import { TypedEmitter } from "tiny-typed-emitter";
import fs from "fs-extra";
import path from "node:path";
import biliApi from "./bili.js";
import log from "../utils/log.js";
import { retryWithAxiosError, trashItem } from "../utils/index.js";

import type { AppConfig } from "../config.js";
import type { GlobalConfig } from "@biliLive-tools/types";

const DEFAULT_ARCHIVE_CHECK_PAGES = 5;
const ARCHIVE_CHECK_PAGE_SIZE = 20;

export type Item = {
  aid: number;
  state: number;
  title: string;
  state_desc: string;
};

interface Events {
  update: (aid: number, status: "completed" | "error", data: Item) => void;
}

type QueueItem = {
  uid: number;
  aid: number;
  startTime: number;
  status: "pending" | "completed" | "error";
  removePaths?: string[];
  runtimeCleanupActive?: boolean;
  runtimeCleanupPaths?: string[];
};

export default class BiliCheckQueue extends TypedEmitter<Events> {
  list: QueueItem[] = [];
  appConfig: AppConfig;
  private persistenceFile?: string;
  constructor({
    appConfig,
    globalConfig,
  }: {
    appConfig: AppConfig;
    globalConfig?: GlobalConfig;
  }) {
    super();
    this.list = [];
    this.appConfig = appConfig;
    if (globalConfig?.userDataPath) {
      this.persistenceFile = path.join(globalConfig.userDataPath, "biliCheckQueue.json");
      this.restorePersistedQueue();
    }
  }
  add(data: { aid: number; uid: number; removePaths?: string[]; runtimeCleanupActive?: boolean }) {
    const removePaths = data.removePaths?.length
      ? Array.from(new Set(data.removePaths.filter(Boolean)))
      : undefined;
    const existing = this.list.find((item) => item.aid === data.aid);
    if (existing) {
      if (removePaths?.length) {
        existing.removePaths = Array.from(
          new Set([...(existing.removePaths ?? []), ...removePaths]),
        );
        if (data.runtimeCleanupActive) {
          existing.runtimeCleanupPaths = Array.from(
            new Set([...(existing.runtimeCleanupPaths ?? []), ...removePaths]),
          );
        }
      }
      existing.startTime = Date.now();
      existing.runtimeCleanupActive = existing.runtimeCleanupActive || data.runtimeCleanupActive;
      this.persist();
      return;
    }
    this.list.push({
      uid: data.uid,
      aid: data.aid,
      startTime: Date.now(),
      status: "pending",
      removePaths,
      runtimeCleanupActive: data.runtimeCleanupActive,
      runtimeCleanupPaths:
        data.runtimeCleanupActive && removePaths?.length ? [...removePaths] : undefined,
    });
    this.persist();
  }
  private restorePersistedQueue() {
    if (!this.persistenceFile || !fs.pathExistsSync(this.persistenceFile)) return;
    try {
      const data = fs.readJsonSync(this.persistenceFile) as {
        version?: number;
        list?: QueueItem[];
      };
      const now = Date.now();
      this.list = (Array.isArray(data?.list) ? data.list : [])
        .filter((item) => {
          return item?.status === "pending" && now - item.startTime < 1000 * 60 * 60 * 24;
        })
        .map((item) => ({
          uid: item.uid,
          aid: item.aid,
          startTime: item.startTime,
          status: item.status,
          removePaths: item.removePaths?.length
            ? Array.from(new Set(item.removePaths.filter(Boolean)))
            : undefined,
        }));
    } catch (error) {
      log.error("恢复稿件审核队列失败", error);
      this.list = [];
    }
  }
  private persist() {
    if (!this.persistenceFile) return;
    try {
      fs.ensureDirSync(path.dirname(this.persistenceFile));
      fs.writeJsonSync(
        this.persistenceFile,
        {
          version: 1,
          list: this.list
            .filter((item) => item.status === "pending")
            .map((item) => ({
              uid: item.uid,
              aid: item.aid,
              startTime: item.startTime,
              status: item.status,
              removePaths: item.removePaths,
            })),
        },
        { spaces: 2 },
      );
    } catch (error) {
      log.error("保存稿件审核队列失败", error);
    }
  }
  private getArchiveCheckPages() {
    const biliUploadConfig = this.appConfig?.data?.biliUpload as
      | { checkPageCount?: number }
      | undefined;
    const configured = Number(biliUploadConfig?.checkPageCount);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_ARCHIVE_CHECK_PAGES;
    return Math.min(Math.floor(configured), 20);
  }
  private async runPersistedCompletedCleanup(item: QueueItem) {
    if (!item.removePaths?.length) return;

    const runtimeCleanupPaths = new Set(
      item.runtimeCleanupPaths ??
        (item.runtimeCleanupActive ? item.removePaths : []),
    );
    for (const filePath of item.removePaths) {
      if (runtimeCleanupPaths.has(filePath)) continue;
      try {
        await trashItem(filePath);
        log.info(`审核通过后删除文件成功: ${filePath}`);
      } catch (error) {
        log.error(`审核通过后删除文件失败: ${filePath}`, error);
      }
    }
  }
  /**
   * 过滤出通过审核的稿件
   */
  async check() {
    this.list = this.list.filter((item) => {
      const now = Date.now();
      return now - item.startTime < 1000 * 60 * 60 * 24;
    });
    this.persist();

    const uids = new Set(this.list.map((item) => item.uid));
    const mediaList: Item[] = [];
    // 先找一下前几页内容；一天上传较多时，待审核稿件可能很快掉出第一页。
    const archiveCheckPages = this.getArchiveCheckPages();
    for (const uid of uids) {
      for (let pn = 1; pn <= archiveCheckPages; pn++) {
        try {
          const res = await retryWithAxiosError(() =>
            biliApi.getArchives({ pn, ps: ARCHIVE_CHECK_PAGE_SIZE }, uid),
          );
          const pageItems = res.arc_audits ?? [];
          for (const media of pageItems) {
            if (media.Archive.aid) {
              mediaList.push({
                aid: media.Archive.aid,
                state: media.Archive.state,
                title: media.Archive.title,
                state_desc: media.Archive.state_desc ?? "",
              });
            }
          }
          const total = Number(res?.page?.count ?? 0);
          if (pageItems.length < ARCHIVE_CHECK_PAGE_SIZE) break;
          if (total > 0 && pn * ARCHIVE_CHECK_PAGE_SIZE >= total) break;
        } catch (error) {
          log.error(`查询稿件列表第 ${pn} 页失败`, error);
          break;
        }
      }
    }
    // 如果没有找到，那就根据详情页查询
    const detailQueryFailedAids = new Set<number>();
    for (const item of this.list) {
      if (mediaList.some((media) => media.aid === item.aid)) continue;
      try {
        const media = await retryWithAxiosError(() =>
          biliApi.getPlatformArchiveDetail(item.aid, item.uid),
        );
        mediaList.push({
          aid: item.aid,
          state: media.archive.state,
          title: media.archive.title,
          state_desc: media.archive.state_desc,
        });
      } catch (e) {
        log.error("查询稿件详情失败", e);
        detailQueryFailedAids.add(item.aid);
      }
    }

    for (const item of this.list) {
      const media = mediaList.find((media) => media.aid === item.aid);
      if (!media) {
        if (detailQueryFailedAids.has(item.aid)) {
          log.warn("稿件详情查询失败，保留审核队列等待下次检查", item);
          continue;
        }
        // 经过两次查询还未找到，那大概是稿件不存在，为用户主动删除，不要触发状态变更并进行通知
        log.error("未找到稿件", item);
        item.status = "error";
        continue;
      }

      if (media.state === 0) {
        // 通过审核
        item.status = "completed";
        this.emit("update", media.aid, "completed", media);
        await this.runPersistedCompletedCleanup(item);
      } else if (media.state < 0) {
        if (
          media.state === -30 ||
          media.state === -6 ||
          media.state === -60 ||
          media.state === -1
        ) {
          // 审核中，不要干啥操作
          // TODO: 如果是复核中状态也不要操作啥，但我也不知道状态码是什么
          continue;
        } else if (media.state === -50 || media.state === -40) {
          // -50: 仅自己可见 -40: 通过审核，等待发布 ，不需要触发错误
          item.status = "completed";
          this.emit("update", media.aid, "completed", media);
          await this.runPersistedCompletedCleanup(item);
        } else {
          item.status = "error";
          this.emit("update", media.aid, "error", media);
        }
      } else {
        this.emit("update", media.aid, "error", media);
        log.warn("稿件状态未检测成功", media);
      }
    }

    this.list = this.list.filter((item) => item.status === "pending");
    this.persist();
  }

  checkLoop = async () => {
    try {
      await this.check();
    } finally {
      const interval = this.appConfig?.data?.biliUpload?.checkInterval ?? 600;
      setTimeout(this.checkLoop, interval * 1000);
    }
  };
}
