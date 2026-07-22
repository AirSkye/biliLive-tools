import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";
import { RecoverableJsonStore } from "../src/utils/recoverableJsonStore.js";

type TestStore = {
  items: string[];
};

describe("RecoverableJsonStore", () => {
  const temporaryDirectories: string[] = [];

  const createStore = async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recoverable-json-store-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "store.json");
    const store = new RecoverableJsonStore<TestStore>({
      getFilePath: () => filePath,
      createDefault: () => ({ items: [] }),
      normalize: (data) => ({
        items: Array.isArray((data as Partial<TestStore> | undefined)?.items)
          ? (data as TestStore).items
          : [],
      }),
    });
    return { directory, filePath, store };
  };

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.remove(directory)));
  });

  it("backs up malformed JSON and returns an empty store", async () => {
    const { directory, filePath, store } = await createStore();
    await fs.writeFile(filePath, '{"items": [');

    await expect(store.read()).resolves.toEqual({ items: [] });

    const files = await fs.readdir(directory);
    expect(files.some((file) => file.startsWith("store.json.corrupt-"))).toBe(true);
  });

  it("serializes concurrent updates without losing entries", async () => {
    const { store } = await createStore();

    await Promise.all([
      store.update((data) => data.items.push("first")),
      store.update((data) => data.items.push("second")),
      store.update((data) => data.items.push("third")),
    ]);

    await expect(store.read()).resolves.toEqual({ items: ["first", "second", "third"] });
  });
});
