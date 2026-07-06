import { describe, it, expect, vi } from "vitest";
import { ConfigManager } from "../src/services/webhook/ConfigManager.js";

describe("ConfigManager", () => {
  describe("canRoomOpen", () => {
    const appConfig = {
      getAll: vi.fn().mockReturnValue({
        task: { ffmpegMaxNum: -1, douyuDownloadMaxNum: -1, biliUploadMaxNum: -1 },
      }),
    };
    // @ts-ignore
    const configManager = new ConfigManager(appConfig);

    it("should return true when roomSetting is open", () => {
      const roomSetting = { open: true };
      const result = configManager.canRoomOpen(roomSetting, "", "123");
      expect(result).toBe(true);
    });

    it("should return true when roomSetting is open and blacklist is provided", () => {
      const roomSetting = { open: true };
      const result = configManager.canRoomOpen(roomSetting, "*", "123");
      expect(result).toBe(true);
    });

    it("should return false when roomSetting is closed", () => {
      const roomSetting = { open: false };
      const result = configManager.canRoomOpen(roomSetting, "", "123");
      expect(result).toBe(false);
    });

    it("should return false when roomSetting is closed and blacklist is provided", () => {
      const roomSetting = { open: false };
      const result = configManager.canRoomOpen(roomSetting, "*", "123");
      expect(result).toBe(false);
    });

    it("should return true when roomSetting is not provided and roomId is not in the blacklist", () => {
      const roomSetting = undefined;
      const roomId = "123";
      const result = configManager.canRoomOpen(roomSetting, "", roomId);
      expect(result).toBe(true);
    });

    it("should return true when roomSetting is not provided and roomId is not in the blacklist", () => {
      const roomSetting = undefined;
      const roomId = "123";
      const result = configManager.canRoomOpen(roomSetting, "456", roomId);
      expect(result).toBe(true);
    });

    it("should return false when roomSetting is not provided and roomId is in the blacklist", () => {
      const roomSetting = undefined;
      const roomId = "123";
      const result = configManager.canRoomOpen(roomSetting, "123,456", roomId);
      expect(result).toBe(false);
    });

    it("should return false when roomSetting is not provided and the blacklist contains '*'", () => {
      const roomSetting = undefined;
      const roomId = "123";
      const result = configManager.canRoomOpen(roomSetting, "*", roomId);
      expect(result).toBe(false);
    });
  });

  describe("getConfig", () => {
    it("should partMergeMinute return -1 when mergePart is false", () => {
      const appConfig = {
        getAll: vi.fn().mockReturnValue({
          webhook: {
            open: true,
            autoPartMerge: false,
            partMergeMinute: 10,
          },
        }),
      };
      // @ts-ignore
      const configManager = new ConfigManager(appConfig);
      const roomId = "123";
      const result = configManager.getConfig(roomId);
      expect(result.partMergeMinute).toBe(-1);
    });

    describe("afterConvertRemoveVideo", () => {
      it("should afterConvertRemoveVideo return false when videoPresetId is not exist", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeVideo"],
              ffmpegPreset: undefined,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveVideo).toBe(false);
      });

      it("should afterConvertRemoveVideo return true when videoPresetId is exist and afterConvertAction is 'removeVideo'", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeVideo"],
              ffmpegPreset: "123",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveVideo).toBe(true);
      });

      it("should afterConvertRemoveVideo return true when videoPresetId is not exist and afterConvertAction is 'removeVideo' and syncId is exist", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeVideo"],
              ffmpegPreset: undefined,
              syncId: "123",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveVideo).toBe(true);
      });

      it("当存在syncId且afterConvertAction为空时,afterConvertRemoveVideo应该为false", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: [],
              ffmpegPreset: "123",
              syncId: "123",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveVideo).toBe(false);
      });

      it("当不存在syncId且不存在videoPresetId时,afterConvertAction包含removeVideo时,afterConvertRemoveVideo应该为false", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeVideo"],
              ffmpegPreset: undefined,
              syncId: undefined,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveVideo).toBe(false);
      });

      it("should keep raw removeVideo flag even when no video preset exists", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeVideo"],
              ffmpegPreset: undefined,
              syncId: undefined,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const result = configManager.getConfig("123");

        expect(result.afterConvertRemoveVideo).toBe(false);
        expect(result.afterConvertRemoveVideoRaw).toBe(true);
      });
    });

    describe("afterConvertRemoveXml", () => {
      it("should afterConvertRemoveXml return false when danmuPresetId is not exist", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeXml"],
              danmuPreset: undefined,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveXml).toBe(false);
      });

      it("should afterConvertRemoveXml return true when danmuPresetId is exist and afterConvertAction is 'removeXml'", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeXml"],
              danmuPreset: "123",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveXml).toBe(true);
      });

      it("当存在syncId时,应该使用原始的afterConvertRemoveXml配置", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeXml"],
              danmuPreset: undefined,
              syncId: "123",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveXml).toBe(true);
      });

      it("当不存在syncId且没有danmuPreset时,afterConvertRemoveXml应该为false", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeXml"],
              danmuPreset: undefined,
              syncId: undefined,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveXml).toBe(false);
      });

      it("当存在syncId时且存在danmuPreset,afterConvertAction为空时,afterConvertRemoveXml应该为false", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: [],
              danmuPreset: "123",
              syncId: "123",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.afterConvertRemoveXml).toBe(false);
      });

      it("should keep raw removeXml flag even when no danmu preset exists", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              afterConvertAction: ["removeXml"],
              danmuPreset: undefined,
              syncId: undefined,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const result = configManager.getConfig("123");

        expect(result.afterConvertRemoveXml).toBe(false);
        expect(result.afterConvertRemoveXmlRaw).toBe(true);
      });
    });

    describe("uploadNoDanmu", () => {
      it("should uploadNoDanmu return false when uploadNoDanmu is false", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              uid: undefined,
              uploadNoDanmu: false,
              afterConvertAction: [],
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.uploadNoDanmu).toBe(false);
      });

      it("should uploadNoDanmu return true when has uid && uploadNoDanmu && afterConvertAction is not 'removeAll'", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              uid: 123,
              uploadNoDanmu: true,
              afterConvertAction: "none",
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.uploadNoDanmu).toBe(true);
      });

      it("should uploadNoDanmu return true when has uid && uploadNoDanmu is true", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              uid: 123,
              uploadNoDanmu: true,
              afterConvertAction: ["removeVideo", "removeXml"],
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.uploadNoDanmu).toBe(true);
      });
    });

    describe("uploadToSameMedia", () => {
      it("should uploadToSameMedia default to false", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              uploadNoDanmu: true,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const result = configManager.getConfig("123");
        expect(result.uploadToSameMedia).toBe(false);
      });

      it("should uploadToSameMedia return true when configured", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              uid: 123,
              uploadNoDanmu: true,
              uploadToSameMedia: true,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const result = configManager.getConfig("123");
        expect(result.uploadToSameMedia).toBe(true);
      });
    });

    describe("upload metadata defaults", () => {
      it("should enable live room link and live info tags by default", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const result = configManager.getConfig("123");

        expect(result.appendLiveRoomLinkToDesc).toBe(true);
        expect(result.appendLiveInfoTags).toBe(true);
      });

      it("should allow room setting to disable live room link and live info tags", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              appendLiveRoomLinkToDesc: true,
              appendLiveInfoTags: true,
              rooms: {
                "123": {
                  open: true,
                  noGlobal: ["appendLiveRoomLinkToDesc", "appendLiveInfoTags"],
                  appendLiveRoomLinkToDesc: false,
                  appendLiveInfoTags: false,
                },
              },
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const result = configManager.getConfig("123");

        expect(result.appendLiveRoomLinkToDesc).toBe(false);
        expect(result.appendLiveInfoTags).toBe(false);
      });
    });

    describe("removeSourceAferrConvert2Mp4", () => {
      it("should removeSourceAferrConvert2Mp4 return true when convert2Mp4 open and afterConvertAction includes removeAfterConvert2Mp4", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              convert2Mp4: true,
              afterConvertAction: ["removeAfterConvert2Mp4"],
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.removeSourceAferrConvert2Mp4).toBe(true);
      });

      it("should removeSourceAferrConvert2Mp4 return false when convert2Mp4 close and afterConvertAction includes removeAfterConvert2Mp4", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              convert2Mp4: false,
              afterConvertAction: ["removeAfterConvert2Mp4"],
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.removeSourceAferrConvert2Mp4).toBe(false);
      });

      it("should removeSourceAferrConvert2Mp4 return false when convert2Mp4 open and afterConvertAction not includes removeAfterConvert2Mp4", () => {
        const appConfig = {
          getAll: vi.fn().mockReturnValue({
            webhook: {
              open: true,
              autoPartMerge: false,
              partMergeMinute: 10,
              convert2Mp4: true,
              afterConvertAction: [],
            },
          }),
        };
        // @ts-ignore
        const configManager = new ConfigManager(appConfig);
        const roomId = "123";
        const result = configManager.getConfig(roomId);
        expect(result.removeSourceAferrConvert2Mp4).toBe(false);
      });
    });
  });

  describe("getSyncConfig", () => {
    it("should return null when syncId is not configured", () => {
      const appConfig = {
        getAll: vi.fn().mockReturnValue({
          webhook: {
            open: true,
            autoPartMerge: false,
          },
        }),
      };
      // @ts-ignore
      const configManager = new ConfigManager(appConfig);
      const result = configManager.getSyncConfig("123");
      expect(result).toBe(null);
    });

    it("should return null when syncId is configured but sync config not found", () => {
      const appConfig = {
        getAll: vi.fn().mockReturnValue({
          webhook: {
            open: true,
            autoPartMerge: false,
            syncId: "sync-123",
          },
          sync: {
            syncConfigs: [
              {
                id: "sync-456",
                name: "Other Sync",
              },
            ],
          },
        }),
      };
      // @ts-ignore
      const configManager = new ConfigManager(appConfig);
      const result = configManager.getSyncConfig("123");
      expect(result).toBe(null);
    });

    it("should return sync config when syncId is configured and found", () => {
      const syncConfig = {
        id: "sync-123",
        name: "Test Sync",
        syncSource: "webdav",
        targetFiles: ["source", "danmaku"],
      };
      const appConfig = {
        getAll: vi.fn().mockReturnValue({
          webhook: {
            open: true,
            autoPartMerge: false,
            syncId: "sync-123",
          },
          sync: {
            syncConfigs: [syncConfig],
          },
        }),
      };
      // @ts-ignore
      const configManager = new ConfigManager(appConfig);
      const result = configManager.getSyncConfig("123");
      expect(result).toEqual(syncConfig);
    });

    it("should return sync config from room setting when noGlobal includes syncId", () => {
      const syncConfig = {
        id: "sync-room",
        name: "Room Sync",
        syncSource: "webdav",
        targetFiles: ["source"],
      };
      const appConfig = {
        getAll: vi.fn().mockReturnValue({
          webhook: {
            open: true,
            autoPartMerge: false,
            syncId: "sync-global",
            rooms: {
              "123": {
                noGlobal: ["syncId"],
                syncId: "sync-room",
              },
            },
          },
          sync: {
            syncConfigs: [
              {
                id: "sync-global",
                name: "Global Sync",
              },
              syncConfig,
            ],
          },
        }),
      };
      // @ts-ignore
      const configManager = new ConfigManager(appConfig);
      const result = configManager.getSyncConfig("123");
      expect(result).toEqual(syncConfig);
    });

    it("should return null when sync.syncConfigs is undefined", () => {
      const appConfig = {
        getAll: vi.fn().mockReturnValue({
          webhook: {
            open: true,
            autoPartMerge: false,
            syncId: "sync-123",
          },
          sync: {},
        }),
      };
      // @ts-ignore
      const configManager = new ConfigManager(appConfig);
      const result = configManager.getSyncConfig("123");
      expect(result).toBe(null);
    });
  });
});
