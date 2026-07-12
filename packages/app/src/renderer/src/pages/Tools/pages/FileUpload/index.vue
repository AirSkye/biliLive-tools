<!-- 上传文件 -->
<template>
  <div>
    <template v-if="!localAuditOnly">
      <div class="flex justify-center align-center" style="margin-bottom: 20px; gap: 10px">
        <span v-if="fileList.length !== 0" style="cursor: pointer; color: #958e8e" @click="clear"
          >清空</span
        >
        <n-button @click="addVideo"> 添加 </n-button>
        <n-button type="primary" @click="upload" title="立即上传(ctrl+enter)"> 立即上传 </n-button>
        <n-button type="primary" @click="appendVideoVisible = true"> 续传 </n-button>
        <n-checkbox v-model:checked="options.removeOriginAfterUploadCheck">
          审核通过后移除源文件
        </n-checkbox>
      </div>
      <FileSelect
        ref="fileSelect"
        v-model="fileList"
        @change="fileChange"
        inputPlaceholder="输入内容将会被用为分P标题"
      ></FileSelect>

      <n-divider />
      <div class="" style="margin-top: 30px">
        <BiliSetting
          ref="biliSettingRef"
          v-model="options.uploadPresetId"
          @change="handlePresetOptions"
        ></BiliSetting>
      </div>

      <AppendVideoDialog
        v-model:visible="appendVideoVisible"
        v-model="aid"
        @confirm="appendVideo"
      ></AppendVideoDialog>
    </template>

    <component
      :is="localAuditContainer"
      v-if="localAuditOnly || localUploadedFilesVisible"
      v-model:show="localUploadedFilesVisible"
      preset="card"
      title="已上传未删除检测"
      :style="localAuditOnly ? undefined : 'width: min(1100px, 92vw)'"
      :class="{ 'local-audit-panel': localAuditOnly }"
      :bordered="false"
      :mask="false"
      :trap-focus="false"
      :auto-focus="false"
    >
      <div v-if="localAuditOnly" class="local-audit-header">
        <h2>本地录播检测</h2>
      </div>
      <div class="local-history-toolbar">
        <div class="local-detect-controls">
          <span>页数</span>
          <n-input-number
            v-model:value="localDetectOptions.pages"
            size="small"
            :min="1"
            :max="10"
            :precision="0"
            style="width: 82px"
          />
          <n-checkbox v-model:checked="localDetectOptions.useArchiveDetail">分P详情</n-checkbox>
          <span v-if="localDetectOptions.useArchiveDetail">间隔</span>
          <n-input-number
            v-if="localDetectOptions.useArchiveDetail"
            v-model:value="localDetectOptions.detailIntervalMs"
            size="small"
            :min="0"
            :max="10000"
            :step="500"
            :precision="0"
            style="width: 110px"
          />
          <span>未上传最小合计(MB)</span>
          <n-input-number
            v-model:value="localDetectOptions.minVideoSizeMb"
            size="small"
            :min="0"
            :max="10240"
            :step="10"
            :precision="0"
            style="width: 118px"
          />
          <n-select
            v-model:value="selectedLocalDetectStreamerKeys"
            multiple
            filterable
            clearable
            :loading="loadingLocalUploadStreamers"
            :options="localUploadStreamerSelectOptions"
            placeholder="选择主播后只扫描这些主播"
            style="min-width: 260px"
          />
        </div>
        <n-select
          v-model:value="selectedLocalDetectHistoryId"
          :options="localDetectHistoryOptions"
          clearable
          placeholder="选择历史检测结果"
          style="min-width: 320px"
          @update:value="loadSelectedLocalDetectHistory"
        />
        <n-button
          size="small"
          type="primary"
          :loading="detectingLocalUploadedFiles"
          @click="runLocalUploadedFilesScan"
        >
          重新扫描
        </n-button>
        <n-button
          size="small"
          :loading="loadingLocalDetectHistory"
          @click="refreshLocalDetectHistory"
        >
          刷新历史
        </n-button>
      </div>
      <div v-if="localUploadedFilesResult" class="detect-summary">
        <span>扫描文件：{{ localUploadedFilesResult.scannedFileCount }}</span>
        <span v-if="localUploadedFilesResult.skippedSmallUnuploadedGroupCount">
          未上传过滤：{{ localUploadedFilesResult.skippedSmallUnuploadedGroupCount }}
        </span>
        <span>稿件：{{ localUploadedFilesResult.archiveCount }}</span>
        <span>分P：{{ localUploadedFilesResult.remotePartCount }}</span>
        <span>匹配：{{ localUploadedFilesResult.matches.length }}</span>
        <span v-if="localInvalidMp4Rows.length">无效 MP4：{{ localInvalidMp4Rows.length }}</span>
        <span v-if="localDuplicateRows.length">同场重复：{{ localDuplicateRows.length }}</span>
      </div>
      <div v-if="localDetectProgress" class="detect-progress">
        <div class="detect-progress__header">
          <span>{{ localDetectProgress.stageLabel || "检测中" }}</span>
          <span v-if="localDetectProgress.total > 0">
            {{ localDetectProgress.processed }}/{{ localDetectProgress.total }}，剩余
            {{ localDetectProgress.remaining }}，{{ localDetectProgress.percent }}%
          </span>
        </div>
        <n-progress
          v-if="localDetectProgress.total > 0"
          type="line"
          :percentage="localDetectProgress.percent"
          :show-indicator="false"
        />
        <div class="detect-progress__message">
          {{ localDetectProgress.message }}
        </div>
        <div v-if="localDetectProgress.current" class="detect-progress__current">
          当前：{{ localDetectProgress.current }}
        </div>
      </div>
      <n-alert
        v-if="localUploadedFilesResult?.truncated"
        type="warning"
        style="margin-bottom: 12px"
      >
        扫描达到上限，仅展示前 20000 个视频文件的结果
      </n-alert>
      <n-alert
        v-if="localUploadedFilesResult?.errors.length"
        type="warning"
        style="margin-bottom: 12px"
      >
        {{ localUploadedFilesResult.errors.slice(0, 3).join("；") }}
      </n-alert>
      <n-alert
        v-if="localUploadedFilesResult?.warnings?.length"
        type="info"
        style="margin-bottom: 12px"
      >
        {{ (localUploadedFilesResult.warnings ?? []).slice(0, 5).join("；") }}
      </n-alert>
      <div v-if="localDetectLogs.length" class="detect-log">
        <div v-for="(item, index) in localDetectLogs" :key="index" class="detect-log__line">
          {{ item }}
        </div>
      </div>
      <div v-if="detectingLocalUploadedFiles && !localUploadedFilesResult" class="detect-loading">
        <n-spin size="small" />
        <span>检测中...</span>
      </div>
      <n-tabs
        v-if="localUploadedFilesResult || localDeletionHistoryRows.length"
        type="line"
        animated
      >
        <n-tab-pane name="uploaded" tab="已上传未删除">
          <div class="local-upload-toolbar">
            <n-button
              size="small"
              type="error"
              :loading="deletingLocalUploadedFiles"
              :disabled="selectedLocalUploadedFileKeys.length === 0"
              @click="deleteSelectedLocalUploadedFiles"
            >
              删除选中
            </n-button>
            <n-button
              size="small"
              type="error"
              secondary
              :loading="deletingLocalUploadedFiles"
              :disabled="localUploadedRows.length === 0"
              @click="deleteAllLocalUploadedFiles"
            >
              一键删除
            </n-button>
          </div>
          <n-empty v-if="localUploadedRows.length === 0" description="没有检测到疑似残留文件" />
          <n-data-table
            v-else
            v-model:checked-row-keys="selectedLocalUploadedFileKeys"
            :row-key="getLocalUploadedRowKey"
            :columns="localUploadedColumns"
            :data="localUploadedRows"
            :pagination="{ pageSize: 8 }"
            size="small"
          />
        </n-tab-pane>
        <n-tab-pane name="invalid-mp4" tab="无效 MP4">
          <div class="local-upload-toolbar">
            <n-button
              size="small"
              type="error"
              :loading="deletingLocalInvalidMp4Files"
              :disabled="selectedLocalInvalidMp4FileKeys.length === 0"
              @click="deleteSelectedLocalInvalidMp4Files"
            >
              删除选中
            </n-button>
            <n-button
              size="small"
              type="error"
              secondary
              :loading="deletingLocalInvalidMp4Files"
              :disabled="localInvalidMp4Rows.length === 0"
              @click="deleteAllLocalInvalidMp4Files"
            >
              一键删除
            </n-button>
          </div>
          <n-empty v-if="localInvalidMp4Rows.length === 0" description="没有检测到无效 MP4" />
          <n-data-table
            v-else
            v-model:checked-row-keys="selectedLocalInvalidMp4FileKeys"
            :row-key="getLocalInvalidMp4RowKey"
            :columns="localInvalidMp4Columns"
            :data="localInvalidMp4Rows"
            :pagination="{ pageSize: 8 }"
            size="small"
          />
        </n-tab-pane>
        <n-tab-pane name="duplicate" tab="同场重复">
          <div class="local-upload-toolbar">
            <n-button
              size="small"
              type="error"
              :loading="deletingLocalDuplicateFiles"
              :disabled="selectedLocalDuplicateFileKeys.length === 0"
              @click="deleteSelectedLocalDuplicateFiles"
            >
              删除选中
            </n-button>
            <n-button
              size="small"
              type="error"
              secondary
              :loading="deletingLocalDuplicateFiles"
              :disabled="localDuplicateRows.length === 0"
              @click="deleteAllLocalDuplicateFiles"
            >
              一键删除
            </n-button>
          </div>
          <n-empty v-if="localDuplicateRows.length === 0" description="没有检测到同场重复文件" />
          <n-data-table
            v-else
            v-model:checked-row-keys="selectedLocalDuplicateFileKeys"
            :row-key="getLocalDuplicateRowKey"
            :columns="localDuplicateColumns"
            :data="localDuplicateRows"
            :pagination="{ pageSize: 8 }"
            size="small"
          />
        </n-tab-pane>
        <n-tab-pane name="unuploaded" tab="本地未上传">
          <div class="local-upload-toolbar">
            <n-input
              v-model:value="localUnuploadedSearchKeyword"
              clearable
              placeholder="搜索标题、主播、房间号或文件名"
              style="width: 260px"
            />
            <n-select
              v-model:value="localUnuploadedSortKey"
              :options="localUnuploadedSortOptions"
              style="width: 180px"
            />
            <n-checkbox v-model:checked="localUploadOptions.uploadRawWhenNoDanmu">
              压制时弹幕不存在则上传原视频
            </n-checkbox>
            <n-checkbox v-model:checked="localUploadOptions.mergeSegments">
              上传前选择合并分段
            </n-checkbox>
            <n-button size="small" @click="selectAllLocalUnuploadedGroups"> 全选全部 </n-button>
            <n-button size="small" @click="clearSelectedLocalUploadGroups"> 清空选择 </n-button>
            <n-button
              size="small"
              :loading="uploadingLocalUnuploaded"
              :disabled="uploadingLocalUnuploaded || selectedLocalUploadGroupIds.length === 0"
              @click="uploadSelectedLocalGroups('direct')"
            >
              直接上传选中
            </n-button>
            <n-button
              type="primary"
              size="small"
              :loading="uploadingLocalUnuploaded"
              :disabled="uploadingLocalUnuploaded || selectedLocalUploadGroupIds.length === 0"
              @click="uploadSelectedLocalGroups('burn')"
            >
              压制上传选中
            </n-button>
          </div>
          <n-empty v-if="localUnuploadedRows.length === 0" description="没有检测到本地未上传文件" />
          <n-data-table
            v-else
            v-model:checked-row-keys="selectedLocalUploadGroupIds"
            :row-key="getLocalUnuploadedRowKey"
            :columns="localUnuploadedColumns"
            :data="localUnuploadedRows"
            :pagination="{ pageSize: 8 }"
            size="small"
          />
        </n-tab-pane>
        <n-tab-pane name="deletions" tab="历史删除">
          <div class="local-upload-toolbar">
            <span>删除记录：{{ localDeletionHistoryRows.length }}</span>
            <n-button
              size="small"
              :loading="loadingLocalDetectHistory"
              @click="loadLocalDeletionHistory"
            >
              刷新
            </n-button>
          </div>
          <n-empty v-if="localDeletionHistoryRows.length === 0" description="没有历史删除记录" />
          <n-data-table
            v-else
            :row-key="getLocalDeletionRowKey"
            :columns="localDeletionColumns"
            :data="localDeletionHistoryRows"
            :pagination="{ pageSize: 8 }"
            size="small"
          />
        </n-tab-pane>
      </n-tabs>
    </component>
    <n-modal
      v-model:show="localMergeDialogVisible"
      preset="card"
      title="选择待合并分段"
      style="width: min(980px, 92vw)"
      :bordered="false"
      :trap-focus="false"
      :auto-focus="false"
    >
      <div class="local-upload-toolbar">
        <span>可合并分组：{{ localMergeRows.length }}</span>
        <n-button size="small" @click="selectAllMergeGroups"> 全选全部 </n-button>
        <n-button size="small" @click="clearMergeGroups"> 清空选择 </n-button>
      </div>
      <n-empty v-if="localMergeRows.length === 0" description="没有待合并分段" />
      <n-data-table
        v-else
        v-model:checked-row-keys="selectedMergeGroupIds"
        :row-key="getLocalUnuploadedRowKey"
        :columns="localMergeColumns"
        :data="localMergeRows"
        :pagination="{ pageSize: 6 }"
        size="small"
      />
      <template #footer>
        <div class="local-dialog-footer">
          <n-button @click="cancelLocalMergeSelection">返回</n-button>
          <n-button
            type="primary"
            :loading="uploadingLocalUnuploaded"
            :disabled="uploadingLocalUnuploaded"
            @click="confirmLocalMergeSelection"
          >
            加入上传流程
          </n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { toReactive, useLocalStorage } from "@vueuse/core";
