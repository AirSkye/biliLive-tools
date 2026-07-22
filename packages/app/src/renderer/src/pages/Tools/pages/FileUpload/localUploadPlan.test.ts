import { describe, expect, it } from "vitest";

import type { LocalUnuploadedGroup } from "@renderer/apis/bili";
import {
  buildLocalActionGroups,
  removeCompletedLocalUploadFiles,
  type LocalProcessMode,
} from "./localUploadPlan";

const file = (path: string, index: number) => ({
  path,
  fileName: path,
  size: (index + 1) * 100,
  mtimeMs: (index + 1) * 1000,
  startTime: (index + 1) * 1000,
  endTime: (index + 1) * 1000 + 500,
  title: `part-${index}`,
});

const group = (paths: string[], id = "group-1"): LocalUnuploadedGroup => ({
  id,
  groupKey: `recording-${id}`,
  uploadKey: `full-upload-${id}`,
  syncKey: `full-sync-${id}`,
  roomId: "100",
  platform: "bilibili",
  username: "tester",
  title: "recording",
  startTime: 1000,
  fileCount: paths.length,
  totalSize: paths.length * 100,
  danmuCount: 0,
  files: paths.map(file),
  suggestedAction: "new",
  mergeCandidate: paths.length > 1 && paths.every((item) => item.endsWith(".flv")),
  hasWebhookUploadConfig: true,
  hasWebhookSyncConfig: true,
  warnings: [],
});

const plan = (paths: string[], selected: string[], mode: LocalProcessMode) =>
  buildLocalActionGroups({
    groups: [{ row: group(paths), uploadRawWhenNoDanmu: true }],
    selectedFilePaths: selected,
    mode,
    deleteSourceAfterSync: false,
  })[0];

describe("local upload plan", () => {
  it("uploads only the selected file from a multi-file recording", () => {
    const result = plan(["a.flv", "b.flv"], ["b.flv"], "direct");
    expect(result.files.map((item) => item.path)).toEqual(["b.flv"]);
    expect(result.burnDanmu).toBe(false);
    expect(result.mergeSegments).toBe(false);
  });

  it("burns a single file in burn-and-merge mode without requiring a merge", () => {
    const result = plan(["a.flv", "b.flv"], ["a.flv"], "burnMerge");
    expect(result.burnFilePaths).toEqual(["a.flv"]);
    expect(result.mergeFilePaths).toEqual(["a.flv"]);
    expect(result.mergeSegments).toBe(false);
  });

  it("merges selected FLV files without burning them", () => {
    const result = plan(["a.flv", "b.flv", "c.flv"], ["a.flv", "c.flv"], "merge");
    expect(result.files.map((item) => item.path)).toEqual(["a.flv", "c.flv"]);
    expect(result.mergeFilePaths).toEqual(["a.flv", "c.flv"]);
    expect(result.mergeSegments).toBe(true);
    expect(result.burnDanmu).toBe(false);
  });

  it("burns selected files without merging", () => {
    const result = plan(["a.flv", "b.flv"], ["a.flv", "b.flv"], "burn");
    expect(result.burnFilePaths).toEqual(["a.flv", "b.flv"]);
    expect(result.mergeFilePaths).toEqual([]);
    expect(result.mergeSegments).toBe(false);
  });

  it("burns and merges multiple selected FLV files", () => {
    const result = plan(["a.flv", "b.flv"], ["a.flv", "b.flv"], "burnMerge");
    expect(result.burnFilePaths).toEqual(["a.flv", "b.flv"]);
    expect(result.mergeFilePaths).toEqual(["a.flv", "b.flv"]);
    expect(result.mergeSegments).toBe(true);
  });

  it("merges FLV files and keeps selected MP4 files as separate parts", () => {
    const result = plan(["a.flv", "b.flv", "ready.mp4"], ["a.flv", "b.flv", "ready.mp4"], "merge");
    expect(result.files.map((item) => item.path)).toEqual(["a.flv", "b.flv", "ready.mp4"]);
    expect(result.mergeFilePaths).toEqual(["a.flv", "b.flv"]);
    expect(result.mergeSegments).toBe(true);
  });

  it("creates independent burn tasks for one-part and two-part recordings", () => {
    const first = group(["first-a.flv"], "first");
    const second = group(["second-a.flv", "second-b.flv"], "second");
    const result = buildLocalActionGroups({
      groups: [
        { row: first, uploadRawWhenNoDanmu: true },
        { row: second, uploadRawWhenNoDanmu: true },
      ],
      selectedFilePaths: ["first-a.flv", "second-a.flv", "second-b.flv"],
      mode: "burn",
      deleteSourceAfterSync: false,
    });

    expect(result).toHaveLength(2);
    expect(result[0].burnFilePaths).toEqual(["first-a.flv"]);
    expect(result[1].burnFilePaths).toEqual(["second-a.flv", "second-b.flv"]);
    expect(result.every((item) => !item.mergeSegments)).toBe(true);
  });

  it("merges two two-part recordings independently without crossing periods", () => {
    const first = group(["first-a.flv", "first-b.flv"], "first");
    const second = group(["second-a.flv", "second-b.flv"], "second");
    const result = buildLocalActionGroups({
      groups: [
        { row: first, uploadRawWhenNoDanmu: true },
        { row: second, uploadRawWhenNoDanmu: true },
      ],
      selectedFilePaths: ["first-a.flv", "first-b.flv", "second-a.flv", "second-b.flv"],
      mode: "burnMerge",
      deleteSourceAfterSync: false,
    });

    expect(result).toHaveLength(2);
    expect(result[0].mergeFilePaths).toEqual(["first-a.flv", "first-b.flv"]);
    expect(result[1].mergeFilePaths).toEqual(["second-a.flv", "second-b.flv"]);
    expect(result.every((item) => item.mergeSegments && item.burnDanmu)).toBe(true);
  });

  it("removes only completed upload files and keeps the remaining recording", () => {
    const source = group(["a.flv", "b.flv"]);
    const result = removeCompletedLocalUploadFiles(
      [source],
      [
        {
          key: "partial-key",
          operation: "upload",
          status: "completed",
          filePaths: ["A.FLV"],
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0].files.map((item) => item.path)).toEqual(["b.flv"]);
    expect(result[0].fileCount).toBe(1);
    expect(result[0].totalSize).toBe(200);
  });

  it("does not remove files when cloud sync completes", () => {
    const source = group(["a.flv"]);
    const result = removeCompletedLocalUploadFiles(
      [source],
      [
        {
          key: "sync-key",
          operation: "sync",
          status: "completed",
          filePaths: ["a.flv"],
        },
      ],
    );
    expect(result).toEqual([source]);
  });
});
