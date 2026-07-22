import path from "node:path";
import fs from "fs-extra";
import { TypedEmitter } from "tiny-typed-emitter";
import { isBetweenTimeRange } from "../../utils/index.js";
import { TaskType } from "../../enum.js";
import { AbstractTask } from "./AbstractTask.js";

import type { Status } from "@biliLive-tools/types";
import type { AppConfig } from "../../config.js";
import type { TaskEvents } from "./types.js";

type PersistedTaskRecord = {
  pid?: string;
  taskId: string;
  status: Status;
  name: string;
  type: string;
  relTaskId?: string;
  output?: string;
  progress: number;
  action: AbstractTask["action"];
  startTime: number;
  endTime?: number;
  custsomProgressMsg?: string;
  error?: string;
  extra?: Record<string, any>;
  manualStart?: boolean;
  autoStartWhenReady?: boolean;
};

class RestoredTask extends AbstractTask {
  type: string;

  constructor(record: PersistedTaskRecord) {
    super();
    const interrupted = record.status === "running" || record.status === "paused";
    const unrestorable = record.status === "pending";
    const needsRecovery = interrupted || unrestorable;
    this.pid = record.pid;
    this.taskId = record.taskId;
    this.status = needsRecovery ? "error" : record.status;
    this.name = record.name;
    this.type = record.type;
    this.relTaskId = record.relTaskId;
    this.output = record.output;
    this.progress = needsRecovery ? 0 : record.progress;
    this.action = [];
    this.startTime = record.startTime;
    this.endTime = record.endTime ?? (needsRecovery ? Date.now() : undefined);
    this.custsomProgressMsg = record.custsomProgressMsg ?? "";
    this.error = interrupted
      ? "应用关闭时任务已中断，请重新创建任务或删除记录"
      : unrestorable
        ? "应用重启后未恢复可执行上下文，请重新创建任务或删除记录"
        : record.error;
    this.extra = record.extra;
    this.manualStart = record.manualStart ?? false;
    this.autoStartWhenReady = record.autoStartWhenReady ?? false;
  }

  exec() {}
  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    this.status = "canceled";
    this.emit("task-cancel", { taskId: this.taskId, autoStart: true });
  }
  pause() {}
  resume() {}
}

/**
 * 任务队列管理类
 */
export class TaskQueue {
  appConfig: AppConfig;
  queue: AbstractTask[];
  emitter = new TypedEmitter<TaskEvents>();
  on: TypedEmitter<TaskEvents>["on"];
  off: TypedEmitter<TaskEvents>["off"];
  private persistenceFile?: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private isRestoring = false;

  constructor(appConfig: AppConfig) {
    this.queue = [];
    this.appConfig = appConfig;
    this.on = this.emitter.on.bind(this.emitter);
    this.off = this.emitter.off.bind(this.emitter);
    this.on("task-end", () => {
      this.addTaskForLimit();
    });
    this.on("task-error", () => {
      this.addTaskForLimit();
    });
    this.on("task-pause", () => {
      this.addTaskForLimit();
    });
    this.on("task-cancel", ({ autoStart }) => {
      if (autoStart) this.addTaskForLimit();
    });

    setInterval(() => {
      // @ts-ignore
      const isVitest = process.env.NODE_ENV === "test";
      if (isVitest) return;
      this.addTaskForLimit();
    }, 1000 * 60);
  }

  initPersistence(userDataPath: string): void {
    this.persistenceFile = path.join(userDataPath, "taskQueue.json");
    this.restorePersistedQueue();
    this.persistNow();
  }

  private restorePersistedQueue(): void {
    if (!this.persistenceFile || !fs.pathExistsSync(this.persistenceFile)) return;
    try {
      this.isRestoring = true;
      const data = fs.readJsonSync(this.persistenceFile) as {
        version?: number;
        tasks?: PersistedTaskRecord[];
      };
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      if (this.queue.length === 0) {
        this.queue.push(...tasks.map((task) => new RestoredTask(task)));
      }
    } catch (error) {
      console.error("恢复任务队列失败", error);
    } finally {
      this.isRestoring = false;
    }
  }

