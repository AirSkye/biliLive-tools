import fs from "fs-extra";
import { afterEach, describe, it, expect, vi } from "vitest";
import { BaiduPCS } from "../../src/sync/baiduPCS";

describe("BaiduPCS", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseProgress", () => {
    it("应该正确解析带索引的进度信息", () => {
      const baiduPCS = new BaiduPCS();
      const mockEmit = vi.fn();
      baiduPCS.emit = mockEmit;

      const progressOutput = "[1] ↑ 305.06MB/1.01GB 2.15MB/s in 33s";
      baiduPCS["parseProgress"](progressOutput);

      expect(mockEmit).toHaveBeenCalledWith("progress", {
        index: 1,
        uploaded: "305.06MB",
        total: "1.01GB",
        speed: "2.15MB/s",
        elapsed: "33s",
        percentage: expect.any(Number),
      });
    });

    it("应该正确解析不带索引的进度信息", () => {
      const baiduPCS = new BaiduPCS();
      const mockEmit = vi.fn();
      baiduPCS.emit = mockEmit;

      const progressOutput = "↑ 500KB/1MB 100KB/s in 5s";
      baiduPCS["parseProgress"](progressOutput);

      expect(mockEmit).not.toHaveBeenCalled();
    });

    it("应该忽略不匹配的进度信息", () => {
      const baiduPCS = new BaiduPCS();
      const mockEmit = vi.fn();
      baiduPCS.emit = mockEmit;

      const invalidOutput = "Some random text";
      baiduPCS["parseProgress"](invalidOutput);

      expect(mockEmit).not.toHaveBeenCalled();
    });

    it("应该正确计算百分比", () => {
      const baiduPCS = new BaiduPCS();
      const mockEmit = vi.fn();
      baiduPCS.emit = mockEmit;

      const progressOutput = "[1] ↑ 512MB/1GB 2MB/s in 10s";
      baiduPCS["parseProgress"](progressOutput);

      expect(mockEmit).toHaveBeenCalledWith("progress", {
        index: 1,
        uploaded: "512MB",
        total: "1GB",
        speed: "2MB/s",
        elapsed: "10s",
        percentage: 50,
      });
    });
  });

  describe("uploadFile remote deduplication", () => {
    const localFilePath = "C:/recordings/test.flv";

    const mockLocalFile = (size: number) => {
      vi.spyOn(fs, "pathExists").mockResolvedValue(true);
      vi.spyOn(fs, "stat").mockResolvedValue({ size } as Awaited<ReturnType<typeof fs.stat>>);
    };

    it("skips upload when the remote file has the same size", async () => {
      mockLocalFile(1024);
      const baiduPCS = new BaiduPCS({ remotePath: "/录播" });
      vi.spyOn(baiduPCS, "emit").mockReturnValue(true);
      vi.spyOn(baiduPCS, "getFileMeta").mockResolvedValue({
        path: "/录播/主播/test.flv",
        filename: "test.flv",
        size: 1024,
      });
      const uploadSpy = vi.spyOn(baiduPCS as any, "executeUploadCommand");

      await baiduPCS.uploadFile(localFilePath, "主播", { policy: "skip" });

      expect(uploadSpy).not.toHaveBeenCalled();
      expect(baiduPCS.emit).toHaveBeenCalledWith(
        "success",
        expect.stringContaining("远端已存在同名同大小文件"),
      );
    });

    it("stops when the remote file has a different size", async () => {
      mockLocalFile(1024);
      const baiduPCS = new BaiduPCS({ remotePath: "/录播" });
      vi.spyOn(baiduPCS, "emit").mockReturnValue(true);
      vi.spyOn(baiduPCS, "getFileMeta").mockResolvedValue({
        path: "/录播/主播/test.flv",
        filename: "test.flv",
        size: 512,
      });
      const uploadSpy = vi.spyOn(baiduPCS as any, "executeUploadCommand");

      await expect(baiduPCS.uploadFile(localFilePath, "主播", { policy: "skip" })).rejects.toThrow(
        "远端已存在同名文件但大小不同",
      );
      expect(uploadSpy).not.toHaveBeenCalled();
    });

    it("uploads when the remote file does not exist", async () => {
      mockLocalFile(1024);
      const baiduPCS = new BaiduPCS({ remotePath: "/录播" });
      vi.spyOn(baiduPCS, "emit").mockReturnValue(true);
      vi.spyOn(baiduPCS, "getFileMeta")
        .mockRejectedValueOnce(new Error("文件不存在"))
        .mockResolvedValueOnce({
          path: "/录播/主播/test.flv",
          filename: "test.flv",
          size: 1024,
        });
      const uploadSpy = vi.spyOn(baiduPCS as any, "executeUploadCommand").mockResolvedValue("");

      await baiduPCS.uploadFile(localFilePath, "主播", { policy: "skip" });

      expect(uploadSpy).toHaveBeenCalledOnce();
    });
  });
});
