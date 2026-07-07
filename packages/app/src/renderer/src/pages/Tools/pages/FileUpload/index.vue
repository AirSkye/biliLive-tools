<!-- 上传文件 -->
<template>
  <div>
    <div class="flex justify-center align-center" style="margin-bottom: 20px; gap: 10px">
      <span v-if="fileList.length !== 0" style="cursor: pointer; color: #958e8e" @click="clear"
        >清空</span
      >
      <n-button @click="addVideo"> 添加 </n-button>
      <n-button type="primary" @click="upload" title="立即上传(ctrl+enter)"> 立即上传 </n-button>
      <n-button type="primary" @click="appendVideoVisible = true"> 续传 </n-button>
      <n-button
        :loading="detectingLocalUploadedFiles || loadingLocalDetectHistory"
        @click="openLocalUploadedFilesPanel"
      >
        打开检测结果
      </n-button>
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
        <span>未上传最小(MB)</span>
        <n-input-number
          v-model:value="localDetectOptions.minVideoSizeMb"
          size="small"
          :min="0"
          :max="10240"
          :step="10"
          :precision="0"
          style="width: 118px"
        />
      </div>
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

    <n-modal
      v-model:show="localUploadedFilesVisible"
      preset="card"
      title="已上传未删除检测"
      style="width: min(1100px, 92vw)"
      :bordered="false"
      :mask="false"
      :trap-focus="false"
      :auto-focus="false"
    >
      <div class="local-history-toolbar">
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
              弹幕不存在时上传原视频
            </n-checkbox>
            <n-checkbox v-model:checked="localUploadOptions.mergeSegments">
              上传前选择合并分段
            </n-checkbox>
            <n-button size="small" @click="selectAllLocalUnuploadedGroups"> 全选全部 </n-button>
            <n-button size="small" @click="clearSelectedLocalUploadGroups"> 清空选择 </n-button>
            <n-button
              type="primary"
              size="small"
              :loading="uploadingLocalUnuploaded"
              :disabled="selectedLocalUploadGroupIds.length === 0"
              @click="uploadSelectedLocalGroups"
            >
              上传选中
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
    </n-modal>
    <n-modal
      v-model:show="localProcessDialogVisible"
      preset="card"
      title="选择处理主播"
      style="width: min(900px, 92vw)"
      :bordered="false"
      :trap-focus="false"
      :auto-focus="false"
    >
      <div class="local-upload-toolbar">
        <span>待处理主播：{{ localProcessStreamerRows.length }}</span>
        <n-button size="small" @click="selectAllProcessStreamers"> 全选全部 </n-button>
        <n-button size="small" @click="clearProcessStreamers"> 清空选择 </n-button>
      </div>
      <n-empty v-if="localProcessStreamerRows.length === 0" description="没有可处理的主播" />
      <n-data-table
        v-else
        v-model:checked-row-keys="selectedProcessStreamerKeys"
        :row-key="getLocalProcessStreamerRowKey"
        :columns="localProcessStreamerColumns"
        :data="localProcessStreamerRows"
        :pagination="{ pageSize: 8 }"
        size="small"
      />
      <template #footer>
        <div class="local-dialog-footer">
          <n-button @click="localProcessDialogVisible = false">取消</n-button>
          <n-button
            type="primary"
            :loading="uploadingLocalUnuploaded"
            @click="confirmLocalProcessSelection"
          >
            下一步
          </n-button>
        </div>
      </template>
    </n-modal>
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
import { NButton, NRadio, NRadioGroup, useNotification } from "naive-ui";
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
  LocalUploadedFileDeletionRecord,
  LocalUploadedFilesDetectionProgress,
  LocalUploadedFilesHistorySummary,
  LocalUploadedFileMatch,
  LocalUploadedFilesResult,
  LocalUnuploadedGroup,
} from "@renderer/apis/bili";

defineOptions({
  name: "Upload",
});

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

