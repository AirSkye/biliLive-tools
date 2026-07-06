import { trashItem } from "@biliLive-tools/shared/utils/index.js";
import log from "@biliLive-tools/shared/utils/log.js";
import path from "node:path";

/**
 * 文件引用计数管理器
 * 用于管理文件的引用计数，当计数归零且标记为需要删除时自动删除文件
 */
class FileRefManager {
  private refs: Map<
    string,
    {
      count: number;
      shouldDelete: boolean;
      filePath: string;
    }
  > = new Map();

  private normalizePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /**
   * 添加文件引用
   * @param filePath 文件路径
   * @param shouldDeleteOnZero 当引用计数归零时是否删除文件
   */
  addRef(filePath: string, shouldDeleteOnZero: boolean = false): void {
    const refKey = this.normalizePath(filePath);
    const ref = this.refs.get(refKey);
    if (ref) {
      ref.count++;
      // 如果任意一个引用要求删除，则标记为需要删除
      ref.shouldDelete = ref.shouldDelete || shouldDeleteOnZero;
      log.debug(`文件 ${filePath} 引用计数增加: ${ref.count} (shouldDelete: ${ref.shouldDelete})`);
    } else {
      this.refs.set(refKey, {
        count: 1,
        shouldDelete: shouldDeleteOnZero,
        filePath,
      });
      log.debug(`文件 ${filePath} 添加引用: count=1 (shouldDelete: ${shouldDeleteOnZero})`);
    }
  }

  /**
   * 释放文件引用
   * 当引用计数归零且标记为需要删除时，自动删除文件
   * @param filePath 文件路径
   * @returns Promise<void>
   */
  async releaseRef(filePath: string): Promise<void> {
    const refKey = this.normalizePath(filePath);
    const ref = this.refs.get(refKey);
    if (!ref) {
      // log.warn(`尝试释放不存在的文件引用: ${filePath}`);
      return;
    }

    ref.count--;
    log.debug(`文件 ${filePath} 引用计数减少: ${ref.count} (shouldDelete: ${ref.shouldDelete})`);

    if (ref.count === 0) {
      this.refs.delete(refKey);

      if (ref.shouldDelete) {
        // log.info(`文件 ${filePath} 引用计数归零，执行删除操作`);
        try {
          await trashItem(ref.filePath);
        } catch (error) {
          log.error(`删除文件失败: ${ref.filePath}`, error);
        }
      } else {
        // log.debug(`文件 ${filePath} 引用计数归零，但不需要删除`);
      }
    }
  }

  /**
   * 获取文件的引用计数
   * @param filePath 文件路径
   * @returns 引用计数（不存在返回0）
   */
  getRefCount(filePath: string): number {
    return this.refs.get(this.normalizePath(filePath))?.count ?? 0;
  }

  /**
   * 检查文件是否有引用
   * @param filePath 文件路径
   * @returns 是否有引用
   */
  hasRef(filePath: string): boolean {
    return this.refs.has(this.normalizePath(filePath));
  }

  /**
   * 获取文件的删除标志
   * @param filePath 文件路径
   * @returns 是否标记为需要删除
   */
  shouldDelete(filePath: string): boolean {
    return this.refs.get(this.normalizePath(filePath))?.shouldDelete ?? false;
  }

  /**
   * 获取所有有引用的文件列表（用于调试）
   * @returns 文件路径数组
   */
  getAllRefs(): Array<{ filePath: string; count: number; shouldDelete: boolean }> {
    return Array.from(this.refs.values()).map((ref) => ({
      filePath: ref.filePath,
      count: ref.count,
      shouldDelete: ref.shouldDelete,
    }));
  }

  /**
   * 清空所有引用（用于测试）
   */
  clear(): void {
    this.refs.clear();
  }
}

export default FileRefManager;
