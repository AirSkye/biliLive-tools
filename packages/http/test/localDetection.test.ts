import { describe, expect, it } from "vitest";
import {
  archiveTitleMatchesSearchKeyword,
  shouldUseSearchOnlyRemoteArchives,
} from "../src/services/localDetection.js";

describe("remote archive detection scope", () => {
  it("uses title search only when a streamer filter is selected", () => {
    expect(shouldUseSearchOnlyRemoteArchives(1)).toBe(true);
    expect(shouldUseSearchOnlyRemoteArchives(0)).toBe(false);
  });
});

describe("archive title search filtering", () => {
  it("keeps an archive whose title matches the local title keyword", () => {
    expect(
      archiveTitleMatchesSearchKeyword("回国种地的老陈 三礼全平台无了", {
        type: "title",
        normalized: "回国种地的老陈三礼全平台无了",
      }),
    ).toBe(true);
  });

  it("drops unrelated fuzzy search results when a streamer is selected", () => {
    expect(
      archiveTitleMatchesSearchKeyword("另一位主播的无关直播录屏", {
        type: "title",
        normalized: "回国种地的老陈三礼全平台无了",
      }),
    ).toBe(false);
  });

  it("does not filter broad streamer fallback searches by title", () => {
    expect(
      archiveTitleMatchesSearchKeyword("任意标题", {
        type: "streamer",
        normalized: "地图大师returnwrong",
      }),
    ).toBe(true);
  });
});
