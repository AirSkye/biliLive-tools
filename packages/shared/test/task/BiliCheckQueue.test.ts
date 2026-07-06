import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import BiliCheckQueue from "../../src/task/BiliCheckQueue.js";
import biliApi from "../../src/task/bili.js";
import * as utils from "../../src/utils/index.js";

import type { AppConfig } from "../../src/config.js";

vi.mock("./bili.js");
vi.mock("../../src/utils/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/utils/index.js")>();
  return {
    ...mod,
    trashItem: vi.fn(),
  };
});

describe("BiliCheckQueue", () => {
  let appConfig: AppConfig;
  let queue: BiliCheckQueue;

  beforeEach(() => {
    appConfig = { data: { biliUpload: { checkInterval: 600 } } } as AppConfig;
    queue = new BiliCheckQueue({ appConfig });
    vi.mocked(utils.trashItem).mockReset();
  });

  it("should add a new item to the list", () => {
    queue.add({ aid: 1, uid: 123 });
    expect(queue.list).toHaveLength(1);
    expect(queue.list[0]).toMatchObject({ aid: 1, uid: 123, status: "pending" });
  });

  it("should not add duplicate items to the list", () => {
    queue.add({ aid: 1, uid: 123 });
    queue.add({ aid: 1, uid: 123 });
    expect(queue.list).toHaveLength(1);
  });

  it("should merge cleanup paths when duplicate aid is queued again", () => {
    queue.add({
      aid: 1,
      uid: 123,
      removePaths: ["/path/to/source.flv"],
      runtimeCleanupActive: true,
    });
    queue.add({
      aid: 1,
      uid: 123,
      removePaths: ["/path/to/handled.mp4", "/path/to/source.flv"],
      runtimeCleanupActive: true,
    });

    expect(queue.list).toHaveLength(1);
    expect(queue.list[0].removePaths).toEqual([
      "/path/to/source.flv",
      "/path/to/handled.mp4",
    ]);
  });

  it("should persist pending items and restore them after restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-check-queue-"));
    try {
      const persistentQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      persistentQueue.add({
        aid: 1,
        uid: 123,
        removePaths: ["/path/to/source.flv"],
        runtimeCleanupActive: true,
      });

      const restoredQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });

      expect(restoredQueue.list).toHaveLength(1);
      expect(restoredQueue.list[0]).toMatchObject({
        aid: 1,
        uid: 123,
        status: "pending",
        removePaths: ["/path/to/source.flv"],
      });
      expect(restoredQueue.list[0].runtimeCleanupActive).toBeUndefined();
    } finally {
      await fs.remove(tempDir);
    }
  });

  it("should persist merged cleanup paths for duplicate aid", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-check-queue-"));
    try {
      const persistentQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      persistentQueue.add({
        aid: 1,
        uid: 123,
        removePaths: ["/path/to/source.flv"],
        runtimeCleanupActive: true,
      });
      persistentQueue.add({
        aid: 1,
        uid: 123,
        removePaths: ["/path/to/handled.mp4"],
        runtimeCleanupActive: true,
      });

      const restoredQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });

      expect(restoredQueue.list).toHaveLength(1);
      expect(restoredQueue.list[0].removePaths).toEqual([
        "/path/to/source.flv",
        "/path/to/handled.mp4",
      ]);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it("should still clean restored paths when duplicate aid adds runtime cleanup paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-check-queue-"));
    try {
      const persistentQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      persistentQueue.add({
        aid: 1,
        uid: 123,
        removePaths: ["/path/to/restored.flv"],
        runtimeCleanupActive: true,
      });

      const restoredQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      restoredQueue.add({
        aid: 1,
        uid: 123,
        removePaths: ["/path/to/runtime.mp4"],
        runtimeCleanupActive: true,
      });
      const media = {
        Archive: { aid: 1, state: 0, title: "测试", state_desc: "通过" },
        stat: { aid: 1 },
      };
      // @ts-ignore
      vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

      await restoredQueue.check();

      expect(utils.trashItem).toHaveBeenCalledWith("/path/to/restored.flv");
      expect(utils.trashItem).not.toHaveBeenCalledWith("/path/to/runtime.mp4");
    } finally {
      await fs.remove(tempDir);
    }
  });

  it("should remove completed items from persisted queue", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-check-queue-"));
    try {
      const persistentQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      persistentQueue.add({ aid: 1, uid: 123 });
      const media = {
        Archive: { aid: 1, state: 0, title: "测试", state_desc: "通过" },
        stat: { aid: 1 },
      };
      // @ts-ignore
      vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

      await persistentQueue.check();

      const persisted = await fs.readJson(path.join(tempDir, "biliCheckQueue.json"));
      expect(persisted.list).toEqual([]);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it("should run persisted cleanup paths after restart when media is completed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-check-queue-"));
    try {
      const persistentQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      persistentQueue.add({
        aid: 1,
        uid: 123,
        removePaths: ["/path/to/source.flv", "/path/to/handled.mp4"],
        runtimeCleanupActive: true,
      });
      const restoredQueue = new BiliCheckQueue({
        appConfig,
        globalConfig: { userDataPath: tempDir } as any,
      });
      const media = {
        Archive: { aid: 1, state: 0, title: "测试", state_desc: "通过" },
        stat: { aid: 1 },
      };
      // @ts-ignore
      vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

      await restoredQueue.check();

      expect(utils.trashItem).toHaveBeenCalledWith("/path/to/source.flv");
      expect(utils.trashItem).toHaveBeenCalledWith("/path/to/handled.mp4");
    } finally {
      await fs.remove(tempDir);
    }
  });

  it("should not run persisted cleanup while runtime cleanup callback is active", async () => {
    queue.add({
      aid: 1,
      uid: 123,
      removePaths: ["/path/to/source.flv"],
      runtimeCleanupActive: true,
    });
    const media = {
      Archive: { aid: 1, state: 0, title: "测试", state_desc: "通过" },
      stat: { aid: 1 },
    };
    // @ts-ignore
    vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

    await queue.check();

    expect(utils.trashItem).not.toHaveBeenCalled();
  });

  it("should filter out items older than 24 hours", async () => {
    const oldItem = {
      aid: 1,
      uid: 123,
      startTime: Date.now() - 1000 * 60 * 60 * 25,
      status: "pending",
    } as const;
    queue.list.push(oldItem);
    await queue.check();
    expect(queue.list).toHaveLength(0);
  });

  it("should update item status to completed if state is 0", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = {
      Archive: { aid: 1, state: 0, title: "测试", state_desc: "通过" },
      stat: { aid: 1 },
    };
    // @ts-ignore
    vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });
    queue.once("update", (aid, status, data) => {
      expect(aid).toBe(1);
      expect(status).toBe("completed");
      expect(data).toEqual(media.Archive);
    });
    await queue.check();
  });

  it("should update item status to error if state is negative and not -30 or -6", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = {
      Archive: { aid: 1, state: -1, title: "测试", state_desc: "未通过" },
      stat: { aid: 1 },
    };
    // @ts-ignore
    vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

    queue.once("update", (aid, status, data) => {
      expect(aid).toBe(1);
      expect(status).toBe("error");
      expect(data).toEqual(media.Archive);
    });
    await queue.check();
  });

  it("should not update item status if state is -30 or -6", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = {
      Archive: { aid: 1, state: -30, title: "测试", state_desc: "未通过" },
      stat: { aid: 1 },
    };
    // @ts-ignore
    vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

    await queue.check();

    expect(queue.list[0].status).toBe("pending");
  });

  it("should remove items with pending status after check", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = { Archive: { aid: 1, state: 0 }, stat: { aid: 1 } };
    // @ts-ignore
    vi.spyOn(biliApi, "getArchives").mockResolvedValue({ arc_audits: [media] });

    await queue.check();

    expect(queue.list).toHaveLength(0);
  });
  it("should first use getArchives", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = { Archive: { aid: 1, state: 0 }, stat: { aid: 1 } };

    const getArchivesSpy = vi
      .spyOn(biliApi, "getArchives")
      // @ts-ignore
      .mockResolvedValue({ arc_audits: [media] });
    const getPlatformArchiveDetailSpy = vi.spyOn(biliApi, "getPlatformArchiveDetail");

    await queue.check();

    expect(getArchivesSpy).toHaveBeenCalled();
    expect(getPlatformArchiveDetailSpy).not.toHaveBeenCalled();
  });
  it("should search later archive pages before falling back to detail", async () => {
    queue.add({ aid: 25, uid: 123 });
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      Archive: { aid: index + 1, state: 0 },
      stat: { aid: index + 1 },
    }));
    const targetMedia = {
      Archive: { aid: 25, state: 0, title: "测试", state_desc: "通过" },
      stat: { aid: 25 },
    };

    const getArchivesSpy = vi
      .spyOn(biliApi, "getArchives")
      // @ts-ignore
      .mockResolvedValueOnce({ arc_audits: firstPage, page: { count: 25 } })
      // @ts-ignore
      .mockResolvedValueOnce({ arc_audits: [targetMedia], page: { count: 25 } });
    const getPlatformArchiveDetailSpy = vi.spyOn(biliApi, "getPlatformArchiveDetail");
    const updateSpy = vi.fn();
    queue.once("update", updateSpy);

    await queue.check();

    expect(getArchivesSpy).toHaveBeenCalledTimes(2);
    expect(getArchivesSpy).toHaveBeenNthCalledWith(1, { pn: 1, ps: 20 }, 123);
    expect(getArchivesSpy).toHaveBeenNthCalledWith(2, { pn: 2, ps: 20 }, 123);
    expect(getPlatformArchiveDetailSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(25, "completed", targetMedia.Archive);
  });
  it("should use getPlatformArchiveDetail if getArchives can not get", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = { Archive: { aid: 2, state: 0 }, stat: { aid: 2 } };

    const getArchivesSpy = vi
      .spyOn(biliApi, "getArchives")
      // @ts-ignore
      .mockResolvedValue({ arc_audits: [media] });
    const getPlatformArchiveDetailSpy = vi
      .spyOn(biliApi, "getPlatformArchiveDetail")
      // @ts-ignore
      .mockResolvedValue({ archive: { aid: 1, state: 0 } });

    queue.once("update", (aid, status, data) => {
      expect(aid).toBe(1);
      expect(status).toBe("completed");
    });
    await queue.check();

    expect(getArchivesSpy).toHaveBeenCalled();
    expect(getPlatformArchiveDetailSpy).toHaveBeenCalled();
  });
  it("should keep pending item if detail lookup fails temporarily", async () => {
    queue.add({ aid: 1, uid: 123 });
    const media = { Archive: { aid: 2, state: 0 }, stat: { aid: 2 } };

    const getArchivesSpy = vi
      .spyOn(biliApi, "getArchives")
      // @ts-ignore
      .mockResolvedValue({ arc_audits: [media] });
    const getPlatformArchiveDetailSpy = vi
      .spyOn(biliApi, "getPlatformArchiveDetail")
      .mockRejectedValue(new Error("not found"));
    const queneEmitSpy = vi.spyOn(queue, "emit");

    await queue.check();

    expect(getArchivesSpy).toHaveBeenCalled();
    expect(getPlatformArchiveDetailSpy).toHaveBeenCalled();
    expect(queue.list).toHaveLength(1);
    expect(queue.list[0]).toMatchObject({ aid: 1, status: "pending" });
    expect(queneEmitSpy).not.toHaveBeenCalled();
  });

  it("should call checkLoop at specified intervals", async () => {
    const checkSpy = vi.spyOn(queue, "check");
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    await queue.checkLoop();

    expect(checkSpy).toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(queue.checkLoop, 600 * 1000);
  });
});