  private schedulePersist(): void {
    if (!this.persistenceFile || this.isRestoring) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 300);
  }

  private persistNow(): void {
    if (!this.persistenceFile) return;
    try {
      fs.ensureDirSync(path.dirname(this.persistenceFile));
      fs.writeJsonSync(
        this.persistenceFile,
        {
          version: 1,
          tasks: this.stringify(this.queue),
        },
        { spaces: 2 },
      );
    } catch (error) {
      console.error("保存任务队列失败", error);
    }
  }

  flushPersistence(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistNow();
  }

  /**
   * 运行任务，考虑任务限制和时间范围
   */
  runTask(task: AbstractTask): void {
    if (task.manualStart) return;

    const typeMap: Record<string, string> = {
      [TaskType.ffmpeg]: "ffmpegMaxNum",
      [TaskType.douyuDownload]: "douyuDownloadMaxNum",
      [TaskType.biliUpload]: "biliUploadMaxNum",
      [TaskType.biliDownload]: "biliDownloadMaxNum",
      [TaskType.sync]: "syncMaxNum",
    };
    const config = this.appConfig.getAll();
    const maxNum = config?.task?.[typeMap[task.type]] ?? 0;
    if (maxNum >= 0) {
      this.queue.filter(
        (item) => item.type === task.type && (item.status === "running" || item.starting),
      ).length < maxNum &&
        isBetweenTimeRange(task.limitTime) &&
        task.exec();
    } else {
      isBetweenTimeRange(task.limitTime) && task.exec();
    }
  }

  /**
   * 添加任务到队列
   * @param task 任务实例
   * @param autoRun 是否自动运行（true: 立即执行, false: 根据任务限制决定）
   */
  addTask(task: AbstractTask, autoRun = true): void {
    task.emitter.on("task-end", ({ taskId, data }) => {
      this.emitter.emit("task-end", { taskId, data });
      this.schedulePersist();
    });
    task.emitter.on("task-error", ({ taskId, error }) => {
      this.emitter.emit("task-error", { taskId, error });
      this.schedulePersist();
    });
    task.emitter.on("task-progress", ({ taskId }) => {
      this.emitter.emit("task-progress", { taskId });
      this.schedulePersist();
    });
    task.emitter.on("task-start", ({ taskId }) => {
      this.emitter.emit("task-start", { taskId });
      this.schedulePersist();
    });
    task.emitter.on("task-pause", ({ taskId }) => {
      this.emitter.emit("task-pause", { taskId });
      this.schedulePersist();
    });
    task.emitter.on("task-resume", ({ taskId }) => {
      this.emitter.emit("task-resume", { taskId });
      this.schedulePersist();
    });
    task.emitter.on("task-cancel", ({ taskId, autoStart }) => {
      this.emitter.emit("task-cancel", { taskId, autoStart });
      this.schedulePersist();
    });
    // task.emitter.on("task-removed-queue", ({ taskId }) => {
    //   this.emitter.emit("task-removed-queue", { taskId });
    // });

    this.queue.push(task);
    this.schedulePersist();

    if (autoRun) {
      task.exec();
    } else {
      this.runTask(task);
    }
  }

  /**
   * 查询任务
   */
  queryTask(taskId: string): AbstractTask | undefined {
    const task = this.queue.find((task) => task.taskId === taskId);
    return task;
  }

  /**
   * 将任务序列化为可传输对象
   */
  stringify(item: AbstractTask[]) {
    return item.map((task) => {
      return {
        pid: task.pid,
        taskId: task.taskId,
        status: task.status,
        name: task.name,
        type: task.type,
        relTaskId: task.relTaskId,
        output: task.output,
        progress: task.progress,
        action: task.action,
        startTime: task.startTime,
        endTime: task.endTime,
        custsomProgressMsg: task.custsomProgressMsg,
        error: task.error ? String(task.error) : "",
        duration: task.getDuration(),
        extra: task.extra,
        manualStart: task.manualStart,
        autoStartWhenReady: task.autoStartWhenReady,
      };
    });
  }

  /**
   * 过滤任务
   */
  filter(options: { type?: string; status?: Status }): AbstractTask[] {
    return this.queue.filter((task) => {
      if (options.type && task.type !== options.type) return false;
      if (options.status && task.status !== options.status) return false;
      return true;
    });
  }

  /**
   * 获取所有任务
   */
  list(): AbstractTask[] {
    return this.queue;
  }

  /**
   * 启动任务
   */
  async start(taskId: string): Promise<void> {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.status !== "pending") return;
    await task.exec();
    this.schedulePersist();
  }

  /**
   * 移除任务
   */
  remove(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.emit("task-removed-queue", { taskId: task.taskId });
    const index = this.queue.indexOf(task);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
    this.schedulePersist();
  }

  /**
   * 暂停任务
   */
  pasue(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.pause();
    if (task.status === "paused") {
      task.pauseStartTime = Date.now();
    }
    this.schedulePersist();
  }

  /**
   * 恢复任务
   */
  resume(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    const pauseStartTime = task.pauseStartTime;
    task.resume();
    if (task.status === "running" && pauseStartTime !== null) {
      task.totalPausedDuration += Date.now() - pauseStartTime;
      task.pauseStartTime = null;
    }
    this.schedulePersist();
  }

  /**
   * 取消任务
   */
  cancel(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.kill();
    this.schedulePersist();
  }

  /**
   * 重启任务
   */
  async restart(taskId: string, options: { removeOutput?: boolean } = {}): Promise<void> {
    const task = this.queryTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.action.includes("restart")) {
      // @ts-ignore
      await task.restart(options);
      this.schedulePersist();
      return;
    }
    throw new Error("该任务不支持重试");
  }

  /**
   * 中断任务
   */
  interrupt(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.action.includes("interrupt")) {
      // @ts-ignore
      return task.interrupt();
    }
    return;
  }

  /**
   * 根据任务类型限制并发数
   */
  private taskLimit(maxNum: number, type: string): void {
    const pendingFFmpegTask = this.filter({ type: type, status: "pending" }).filter((task) => {
      if (task.starting) return false;
      if (task.manualStart && !task.autoStartWhenReady) return false;
      return isBetweenTimeRange(task.limitTime);
    });
    if (maxNum !== -1) {
      const runningTaskCount = this.queue.filter(
        (task) => task.type === type && (task.status === "running" || task.starting),
      ).length;

      if (runningTaskCount < maxNum) {
        pendingFFmpegTask.slice(0, maxNum - runningTaskCount).forEach((task) => {
          task.exec();
        });
      }
    } else {
      // TODO: 补充单元测试
      pendingFFmpegTask.forEach((task) => {
        task.exec();
      });
    }
  }

  /**
   * 根据配置限制各类型任务的并发数
   */
  private addTaskForLimit = (): void => {
    const config = this.appConfig.getAll();

    // ffmpeg任务
    this.taskLimit(config?.task?.ffmpegMaxNum ?? -1, TaskType.ffmpeg);
    // 斗鱼录播下载任务
    this.taskLimit(config?.task?.douyuDownloadMaxNum ?? -1, TaskType.douyuDownload);
    // B站上传任务
    this.taskLimit(config?.task?.biliUploadMaxNum ?? -1, TaskType.biliUpload);
    // B站下载任务
    this.taskLimit(config?.task?.biliDownloadMaxNum ?? -1, TaskType.biliDownload);
    // 同步任务
    this.taskLimit(config?.task?.syncMaxNum ?? 3, TaskType.sync);
  };
}