import { NButton, NModal, useNotification } from "naive-ui";
import type { DataTableColumns, DataTableRowKey } from "naive-ui";

import FileSelect from "@renderer/pages/Tools/pages/FileUpload/components/FileSelect.vue";
import BiliSetting from "@renderer/components/BiliSetting.vue";
import AppendVideoDialog from "@renderer/components/AppendVideoDialog.vue";
import { useBili, useConfirm } from "@renderer/hooks";
import { useUserInfoStore, useAppConfig } from "@renderer/stores";
import { biliApi, fileBrowserApi } from "@renderer/apis";
import hotkeys from "hotkeys-js";

import { deepRaw } from "@renderer/utils";
import type {
  LocalDetectedDeletionItem,
  LocalDuplicateVideoFile,
  LocalInvalidMp4File,
  LocalUploadedFileDeletionRecord,
  LocalUploadedFilesDetectionProgress,
  LocalUploadedFilesHistorySummary,
  LocalUploadedFileMatch,
  LocalUploadedFilesResult,
  LocalUploadStreamerOption,
  LocalUnuploadedGroup,
} from "@renderer/apis/bili";

defineOptions({
  name: "Upload",
});

const props = withDefaults(
  defineProps<{
    localAuditOnly?: boolean;
  }>(),
  {
    localAuditOnly: false,
  },
);
const localAuditOnly = computed(() => props.localAuditOnly);
const localAuditContainer = computed(() => (localAuditOnly.value ? "div" : NModal));

const { userInfo } = storeToRefs(useUserInfoStore());
const { handlePresetOptions, presetOptions } = useBili();
const appConfigStore = useAppConfig();
const { appConfig } = storeToRefs(appConfigStore);

const notice = useNotification();
const confirm = useConfirm();

const options = toReactive(
  computed({
    get: () => appConfig.value.tool.upload,
    set: (value) => {
      appConfig.value.tool.upload = value;
    },
  }),
);

const fileList = ref<
  {
    id: string;
    title: string;
    path: string;
    visible: boolean;
    ext?: string;
  }[]
>([]);

onActivated(() => {
  hotkeys("ctrl+enter", function () {
    if (localAuditOnly.value) return;
    upload();
  });
});
onDeactivated(() => {
  hotkeys.unbind();
});
onUnmounted(() => {
  hotkeys.unbind();
});