const localUploadedFilesVisible = ref(false);
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
const localDetectHistoryOptions = computed(() =>
  localDetectHistoryItems.value.map((item) => ({
    label: `${new Date(item.createdAt).toLocaleString()} | 残留 ${item.matchCount}/${item.initialMatchCount} | 未上传 ${item.unuploadedGroupCount} | 已删 ${item.deletedCount}`,
    value: item.id,
  })),
);
const localUploadedRows = computed(() => localUploadedFilesResult.value?.matches ?? []);
const selectedLocalUploadedFileKeys = ref<DataTableRowKey[]>([]);
const deletingLocalUploadedFiles = ref(false);
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
const localUploadOptions = reactive({
  burnDanmu: true,
  uploadRawWhenNoDanmu: true,
  mergeSegments: true,
});
type LocalProcessMode = "burn" | "raw";
type LocalProcessStreamerRow = {
  key: string;
  roomId?: string;
  username?: string;
  groupCount: number;
  fileCount: number;
  totalSize: number;
  appendCount: number;
  newCount: number;
  groups: LocalUnuploadedGroup[];
};
type PendingLocalUploadGroup = {
  row: LocalUnuploadedGroup;
  burnDanmu: boolean;
  uploadRawWhenNoDanmu: boolean;
};
const localProcessDialogVisible = ref(false);
const localMergeDialogVisible = ref(false);
const pendingLocalProcessGroups = ref<LocalUnuploadedGroup[]>([]);
const pendingLocalUploadGroups = ref<PendingLocalUploadGroup[]>([]);
const selectedProcessStreamerKeys = ref<DataTableRowKey[]>([]);
const selectedMergeGroupIds = ref<DataTableRowKey[]>([]);
const processModeByStreamerKey = reactive<Record<string, LocalProcessMode>>({});
const getLocalUploadedRowKey = (row: LocalUploadedFileMatch) => row.localPath;
const getLocalUnuploadedRowKey = (row: LocalUnuploadedGroup) => row.id;
const getLocalDeletionRowKey = (row: LocalUploadedFileDeletionRecord) => row.id;
const getLocalProcessStreamerRowKey = (row: LocalProcessStreamerRow) => row.key;
const getLocalStreamerKey = (row: LocalUnuploadedGroup) =>
  `${row.platform || "bilibili"}:${row.roomId || row.username || "unknown"}`;
const getEligibleLocalUnuploadedRows = () =>
  localUnuploadedRows.value.filter((row) => row.roomId && row.hasWebhookUploadConfig);
const selectAllLocalUnuploadedGroups = () => {
  selectedLocalUploadGroupIds.value = getEligibleLocalUnuploadedRows().map((row) => row.id);
};
const clearSelectedLocalUploadGroups = () => {
  selectedLocalUploadGroupIds.value = [];
};
const localProcessStreamerRows = computed<LocalProcessStreamerRow[]>(() => {
  const map = new Map<string, LocalProcessStreamerRow>();
  for (const group of pendingLocalProcessGroups.value) {
    const key = getLocalStreamerKey(group);
    const item =
      map.get(key) ??
      ({
        key,
        roomId: group.roomId,
        username: group.username,
        groupCount: 0,
        fileCount: 0,
        totalSize: 0,
        appendCount: 0,
        newCount: 0,
        groups: [],
      } satisfies LocalProcessStreamerRow);
    item.groupCount += 1;
    item.fileCount += group.fileCount;
    item.totalSize += group.totalSize;
    if (group.suggestedAction === "append") item.appendCount += 1;
    else item.newCount += 1;
    item.groups.push(group);
    map.set(key, item);
  }
  return Array.from(map.values()).sort((left, right) => right.totalSize - left.totalSize);
});
const localMergeRows = computed(() =>
  pendingLocalUploadGroups.value
    .map((item) => item.row)
    .filter((row) => row.mergeCandidate)
    .sort((left, right) => right.totalSize - left.totalSize),
);
const selectAllProcessStreamers = () => {
  selectedProcessStreamerKeys.value = localProcessStreamerRows.value.map((row) => row.key);
};
const clearProcessStreamers = () => {
  selectedProcessStreamerKeys.value = [];
};
const selectAllMergeGroups = () => {
  selectedMergeGroupIds.value = localMergeRows.value.map((row) => row.id);
};
const clearMergeGroups = () => {
  selectedMergeGroupIds.value = [];
};
const getProcessMode = (key: string): LocalProcessMode =>
  processModeByStreamerKey[key] ?? (localUploadOptions.burnDanmu ? "burn" : "raw");
