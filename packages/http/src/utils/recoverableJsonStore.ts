import path from "node:path";
import fs from "fs-extra";

type RecoverableJsonStoreOptions<T> = {
  getFilePath: () => string;
  createDefault: () => T;
  normalize: (data: unknown) => T;
};

const READ_RETRY_MS = 100;

const isTransientFileError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EACCES" || code === "EPERM";
};

const waitForRetry = () => new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_MS));

export class RecoverableJsonStore<T> {
  private operationQueue = Promise.resolve();

  constructor(private readonly options: RecoverableJsonStoreOptions<T>) {}

  private runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const pending = this.operationQueue.then(operation, operation);
    this.operationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async readUnsafe(): Promise<T> {
    const filePath = this.options.getFilePath();
    if (!(await fs.pathExists(filePath))) {
      return this.options.createDefault();
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.options.normalize(await fs.readJson(filePath));
      } catch (error) {
        if (isTransientFileError(error)) {
          if (attempt < 2) {
            await waitForRetry();
            continue;
          }
          console.error(`read JSON store failed after retries: ${filePath}`, error);
          return this.options.createDefault();
        }

        console.error(`read invalid JSON store failed: ${filePath}`, error);
        const backupPath = `${filePath}.corrupt-${Date.now()}`;
        try {
          if (await fs.pathExists(filePath)) {
            await fs.move(filePath, backupPath, { overwrite: false });
            console.warn(`invalid JSON store moved to: ${backupPath}`);
          }
        } catch (backupError) {
          console.error(`backup invalid JSON store failed: ${filePath}`, backupError);
        }
        return this.options.createDefault();
      }
    }

    return this.options.createDefault();
  }

  private async writeUnsafe(data: T): Promise<void> {
    const filePath = this.options.getFilePath();
    await fs.ensureDir(path.dirname(filePath));
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeJson(temporaryPath, data, { spaces: 2 });
      await fs.move(temporaryPath, filePath, { overwrite: true });
    } finally {
      await fs.remove(temporaryPath).catch(() => undefined);
    }
  }

  read(): Promise<T> {
    return this.runExclusive(() => this.readUnsafe());
  }

  write(data: T): Promise<void> {
    return this.runExclusive(() => this.writeUnsafe(data));
  }

  update<Result>(mutate: (data: T) => Result | Promise<Result>): Promise<Result> {
    return this.runExclusive(async () => {
      const data = await this.readUnsafe();
      const result = await mutate(data);
      await this.writeUnsafe(data);
      return result;
    });
  }
}