const upload = async () => {
  const hasLogin = !!userInfo.value.uid;
  if (!hasLogin) {
    notice.error({
      title: `请点击左侧头像处先进行登录`,
      duration: 1000,
    });
    return;
  }

  if (fileList.value.length === 0) {
    notice.error({
      title: `至少选择一个文件`,
      duration: 1000,
    });
    return;
  }
  const uploadConfig = deepRaw(presetOptions.value.config) as typeof presetOptions.value.config;
  await biliApi.validUploadParams(uploadConfig);

  // 后端会处理标题格式化、转载来源等逻辑
  const videos = deepRaw(fileList.value);

  await biliApi.upload({
    uid: userInfo.value.uid!,
    videos,
    config: uploadConfig,
    options: {
      removeOriginAfterUploadCheck: options.removeOriginAfterUploadCheck,
    },
  });
  fileList.value = [];
};

const appendVideoVisible = ref(false);
const aid = ref();
const appendVideo = async () => {
  if (!aid.value) {
    return;
  }

  const hasLogin = !!userInfo.value.uid;
  if (!hasLogin) {
    notice.error({
      title: `请点击左侧头像处先进行登录`,
      duration: 1000,
    });
    return;
  }

  if (fileList.value.length === 0) {
    notice.error({
      title: `至少选择一个文件`,
      duration: 1000,
    });
    return;
  }

  notice.info({
    title: `开始上传`,
    duration: 1000,
  });

  const uploadConfig = deepRaw(presetOptions.value.config);
  const videos = deepRaw(fileList.value);

  // 后端会处理分P标题格式化等逻辑
  await biliApi.upload({
    uid: userInfo.value.uid!,
    vid: Number(aid.value),
    videos,
    config: {
      ...uploadConfig,
    },
    options: {
      removeOriginAfterUploadCheck: options.removeOriginAfterUploadCheck,
    },
  });
  fileList.value = [];
};

const fileSelect = ref<InstanceType<typeof FileSelect> | null>(null);
const addVideo = async () => {
  fileSelect.value?.select();
};
const clear = () => {
  fileList.value = [];
};

const localUploadedFilesVisible = ref(localAuditOnly.value);
const detectingLocalUploadedFiles = ref(false);
const loadingLocalDetectHistory = ref(false);
const localUploadedFilesResult = ref<LocalUploadedFilesResult | null>(null);
const localDetectProgress = ref<LocalUploadedFilesDetectionProgress | null>(null);
const localDetectLogs = ref<string[]>([]);
const localDetectHistoryItems = ref<LocalUploadedFilesHistorySummary[]>([]);
const selectedLocalDetectHistoryId = ref<string | null>(null);
const localDeletionHistoryRows = ref<LocalUploadedFileDeletionRecord[]>([]);
const localDetectOptions = useLocalStorage("file-upload-local-detect-options", {
  pages: 3,
  useArchiveDetail: true,
  detailIntervalMs: 1500,
  minVideoSizeMb: 0,
});
const loadingLocalUploadStreamers = ref(false);
const localUploadStreamers = ref<LocalUploadStreamerOption[]>([]);
const selectedLocalDetectStreamerKeys = useLocalStorage<string[]>(
  "file-upload-local-detect-streamers",
  [],
);
const localUploadStreamerSelectOptions = computed(() =>
  [...localUploadStreamers.value]
    .sort((left, right) => {
      const sizeCompare = (right.localSizeBytes ?? 0) - (left.localSizeBytes ?? 0);
      if (sizeCompare !== 0) return sizeCompare;
      const nameCompare = (left.name || "").localeCompare(right.name || "", "zh-Hans-CN");
      if (nameCompare !== 0) return nameCompare;
      return left.roomId.localeCompare(right.roomId);
    })
    .map((item) => {
      const folderText =
        item.localFolderCount > 1
          ? ` · ${item.localFolderCount} 个目录`
          : item.localFolderCount === 0
            ? " · 未找到目录"
            : "";
      return {
        label: `${item.name || "未知"} (${item.roomId}) · ${formatFileSize(
          item.localSizeBytes ?? 0,
        )}${folderText}`,
        value: item.key,
      };
    }),
);
const localUploadStreamerByKey = computed(() => {
  const map = new Map<string, LocalUploadStreamerOption>();
  for (const item of localUploadStreamers.value) map.set(item.key, item);
  return map;
});
const getSelectedLocalDetectStreamers = () =>
  selectedLocalDetectStreamerKeys.value
    .map((key) => localUploadStreamerByKey.value.get(String(key)))
    .filter((item): item is LocalUploadStreamerOption => !!item)
    .map((item) => ({
      roomId: item.roomId,
      platform: item.platform,
    }));
const localDetectHistoryOptions = computed(() =>
  localDetectHistoryItems.value.map((item) => ({
    label: `${new Date(item.createdAt).toLocaleString()} | 残留 ${item.matchCount}/${item.initialMatchCount} | 无效MP4 ${item.invalidMp4Count ?? 0} | 同场重复 ${
      item.duplicateFileCount ?? 0
    } | 未上传 ${item.unuploadedGroupCount} | 已删 ${item.deletedCount}`,
    value: item.id,
  })),
);
const localUploadedRows = computed(() => localUploadedFilesResult.value?.matches ?? []);
const localInvalidMp4Rows = computed(() => localUploadedFilesResult.value?.invalidMp4Files ?? []);
const localDuplicateRows = computed(() => localUploadedFilesResult.value?.duplicateFiles ?? []);
const selectedLocalUploadedFileKeys = ref<DataTableRowKey[]>([]);
const selectedLocalInvalidMp4FileKeys = ref<DataTableRowKey[]>([]);
const selectedLocalDuplicateFileKeys = ref<DataTableRowKey[]>([]);
const deletingLocalUploadedFiles = ref(false);
const deletingLocalInvalidMp4Files = ref(false);
const deletingLocalDuplicateFiles = ref(false);
type LocalUnuploadedSortKey =
  | "startTimeDesc"
  | "startTimeAsc"
  | "fileCountDesc"
  | "fileCountAsc"
  | "totalSizeDesc"
  | "totalSizeAsc";