const setProcessMode = (key: string, value: LocalProcessMode) => {
  processModeByStreamerKey[key] = value;
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
const resetLocalDetectView = () => {
  localDetectProgress.value = null;
  localUnuploadedSearchKeyword.value = "";
  selectedLocalUploadedFileKeys.value = [];
  selectedLocalUploadGroupIds.value = [];
  pendingLocalProcessGroups.value = [];
  pendingLocalUploadGroups.value = [];
  selectedProcessStreamerKeys.value = [];
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
};
const loadLocalDetectHistoryList = async () => {
  if (!userInfo.value.uid) return null;
  const data = await biliApi.getLocalUploadedFilesHistory(userInfo.value.uid);
  localDetectHistoryItems.value = data.items;
  return data.latest;
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
    await Promise.all([loadLocalDetectHistoryList(), loadLocalDeletionHistory()]);
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
  if (!userInfo.value.uid) {
    notice.error({
      title: `请点击左侧头像处先进行登录`,
      duration: 1000,
    });
    return;
  }
  localUploadedFilesVisible.value = true;
  resetLocalDetectView();
  loadingLocalDetectHistory.value = true;
  try {
    const latest = await loadLocalDetectHistoryList();
    await loadLocalDeletionHistory();
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
onBeforeUnmount(() => {
  localDetectPollingRunId += 1;
});

const formatFileSize = (size: number) => {
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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

const deleteLocalUploadedFiles = async (rows: LocalUploadedFileMatch[]) => {
  if (rows.length === 0 || deletingLocalUploadedFiles.value) return;
  const [confirmed] = await confirm.warning({
    title: "确认删除",
    content: `确定删除 ${rows.length} 个已上传残留文件吗？此操作不可撤销。`,
    positiveText: "删除",
    negativeText: "取消",
  });
  if (!confirmed) return;

  deletingLocalUploadedFiles.value = true;
  const deletedPaths = new Set<string>();
  const deletedRows: LocalUploadedFileMatch[] = [];
  const failed: string[] = [];
  const historyId = localUploadedFilesResult.value?.historyId;
  try {
    for (const row of rows) {
      try {
        await fileBrowserApi.removeFile(row.localPath);
        deletedPaths.add(row.localPath);
        deletedRows.push(row);
        pushLocalDetectLog(`已删除残留文件：${row.fileName}`);
      } catch (error) {
        failed.push(`${row.fileName}：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (localUploadedFilesResult.value && deletedPaths.size > 0) {
      localUploadedFilesResult.value.matches = localUploadedFilesResult.value.matches.filter(
        (row) => !deletedPaths.has(row.localPath),
      );
    }
    selectedLocalUploadedFileKeys.value = selectedLocalUploadedFileKeys.value.filter(
      (key) => !deletedPaths.has(String(key)),
    );

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
        content: `已删除 ${deletedPaths.size} 个残留文件`,
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
    deletingLocalUploadedFiles.value = false;
  }
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

const localUnuploadedColumns: DataTableColumns<LocalUnuploadedGroup> = [
  {
    type: "selection",
    disabled: (row) => !row.roomId || !row.hasWebhookUploadConfig,
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

const localProcessStreamerColumns: DataTableColumns<LocalProcessStreamerRow> = [
  {
    type: "selection",
  },
  {
    title: "主播/房间",
    key: "roomId",
    minWidth: 180,
    render: (row) => `${row.username || "未知"}${row.roomId ? ` (${row.roomId})` : ""}`,
  },
  {
    title: "分组",
    key: "groupCount",
    width: 130,
    render: (row) => `${row.groupCount} 组 / ${row.fileCount} 个文件`,
  },
  {
    title: "大小",
    key: "totalSize",
    width: 120,
    render: (row) => formatFileSize(row.totalSize),
  },
  {
    title: "建议",
    key: "suggestion",
    width: 140,
    render: (row) => `续传 ${row.appendCount} / 新建 ${row.newCount}`,
  },
  {
    title: "处理方式",
    key: "processMode",
    minWidth: 220,
    render: (row) =>
      h(
        NRadioGroup,
        {
          value: getProcessMode(row.key),
          size: "small",
          "onUpdate:value": (value: LocalProcessMode) => setProcessMode(row.key, value),
        },
        {
          default: () => [
            h(NRadio, { value: "burn" }, { default: () => "压制弹幕" }),
            h(NRadio, { value: "raw" }, { default: () => "直接上传" }),
          ],
        },
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
    render: (row) => h("span", { title: `AV${row.aid}` }, row.archiveTitle || `AV${row.aid}`),
  },
  {
    title: "分P",
    key: "partTitle",
    minWidth: 160,
    render: (row) => row.partTitle || row.remoteFilename || "-",
  },
  {
    title: "原因",
    key: "reason",
    minWidth: 160,
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

const uploadSelectedLocalGroups = async () => {
  const selectedIds = new Set(selectedLocalUploadGroupIds.value.map((item) => String(item)));
  const groups = localUnuploadedRows.value.filter(
    (row) => selectedIds.has(row.id) && row.roomId && row.hasWebhookUploadConfig,
  );

  if (groups.length === 0) {
    notice.warning({
      title: "没有可上传的分组",
      content: "请先选择已识别房间且已配置 webhook 上传账号的分组",
      duration: 3000,
    });
    return;
  }

  pendingLocalProcessGroups.value = groups;
  pendingLocalUploadGroups.value = [];
  selectedProcessStreamerKeys.value = [];
  selectedMergeGroupIds.value = [];
  for (const row of groups) {
    const key = getLocalStreamerKey(row);
    if (!processModeByStreamerKey[key]) {
      processModeByStreamerKey[key] = localUploadOptions.burnDanmu ? "burn" : "raw";
    }
  }
  localProcessDialogVisible.value = true;
};

const confirmLocalProcessSelection = async () => {
  const selectedStreamerKeys = new Set(
    selectedProcessStreamerKeys.value.map((item) => String(item)),
  );
  if (selectedStreamerKeys.size === 0) {
    notice.warning({
      title: "请选择主播",
      content: "需要选择至少一个主播的视频进行处理",
      duration: 3000,
    });
    return;
  }

  pendingLocalUploadGroups.value = pendingLocalProcessGroups.value
    .filter((row) => selectedStreamerKeys.has(getLocalStreamerKey(row)))
    .map((row) => {
      const mode = getProcessMode(getLocalStreamerKey(row));
      return {
        row,
        burnDanmu: mode === "burn",
        uploadRawWhenNoDanmu: mode === "raw" ? true : localUploadOptions.uploadRawWhenNoDanmu,
      };
    });

  if (pendingLocalUploadGroups.value.length === 0) {
    notice.warning({
      title: "没有可处理分组",
      duration: 3000,
    });
    return;
  }

  localProcessDialogVisible.value = false;
  if (localUploadOptions.mergeSegments && localMergeRows.value.length > 0) {
    selectedMergeGroupIds.value = [];
    localMergeDialogVisible.value = true;
    return;
  }

  await submitPreparedLocalUploadGroups(new Set());
};

const cancelLocalMergeSelection = () => {
  localMergeDialogVisible.value = false;
  localProcessDialogVisible.value = true;
};

const confirmLocalMergeSelection = async () => {
  const mergeIds = new Set(selectedMergeGroupIds.value.map((item) => String(item)));
  await submitPreparedLocalUploadGroups(mergeIds);
};

const submitPreparedLocalUploadGroups = async (mergeIds: Set<string>) => {
  const groups = pendingLocalUploadGroups.value.map((item) => {
    const row = item.row;
    return {
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
        burnDanmu: false,
        uploadRawWhenNoDanmu: true,
        mergeSegments: false,
      },
    });
    const queuedCount = result.items.filter((item) => item.status === "queued").length;
    notice.success({
      title: "已加入上传流程",
      content: `已加入 ${queuedCount} 个分组，合并/压制/上传任务会在任务队列中执行`,
      duration: 3000,
    });
    selectedLocalUploadGroupIds.value = [];
    pendingLocalProcessGroups.value = [];
    pendingLocalUploadGroups.value = [];
    selectedProcessStreamerKeys.value = [];
    selectedMergeGroupIds.value = [];
    localProcessDialogVisible.value = false;
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

  detectingLocalUploadedFiles.value = true;
  localUploadedFilesVisible.value = true;
  localUploadedFilesResult.value = null;
  selectedLocalDetectHistoryId.value = null;
  resetLocalDetectView();
  const pollingRunId = ++localDetectPollingRunId;
  pushLocalDetectLog("开始检测本地视频和B站稿件");
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