const localUnuploadedSearchKeyword = ref("");
const localUnuploadedSortKey = ref<LocalUnuploadedSortKey>("startTimeDesc");
const localUnuploadedSortOptions = [
  { label: "时间从新到旧", value: "startTimeDesc" },
  { label: "时间从旧到新", value: "startTimeAsc" },
  { label: "文件数量从多到少", value: "fileCountDesc" },
  { label: "文件数量从少到多", value: "fileCountAsc" },
  { label: "总大小从大到小", value: "totalSizeDesc" },
  { label: "总大小从小到大", value: "totalSizeAsc" },
];
const localUnuploadedRows = computed(() => {
  const keyword = localUnuploadedSearchKeyword.value.trim().toLowerCase();
  const rows = [...(localUploadedFilesResult.value?.unuploadedGroups ?? [])].filter((row) => {
    if (!keyword) return true;
    return [
      row.title,
      row.username,
      row.roomId,
      row.archiveTitle,
      ...row.files.map((file) => file.fileName),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });

  const direction = localUnuploadedSortKey.value.endsWith("Asc") ? 1 : -1;
  const key = localUnuploadedSortKey.value.replace(/Asc|Desc$/, "") as
    | "startTime"
    | "fileCount"
    | "totalSize";
  return rows.sort((left, right) => {
    const diff = Number(left[key] ?? 0) - Number(right[key] ?? 0);
    if (diff !== 0) return diff * direction;
    return right.startTime - left.startTime;
  });
});
const selectedLocalUploadGroupIds = ref<DataTableRowKey[]>([]);
const uploadingLocalUnuploaded = ref(false);
type QueuedLocalUploadRecord = {
  key: string;
  queuedAt: number;
};
type LocalUploadStatusItem = {
  key: string;
  status: "missing" | "queued" | "running" | "completed" | "error";
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  error?: string;
};
const LOCAL_UPLOAD_QUEUE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const queuedLocalUploadRecords = useLocalStorage<QueuedLocalUploadRecord[]>(
  "file-upload-local-queued-upload-records",
  [],
);
const localUploadOptions = reactive({
  uploadRawWhenNoDanmu: true,
  mergeSegments: true,
});
type PendingLocalUploadGroup = {
  row: LocalUnuploadedGroup;
  burnDanmu: boolean;
  uploadRawWhenNoDanmu: boolean;
};
type LocalUploadRunMode = "direct" | "burn";
const localMergeDialogVisible = ref(false);
const pendingLocalUploadGroups = ref<PendingLocalUploadGroup[]>([]);
const selectedMergeGroupIds = ref<DataTableRowKey[]>([]);
const getLocalUploadedRowKey = (row: LocalUploadedFileMatch) => row.localPath;
const getLocalInvalidMp4RowKey = (row: LocalInvalidMp4File) => row.localPath;
const getLocalDuplicateRowKey = (row: LocalDuplicateVideoFile) => row.localPath;
const getLocalUnuploadedRowKey = (row: LocalUnuploadedGroup) => row.id;
const getLocalDeletionRowKey = (row: LocalUploadedFileDeletionRecord) => row.id;
const activeLocalUploadStatuses = new Set(["queued", "running", "completed"]);
const getQueuedLocalUploadKeySet = () => {
  const now = Date.now();
  return new Set(
    queuedLocalUploadRecords.value
      .filter((item) => item.key && now - item.queuedAt <= LOCAL_UPLOAD_QUEUE_TTL_MS)
      .map((item) => item.key),
  );
};
const pruneQueuedLocalUploadRecords = () => {
  const now = Date.now();
  const activeRecords = queuedLocalUploadRecords.value.filter(
    (item) => item.key && now - item.queuedAt <= LOCAL_UPLOAD_QUEUE_TTL_MS,
  );
  if (activeRecords.length !== queuedLocalUploadRecords.value.length) {
    queuedLocalUploadRecords.value = activeRecords;
  }
  return activeRecords;
};
const removeQueuedLocalUploadRecords = (keys: string[]) => {
  if (keys.length === 0) return;
  const keySet = new Set(keys);
  queuedLocalUploadRecords.value = pruneQueuedLocalUploadRecords().filter(
    (item) => !keySet.has(item.key),
  );
};
const isLocalUnuploadedGroupQueued = (row: LocalUnuploadedGroup) =>
  activeLocalUploadStatuses.has(row.uploadStatus || "") ||
  getQueuedLocalUploadKeySet().has(row.uploadKey);
const getEligibleLocalUnuploadedRows = () =>
  localUnuploadedRows.value.filter(
    (row) => row.roomId && row.hasWebhookUploadConfig && !isLocalUnuploadedGroupQueued(row),
  );
const selectAllLocalUnuploadedGroups = () => {
  selectedLocalUploadGroupIds.value = getEligibleLocalUnuploadedRows().map((row) => row.id);
};
const clearSelectedLocalUploadGroups = () => {
  selectedLocalUploadGroupIds.value = [];
};
const localMergeRows = computed(() =>
  pendingLocalUploadGroups.value
    .map((item) => item.row)
    .filter((row) => row.mergeCandidate)
    .sort((left, right) => right.totalSize - left.totalSize),
);
const selectAllMergeGroups = () => {
  selectedMergeGroupIds.value = localMergeRows.value.map((row) => row.id);
};
const clearMergeGroups = () => {
  selectedMergeGroupIds.value = [];
};

let localDetectPollingRunId = 0;
let localDetectLogCursor = 0;
const pushLocalDetectLog = (message: string) => {
  localDetectLogs.value.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (localDetectLogs.value.length > 1200) {
    localDetectLogs.value.splice(0, localDetectLogs.value.length - 1200);
  }
};
const waitLocalDetectPoll = (ms: number) =>
  new Promise((resolve) => window.setTimeout(resolve, ms));
const syncLocalDetectProgress = (progress: LocalUploadedFilesDetectionProgress) => {
  localDetectProgress.value = progress;
  const logs = progress.logs ?? [];
  for (const item of logs.slice(localDetectLogCursor)) pushLocalDetectLog(item);
  localDetectLogCursor = logs.length;
};
const applyLocalUploadStatuses = (items: LocalUploadStatusItem[]) => {
  const failedItems = items.filter((item) => item.status === "error" || item.status === "missing");
  removeQueuedLocalUploadRecords(failedItems.map((item) => item.key));

  if (!localUploadedFilesResult.value || items.length === 0) return failedItems;

  const itemByKey = new Map(items.map((item) => [item.key, item]));
  localUploadedFilesResult.value.unuploadedGroups =
    localUploadedFilesResult.value.unuploadedGroups.map((row) => {
      const item = itemByKey.get(row.uploadKey);
      if (!item) return row;
      if (item.status === "missing") {
        const { uploadStatus, uploadQueuedAt, uploadUpdatedAt, uploadError, ...rest } = row;
        return rest;
      }
      return {
        ...row,
        uploadStatus: item.status,
        uploadQueuedAt: item.createdAt ?? row.uploadQueuedAt,
        uploadUpdatedAt: item.updatedAt ?? row.uploadUpdatedAt,
        uploadError: item.error,
      };
    });

  return failedItems;
};
const refreshLocalUploadStatuses = async (keys: string[]) => {
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  if (uniqueKeys.length === 0) return [];
  const result = await biliApi.getLocalUnuploadedUploadStatuses(uniqueKeys);
  return applyLocalUploadStatuses(result.items);
};
const monitorLocalUploadStatuses = async (keys: string[]) => {
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  if (uniqueKeys.length === 0) return;

  for (let attempt = 0; attempt < 8; attempt++) {
    await waitLocalDetectPoll(attempt === 0 ? 1200 : 1500);
    try {
      const result = await biliApi.getLocalUnuploadedUploadStatuses(uniqueKeys);
      const failedItems = applyLocalUploadStatuses(result.items);
      if (failedItems.length > 0) {
        const first = failedItems[0];
        notice.error({
          title: "本地补传未进入上传队列",
          content:
            first.status === "missing"
              ? "未查询到这次补传记录，请重新扫描后再试"
              : first.error || "后端创建上传任务失败",
          duration: 6000,
        });
        return;
      }
      const pending = result.items.some(
        (item) => item.status === "queued" || item.status === "running",
      );
      if (!pending) return;
    } catch (error) {
      pushLocalDetectLog(
        `刷新本地补传状态失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  }
};
const resetLocalDetectView = () => {
  localDetectProgress.value = null;
  localUnuploadedSearchKeyword.value = "";
  selectedLocalUploadedFileKeys.value = [];
  selectedLocalInvalidMp4FileKeys.value = [];
  selectedLocalDuplicateFileKeys.value = [];
  selectedLocalUploadGroupIds.value = [];
  pendingLocalUploadGroups.value = [];
  selectedMergeGroupIds.value = [];
  localDetectLogs.value = [];
  localDetectLogCursor = 0;
};
const resetLocalUnuploadedSelection = () => {
  selectedLocalUploadGroupIds.value = [];
};
const applyLocalUploadedFilesResult = (result: LocalUploadedFilesResult) => {
  localUploadedFilesResult.value = result;
  selectedLocalDetectHistoryId.value = result.historyId ?? selectedLocalDetectHistoryId.value;
  resetLocalUnuploadedSelection();
  const queuedKeySet = getQueuedLocalUploadKeySet();
  const statusKeys = result.unuploadedGroups
    .filter(
      (row) =>
        activeLocalUploadStatuses.has(row.uploadStatus || "") || queuedKeySet.has(row.uploadKey),
    )
    .map((row) => row.uploadKey);
  if (statusKeys.length > 0) {
    void refreshLocalUploadStatuses(statusKeys).catch((error) => {
      pushLocalDetectLog(
        `刷新本地补传状态失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
};
const loadLocalDetectHistoryList = async () => {
  if (!userInfo.value.uid) return null;
  const data = await biliApi.getLocalUploadedFilesHistory(userInfo.value.uid);
  localDetectHistoryItems.value = data.items;
  return data.latest;
};
const loadLocalUploadStreamers = async () => {
  loadingLocalUploadStreamers.value = true;
  try {
    const data = await biliApi.getLocalUploadStreamers();
    localUploadStreamers.value = data.items;
    const availableKeys = new Set(data.items.map((item) => item.key));
    selectedLocalDetectStreamerKeys.value = selectedLocalDetectStreamerKeys.value.filter((key) =>
      availableKeys.has(String(key)),
    );
  } catch (error) {
    pushLocalDetectLog(
      `加载主播列表失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    loadingLocalUploadStreamers.value = false;
  }
};
const loadLocalDeletionHistory = async () => {
  if (!userInfo.value.uid) return;
  const data = await biliApi.getLocalUploadedFileDeletions(userInfo.value.uid, { limit: 300 });
  localDeletionHistoryRows.value = data.items;
};
const loadLocalDetectHistoryById = async (id: string) => {
  if (!userInfo.value.uid) return;
  const item = await biliApi.getLocalUploadedFilesHistoryItem(id, userInfo.value.uid);
  selectedLocalDetectHistoryId.value = item.id;
  applyLocalUploadedFilesResult(item.result);
  localDetectProgress.value = {
    id: item.id,
    status: "completed",
    stage: "completed",
    stageLabel: "历史检测结果",
    message: `已加载 ${new Date(item.createdAt).toLocaleString()} 的检测结果`,
    current: "历史缓存",
    processed: 1,
    total: 1,
    remaining: 0,
    percent: 100,
    logs: [],
    result: item.result,
    startedAt: item.createdAt,
    updatedAt: item.createdAt,
    completedAt: item.createdAt,
  };
  localDetectLogs.value = (item.result.logs ?? []).map(
    (message) => `[${new Date(item.createdAt).toLocaleTimeString()}] ${message}`,
  );
  localDetectLogCursor = item.result.logs?.length ?? 0;
};
const refreshLocalDetectHistory = async () => {
  loadingLocalDetectHistory.value = true;
  try {
    const [latest] = await Promise.all([
      loadLocalDetectHistoryList(),
      loadLocalDeletionHistory(),
      loadLocalUploadStreamers(),
    ]);
    const currentId = selectedLocalDetectHistoryId.value;
    const currentExists =
      !!currentId && localDetectHistoryItems.value.some((item) => item.id === currentId);
    const targetId = currentExists ? currentId : latest?.id;
    if (targetId) {
      await loadLocalDetectHistoryById(targetId);
    } else {
      localUploadedFilesResult.value = null;
      selectedLocalDetectHistoryId.value = null;
      pushLocalDetectLog("没有历史检测结果，请点击“重新扫描”生成一次检测结果");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLocalDetectLog(`刷新历史失败：${message}`);
    notice.error({
      title: "刷新历史失败",
      content: message,
      duration: 4000,
    });
  } finally {
    loadingLocalDetectHistory.value = false;
  }
};
const loadSelectedLocalDetectHistory = async (id: string | null) => {
  if (!id) return;
  loadingLocalDetectHistory.value = true;
  try {
    await loadLocalDetectHistoryById(id);
  } catch (error) {
    pushLocalDetectLog(`加载历史失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    loadingLocalDetectHistory.value = false;
  }
};
const openLocalUploadedFilesPanel = async () => {
  localUploadedFilesVisible.value = true;
  if (localUploadStreamers.value.length === 0) {
    await loadLocalUploadStreamers();
  }
  if (!userInfo.value.uid) {
    notice.error({
      title: `请点击左侧头像处先进行登录`,
      duration: 1000,
    });
    return;
  }
  resetLocalDetectView();
  loadingLocalDetectHistory.value = true;
  try {
    const [latest] = await Promise.all([
      loadLocalDetectHistoryList(),
      loadLocalDeletionHistory(),
      loadLocalUploadStreamers(),
    ]);
    if (latest) {
      await loadLocalDetectHistoryById(latest.id);
    } else {
      localUploadedFilesResult.value = null;
      selectedLocalDetectHistoryId.value = null;
      pushLocalDetectLog("没有历史检测结果，请点击“重新扫描”生成一次检测结果");
    }
  } catch (error) {
    pushLocalDetectLog(`加载历史失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    loadingLocalDetectHistory.value = false;
  }
};
let localAuditPageInitialized = false;
const ensureLocalAuditPageReady = async () => {
  if (!localAuditOnly.value || localAuditPageInitialized) return;
  localAuditPageInitialized = true;
  await openLocalUploadedFilesPanel();
};
watch(
  localAuditOnly,
  (value) => {
    if (value) {
      localUploadedFilesVisible.value = true;
      void ensureLocalAuditPageReady();
      return;
    }
    localUploadedFilesVisible.value = false;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  localDetectPollingRunId += 1;
});

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${Math.round(size)} B`;
}

const formatShortReason = (reason?: string) => {
  const text = String(reason || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "-";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
};

const openLocalFolder = (filePath: string) => {
  window.api.openPath(window.path.dirname(filePath));
};

const openBiliArchive = (row: LocalUploadedFileMatch) => {
  const url = row.bvid
    ? `https://www.bilibili.com/video/${row.bvid}${row.page ? `?p=${row.page}` : ""}`
    : `https://www.bilibili.com/video/av${row.aid}${row.page ? `?p=${row.page}` : ""}`;
  window.api.openExternal(url);
};

const deleteLocalDetectedFiles = async (
  rows: LocalDetectedDeletionItem[],
  kind: "uploaded" | "invalidMp4" | "duplicate",
) => {
  const deleting =
    kind === "uploaded"
      ? deletingLocalUploadedFiles.value
      : kind === "invalidMp4"
        ? deletingLocalInvalidMp4Files.value
        : deletingLocalDuplicateFiles.value;
  if (rows.length === 0 || deleting) return;
  const label =
    kind === "uploaded"
      ? "已上传残留文件"
      : kind === "invalidMp4"
        ? "无效 MP4 文件"
        : "同场重复文件";
  const [confirmed] = await confirm.warning({
    title: "确认删除",
    content: `确定删除 ${rows.length} 个${label}吗？此操作不可撤销。`,
    positiveText: "删除",
    negativeText: "取消",
  });
  if (!confirmed) return;

  if (kind === "uploaded") {
    deletingLocalUploadedFiles.value = true;
  } else if (kind === "invalidMp4") {
    deletingLocalInvalidMp4Files.value = true;
  } else {
    deletingLocalDuplicateFiles.value = true;
  }
  const deletedPaths = new Set<string>();
  const deletedRows: LocalDetectedDeletionItem[] = [];
  const failed: string[] = [];
  const historyId = localUploadedFilesResult.value?.historyId;
  try {
    for (const row of rows) {
      try {
        await fileBrowserApi.removeFile(row.localPath);
        deletedPaths.add(row.localPath);
        deletedRows.push(row);
        pushLocalDetectLog(
          `已删除${
            kind === "uploaded" ? "残留文件" : kind === "invalidMp4" ? "无效 MP4" : "同场重复文件"
          }：${row.fileName}`,
        );
      } catch (error) {
        failed.push(`${row.fileName}：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (localUploadedFilesResult.value && deletedPaths.size > 0) {
      if (kind === "uploaded") {
        localUploadedFilesResult.value.matches = localUploadedFilesResult.value.matches.filter(
          (row) => !deletedPaths.has(row.localPath),
        );
      } else if (kind === "invalidMp4") {
        localUploadedFilesResult.value.invalidMp4Files = (
          localUploadedFilesResult.value.invalidMp4Files ?? []
        ).filter((row) => !deletedPaths.has(row.localPath));
      } else {
        localUploadedFilesResult.value.duplicateFiles = (
          localUploadedFilesResult.value.duplicateFiles ?? []
        ).filter((row) => !deletedPaths.has(row.localPath));
      }
    }
    if (kind === "uploaded") {
      selectedLocalUploadedFileKeys.value = selectedLocalUploadedFileKeys.value.filter(
        (key) => !deletedPaths.has(String(key)),
      );
    } else if (kind === "invalidMp4") {
      selectedLocalInvalidMp4FileKeys.value = selectedLocalInvalidMp4FileKeys.value.filter(
        (key) => !deletedPaths.has(String(key)),
      );
    } else {
      selectedLocalDuplicateFileKeys.value = selectedLocalDuplicateFileKeys.value.filter(
        (key) => !deletedPaths.has(String(key)),
      );
    }

    if (deletedRows.length > 0) {
      try {
        const recordResult = await biliApi.recordLocalUploadedFileDeletions({
          uid: userInfo.value.uid,
          historyId,
          items: deletedRows,
        });
        localDeletionHistoryRows.value = [
          ...recordResult.items,
          ...localDeletionHistoryRows.value.filter(
            (item) => !recordResult.items.some((record) => record.id === item.id),
          ),
        ];
        await loadLocalDetectHistoryList();
      } catch (error) {
        pushLocalDetectLog(
          `写入删除历史失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (deletedPaths.size > 0) {
      notice.success({
        title: "删除完成",
        content: `已删除 ${deletedPaths.size} 个${label}`,
        duration: 3000,
      });
    }
    if (failed.length > 0) {
      notice.warning({
        title: "部分文件删除失败",
        content: failed.slice(0, 3).join("；"),
        duration: 5000,
      });
      for (const item of failed) pushLocalDetectLog(`删除失败：${item}`);
    }
  } finally {
    if (kind === "uploaded") {
      deletingLocalUploadedFiles.value = false;
    } else if (kind === "invalidMp4") {
      deletingLocalInvalidMp4Files.value = false;
    } else {
      deletingLocalDuplicateFiles.value = false;
    }
  }
};

const deleteLocalUploadedFiles = async (rows: LocalUploadedFileMatch[]) => {
  await deleteLocalDetectedFiles(rows, "uploaded");
};

const deleteLocalInvalidMp4Files = async (rows: LocalInvalidMp4File[]) => {
  await deleteLocalDetectedFiles(rows, "invalidMp4");
};

const deleteLocalDuplicateFiles = async (rows: LocalDuplicateVideoFile[]) => {
  await deleteLocalDetectedFiles(rows, "duplicate");
};

const deleteSelectedLocalUploadedFiles = async () => {
  const selectedKeys = new Set(selectedLocalUploadedFileKeys.value.map((item) => String(item)));
  await deleteLocalUploadedFiles(
    localUploadedRows.value.filter((row) => selectedKeys.has(getLocalUploadedRowKey(row))),
  );
};

const deleteAllLocalUploadedFiles = async () => {
  await deleteLocalUploadedFiles(localUploadedRows.value);
};

const deleteSelectedLocalInvalidMp4Files = async () => {
  const selectedKeys = new Set(selectedLocalInvalidMp4FileKeys.value.map((item) => String(item)));
  await deleteLocalInvalidMp4Files(
    localInvalidMp4Rows.value.filter((row) => selectedKeys.has(getLocalInvalidMp4RowKey(row))),
  );
};

const deleteAllLocalInvalidMp4Files = async () => {
  await deleteLocalInvalidMp4Files(localInvalidMp4Rows.value);
};

const deleteSelectedLocalDuplicateFiles = async () => {
  const selectedKeys = new Set(selectedLocalDuplicateFileKeys.value.map((item) => String(item)));
  await deleteLocalDuplicateFiles(
    localDuplicateRows.value.filter((row) => selectedKeys.has(getLocalDuplicateRowKey(row))),
  );
};

const deleteAllLocalDuplicateFiles = async () => {
  await deleteLocalDuplicateFiles(localDuplicateRows.value);
};

const localUploadedColumns: DataTableColumns<LocalUploadedFileMatch> = [
  {
    type: "selection",
  },
  {
    title: "本地文件",
    key: "fileName",
    minWidth: 220,
    render: (row) => h("span", { title: row.localPath }, row.fileName),
  },
  {
    title: "大小",
    key: "size",
    width: 110,
    sorter: (left, right) => left.size - right.size,
    render: (row) => formatFileSize(row.size),
  },
  {
    title: "稿件",
    key: "archiveTitle",
    minWidth: 220,
    render: (row) => h("span", { title: `AV${row.aid}` }, row.archiveTitle || `AV${row.aid}`),
  },
  {
    title: "分P",
    key: "partTitle",
    minWidth: 160,
    render: (row) => row.partTitle || row.remoteFilename || "-",
  },
  {
    title: "置信度",
    key: "confidence",
    width: 90,
    render: (row) => (row.confidence === "high" ? "高" : "中"),
  },
  {
    title: "原因",
    key: "reason",
    minWidth: 150,
  },
  {
    title: "修改时间",
    key: "mtimeMs",
    width: 170,
    sorter: (left, right) => left.mtimeMs - right.mtimeMs,
    render: (row) => new Date(row.mtimeMs).toLocaleString(),
  },
  {
    title: "操作",
    key: "actions",
    width: 240,
    render: (row) =>
      h(
        "div",
        {
          style: "display: flex; gap: 8px;",
        },
        [
          h(
            NButton,
            {
              size: "small",
              onClick: () => openLocalFolder(row.localPath),
            },
            { default: () => "打开目录" },
          ),
          h(
            NButton,
            {
              size: "small",
              onClick: () => openBiliArchive(row),
            },
            { default: () => "打开稿件" },
          ),
          h(
            NButton,
            {
              size: "small",
              type: "error",
              disabled: deletingLocalUploadedFiles.value,
              onClick: () => deleteLocalUploadedFiles([row]),
            },
            { default: () => "删除" },
          ),
        ],
      ),
  },
];

const localInvalidMp4Columns: DataTableColumns<LocalInvalidMp4File> = [
  {
    type: "selection",
  },
  {
    title: "本地文件",
    key: "fileName",
    minWidth: 260,
    render: (row) => h("span", { title: row.localPath }, row.fileName),
  },
  {
    title: "大小",
    key: "size",
    width: 110,
    sorter: (left, right) => left.size - right.size,
    render: (row) => formatFileSize(row.size),
  },
  {
    title: "原因",
    key: "reason",
    minWidth: 260,
    render: (row) => h("span", { title: row.reason }, formatShortReason(row.reason)),
  },
  {
    title: "修改时间",
    key: "mtimeMs",
    width: 170,
    sorter: (left, right) => left.mtimeMs - right.mtimeMs,
    render: (row) => new Date(row.mtimeMs).toLocaleString(),
  },
  {
    title: "操作",
    key: "actions",
    width: 170,
    render: (row) =>
      h(
        "div",
        {
          style: "display: flex; gap: 8px;",
        },
        [
          h(
            NButton,
            {
              size: "small",
              onClick: () => openLocalFolder(row.localPath),
            },
            { default: () => "打开目录" },
          ),
          h(
            NButton,
            {
              size: "small",
              type: "error",
              disabled: deletingLocalInvalidMp4Files.value,
              onClick: () => deleteLocalInvalidMp4Files([row]),
            },
            { default: () => "删除" },
          ),
        ],
      ),
  },
];

const localDuplicateColumns: DataTableColumns<LocalDuplicateVideoFile> = [
  {
    type: "selection",
  },
  {
    title: "重复文件",
    key: "fileName",
    minWidth: 260,
    render: (row) => h("span", { title: row.localPath }, row.fileName),
  },
  {
    title: "主候选",
    key: "primaryFileName",
    minWidth: 260,
    render: (row) => h("span", { title: row.primaryLocalPath }, row.primaryFileName),
  },
  {
    title: "大小",
    key: "size",
    width: 110,
    sorter: (left, right) => left.size - right.size,
    render: (row) => formatFileSize(row.size),
  },
  {
    title: "原因",
    key: "reason",
    minWidth: 260,
    render: (row) => h("span", { title: row.reason }, formatShortReason(row.reason)),
  },
  {
    title: "修改时间",
    key: "mtimeMs",
    width: 170,
    sorter: (left, right) => left.mtimeMs - right.mtimeMs,
    render: (row) => new Date(row.mtimeMs).toLocaleString(),
  },
  {
    title: "操作",
    key: "actions",
    width: 170,
    render: (row) =>
      h(
        "div",
        {
          style: "display: flex; gap: 8px;",
        },
        [
          h(
            NButton,
            {
              size: "small",
              onClick: () => openLocalFolder(row.localPath),
            },
            { default: () => "打开目录" },
          ),
          h(
            NButton,
            {
              size: "small",
              type: "error",
              disabled: deletingLocalDuplicateFiles.value,
              onClick: () => deleteLocalDuplicateFiles([row]),
            },
            { default: () => "删除" },
          ),
        ],
      ),
  },
];

const localUnuploadedColumns: DataTableColumns<LocalUnuploadedGroup> = [
  {
    type: "selection",
    disabled: (row) =>
      !row.roomId || !row.hasWebhookUploadConfig || isLocalUnuploadedGroupQueued(row),
  },
  {
    title: "主播/房间",
    key: "roomId",
    minWidth: 150,
    render: (row) => `${row.username || "未知"}${row.roomId ? ` (${row.roomId})` : ""}`,
  },
  {
    title: "标题",
    key: "title",
    minWidth: 220,
    render: (row) => h("span", { title: row.title }, row.title),
  },
  {
    title: "文件",
    key: "fileCount",
    width: 130,
    render: (row) => `${row.fileCount} 个 / ${formatFileSize(row.totalSize)}`,
  },
  {
    title: "弹幕",
    key: "danmuCount",
    width: 90,
    render: (row) => `${row.danmuCount}/${row.fileCount}`,
  },
  {
    title: "建议",
    key: "suggestedAction",
    minWidth: 220,
    render: (row) => {
      if (row.suggestedAction === "append") {
        return h(
          "span",
          { title: row.archiveTitle || `AV${row.suggestedAid}` },
          `续传 AV${row.suggestedAid}${row.archiveTitle ? `：${row.archiveTitle}` : ""}`,
        );
      }
      if (row.suggestedAction === "ambiguous") return "需确认稿件";
      return "新建稿件";
    },
  },
  {
    title: "合并",
    key: "mergeCandidate",
    width: 90,
    render: (row) => (row.mergeCandidate ? "可合并" : "-"),
  },
  {
    title: "状态",
    key: "uploadStatus",
    width: 110,
    render: (row) => {
      if (getQueuedLocalUploadKeySet().has(row.uploadKey) && !row.uploadStatus) {
        return "提交中";
      }
      if (row.uploadStatus === "queued") return "提交中";
      if (row.uploadStatus === "running") return "处理中";
      if (row.uploadStatus === "completed") return "已提交";
      if (row.uploadStatus === "error") {
        return h("span", { title: row.uploadError || "上次入队失败" }, "失败可重试");
      }
      return "-";
    },
  },
  {
    title: "时间",
    key: "startTime",
    width: 170,
    render: (row) => new Date(row.startTime).toLocaleString(),
  },
  {
    title: "提示",
    key: "warnings",
    minWidth: 220,
    render: (row) => row.warnings.join("；") || "-",
  },
  {
    title: "操作",
    key: "actions",
    width: 100,
    render: (row) =>
      h(
        NButton,
        {
          size: "small",
          onClick: () => openLocalFolder(row.files[0].path),
        },
        { default: () => "打开目录" },
      ),
  },
];

const localMergeColumns: DataTableColumns<LocalUnuploadedGroup> = [
  {
    type: "selection",
  },
  {
    title: "主播/房间",
    key: "roomId",
    minWidth: 170,
    render: (row) => `${row.username || "未知"}${row.roomId ? ` (${row.roomId})` : ""}`,
  },
  {
    title: "标题",
    key: "title",
    minWidth: 180,
    render: (row) => h("span", { title: row.title }, row.title),
  },
  {
    title: "文件",
    key: "files",
    minWidth: 320,
    render: (row) =>
      h(
        "div",
        { class: "merge-file-list" },
        row.files.map((file) =>
          h("div", { title: file.path, class: "merge-file-list__item" }, file.fileName),
        ),
      ),
  },
  {
    title: "大小",
    key: "totalSize",
    width: 120,
    render: (row) => formatFileSize(row.totalSize),
  },
];

const localDeletionColumns: DataTableColumns<LocalUploadedFileDeletionRecord> = [
  {
    title: "删除时间",
    key: "deletedAt",
    width: 170,
    sorter: (left, right) => left.deletedAt - right.deletedAt,
    render: (row) => new Date(row.deletedAt).toLocaleString(),
  },
  {
    title: "本地文件",
    key: "fileName",
    minWidth: 220,
    render: (row) => h("span", { title: row.localPath }, row.fileName),
  },
  {
    title: "大小",
    key: "size",
    width: 110,
    sorter: (left, right) => left.size - right.size,
    render: (row) => formatFileSize(row.size),
  },
  {
    title: "稿件",
    key: "archiveTitle",
    minWidth: 220,
    render: (row) => {
      if (row.aid) {
        return h("span", { title: `AV${row.aid}` }, row.archiveTitle || `AV${row.aid}`);
      }
      return h(
        "span",
        { title: row.reason },
        row.reason.includes("同场") ? "同场重复" : "无效 MP4",
      );
    },
  },
  {
    title: "分P",
    key: "partTitle",
    minWidth: 160,
    render: (row) => row.partTitle || row.remoteFilename || row.reason || "-",
  },
  {
    title: "原因",
    key: "reason",
    minWidth: 160,
    render: (row) => h("span", { title: row.reason }, formatShortReason(row.reason)),
  },
  {
    title: "操作",
    key: "actions",
    width: 110,
    render: (row) =>
      h(
        NButton,
        {
          size: "small",
          onClick: () => openLocalFolder(row.localPath),
        },
        { default: () => "打开目录" },
      ),
  },
];

const uploadSelectedLocalGroups = async (mode: LocalUploadRunMode) => {
  const selectedIds = new Set(selectedLocalUploadGroupIds.value.map((item) => String(item)));
  const groups = localUnuploadedRows.value.filter(
    (row) =>
      selectedIds.has(row.id) &&
      row.roomId &&
      row.hasWebhookUploadConfig &&
      !isLocalUnuploadedGroupQueued(row),
  );

  if (groups.length === 0) {
    notice.warning({
      title: "没有可上传的分组",
      content: "请先选择已识别房间且已配置 webhook 上传账号的分组",
      duration: 3000,
    });
    return;
  }

  const burnDanmu = mode === "burn";
  pendingLocalUploadGroups.value = groups.map((row) => ({
    row,
    burnDanmu,
    uploadRawWhenNoDanmu: localUploadOptions.uploadRawWhenNoDanmu,
  }));
  if (localUploadOptions.mergeSegments && localMergeRows.value.length > 0) {
    selectedMergeGroupIds.value = [];
    localMergeDialogVisible.value = true;
    return;
  }

  await submitPreparedLocalUploadGroups(new Set());
};

const cancelLocalMergeSelection = () => {
  localMergeDialogVisible.value = false;
};

const confirmLocalMergeSelection = async () => {
  const mergeIds = new Set(selectedMergeGroupIds.value.map((item) => String(item)));
  await submitPreparedLocalUploadGroups(mergeIds);
};

const submitPreparedLocalUploadGroups = async (mergeIds: Set<string>) => {
  const groups = pendingLocalUploadGroups.value.map((item) => {
    const row = item.row;
    return {
      uploadKey: row.uploadKey,
      roomId: row.roomId,
      platform: row.platform,
      username: row.username,
      title: row.title,
      startTime: row.startTime,
      aid: row.suggestedAction === "append" ? row.suggestedAid : undefined,
      uploadMode: row.suggestedAction === "append" ? ("append" as const) : ("new" as const),
      burnDanmu: item.burnDanmu,
      uploadRawWhenNoDanmu: item.uploadRawWhenNoDanmu,
      mergeSegments: row.mergeCandidate && mergeIds.has(row.id),
      files: row.files,
    };
  });

  uploadingLocalUnuploaded.value = true;
  try {
    const result = await biliApi.uploadLocalUnuploaded({
      groups,
      options: {
        burnDanmu: pendingLocalUploadGroups.value.some((item) => item.burnDanmu),
        uploadRawWhenNoDanmu: localUploadOptions.uploadRawWhenNoDanmu,
        mergeSegments: false,
      },
    });
    const queuedCount = result.items.filter((item) => item.status === "queued").length;
    const skippedDuplicateCount = result.items.filter(
      (item) => item.status === "skipped" && item.reason?.startsWith("duplicate:"),
    ).length;
    const queuedKeys = result.items
      .filter((item) => item.status === "queued" && item.uploadKey)
      .map((item) => item.uploadKey!);
    const now = Date.now();
    const queuedRecordByKey = new Map(
      pruneQueuedLocalUploadRecords().map((item) => [item.key, item]),
    );
    for (const key of queuedKeys) {
      queuedRecordByKey.set(key, { key, queuedAt: now });
    }
    queuedLocalUploadRecords.value = Array.from(queuedRecordByKey.values()).slice(-1000);
    if (localUploadedFilesResult.value && queuedKeys.length > 0) {
      const queuedKeySet = new Set(queuedKeys);
      localUploadedFilesResult.value.unuploadedGroups =
        localUploadedFilesResult.value.unuploadedGroups.map((row) =>
          queuedKeySet.has(row.uploadKey)
            ? {
                ...row,
                uploadStatus: "queued",
                uploadQueuedAt: now,
                uploadUpdatedAt: now,
              }
            : row,
        );
    }
    void monitorLocalUploadStatuses(queuedKeys);
    notice.success({
      title: "已加入上传流程",
      content: `已加入 ${queuedCount} 个分组${
        skippedDuplicateCount ? `，跳过重复 ${skippedDuplicateCount} 个` : ""
      }，${
        pendingLocalUploadGroups.value.some((item) => item.burnDanmu) ? "压制后上传" : "直接上传"
      }任务会在队列中执行`,
      duration: 3000,
    });
    selectedLocalUploadGroupIds.value = [];
    pendingLocalUploadGroups.value = [];
    selectedMergeGroupIds.value = [];
    localMergeDialogVisible.value = false;
  } catch (error) {
    notice.error({
      title: "加入上传流程失败",
      content: error instanceof Error ? error.message : String(error),
      duration: 3000,
    });
  } finally {
    uploadingLocalUnuploaded.value = false;
  }
};

const runLocalUploadedFilesScan = async () => {
  const hasLogin = !!userInfo.value.uid;
  if (!hasLogin) {
    notice.error({
      title: `请点击左侧头像处先进行登录`,
      duration: 1000,
    });
    return;
  }

  if (localUploadStreamers.value.length === 0) {
    await loadLocalUploadStreamers();
  }
  const requestedStreamerCount = selectedLocalDetectStreamerKeys.value.length;
  const selectedStreamers = getSelectedLocalDetectStreamers();
  if (requestedStreamerCount > 0 && selectedStreamers.length === 0) {
    notice.warning({
      title: "主播筛选不可用",
      content: "已选择主播，但未能解析到有效主播列表，请刷新后重试",
      duration: 3000,
    });
    return;
  }

  detectingLocalUploadedFiles.value = true;
  localUploadedFilesVisible.value = true;
  localUploadedFilesResult.value = null;
  selectedLocalDetectHistoryId.value = null;
  resetLocalDetectView();
  const pollingRunId = ++localDetectPollingRunId;
  pushLocalDetectLog("开始检测本地视频和B站稿件");
  pushLocalDetectLog(
    `主播筛选：${selectedStreamers.length > 0 ? `${selectedStreamers.length} 个` : "全部"}`,
  );
  pushLocalDetectLog(
    `正在扫描本地视频目录并拉取B站稿件列表，页数 ${localDetectOptions.value.pages}，分P详情${
      localDetectOptions.value.useArchiveDetail
        ? `开启，间隔 ${localDetectOptions.value.detailIntervalMs}ms`
        : "关闭"
    }，未上传分组合计最小大小 ${localDetectOptions.value.minVideoSizeMb || 0} MB...`,
  );
  try {
    let progress = await biliApi.startLocalUploadedFilesDetection(userInfo.value.uid!, {
      pages: localDetectOptions.value.pages,
      useArchiveDetail: localDetectOptions.value.useArchiveDetail,
      detailIntervalMs: localDetectOptions.value.detailIntervalMs,
      minVideoSizeMb: localDetectOptions.value.minVideoSizeMb,
      selectedStreamers,
    });
    syncLocalDetectProgress(progress);
    while (progress.status === "running" && pollingRunId === localDetectPollingRunId) {
      await waitLocalDetectPoll(1000);
      progress = await biliApi.getLocalUploadedFilesDetection(progress.id);
      syncLocalDetectProgress(progress);
    }
    if (pollingRunId !== localDetectPollingRunId) return;
    if (progress.status === "error") {
      throw new Error(progress.error || progress.message || "检测失败");
    }
    const result = progress.result;
    if (!result) {
      throw new Error("检测已结束，但没有返回结果");
    }
    applyLocalUploadedFilesResult(result);
    const existingLogs = new Set(
      localDetectLogs.value.map((item) => item.replace(/^\[[^\]]+\]\s*/, "")),
    );
    for (const item of result.logs ?? []) {
      if (existingLogs.has(item)) continue;
      pushLocalDetectLog(item);
      existingLogs.add(item);
    }
    for (const item of result.warnings ?? []) pushLocalDetectLog(`提示：${item}`);
    await Promise.all([loadLocalDetectHistoryList(), loadLocalDeletionHistory()]);
    pushLocalDetectLog("检测完成");
  } catch (error) {
    pushLocalDetectLog(`检测失败：${error instanceof Error ? error.message : String(error)}`);
    notice.error({
      title: "检测失败",
      content: error instanceof Error ? error.message : String(error),
      duration: 3000,
    });
  } finally {
    if (pollingRunId === localDetectPollingRunId) {
      detectingLocalUploadedFiles.value = false;
    }
  }
};

const biliSettingRef = ref<InstanceType<typeof BiliSetting> | null>(null);
// 只提示一次，清空提示
const hasNotice = ref(false);
const notification = useNotification();
const fileChange = (files: any) => {
  if (files.length === 0) {
    hasNotice.value = false;
    return;
  }
  if (hasNotice.value) return;

  const name = files[0].title;
  if (biliSettingRef.value?.getTitle() === name) return;
  if (appConfig.value.biliUploadFileNameType === "never") return;
  if (appConfig.value.biliUploadFileNameType === "always") {
    biliSettingRef.value?.setTitle(name);
    return;
  }
  hasNotice.value = true;
  const n = notification.create({
    title: `是否将文件名改为视频标题？`,
    keepAliveOnHover: true,
    duration: 3000,
    action: () =>
      h(
        "div",
        {
          style: "display: flex; gap: 10px; justify-content: center; align-items: center;",
        },
        {
          default: () => [
            h(
              NButton,
              {
                type: "primary",
                onClick: () => {
                  biliSettingRef.value?.setTitle(name);
                  n.destroy();
                },
              },
              {
                default: () => "确认",
              },
            ),
            h(
              NButton,
              {
                text: true,
                type: "error",
                onClick: () => {
                  appConfigStore.set("biliUploadFileNameType", "never");
                  n.destroy();
                },
              },
              {
                default: () => "不再提示",
              },
            ),
          ],
        },
      ),
  });
};
</script>

<style scoped lang="less">
.local-audit-panel {
  height: 100%;
  padding: 18px 22px;
  overflow: auto;
}

.local-audit-header {
  margin-bottom: 14px;
}

.local-audit-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.detect-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  color: #666;
}

.detect-log {
  max-height: 160px;
  overflow: auto;
  margin-bottom: 12px;
  padding: 8px 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 6px;
  background: #f8f8f8;
  color: #555;
  font-size: 12px;
  line-height: 1.6;
}

.detect-log__line {
  white-space: pre-wrap;
  word-break: break-all;
}

.detect-progress {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  padding: 8px 10px;
  border: 1px solid rgba(24, 160, 88, 0.18);
  border-radius: 6px;
  background: rgba(24, 160, 88, 0.06);
  color: #333;
  font-size: 12px;
}

.detect-progress__header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
}

.detect-progress__message,
.detect-progress__current {
  color: #555;
  word-break: break-all;
}

.detect-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #666;
}

.local-detect-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: #666;
}

.local-history-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.local-upload-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.local-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.merge-file-list {
  display: grid;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
}

.merge-file-list__item {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #555;
  font-size: 12px;
}
</style>
