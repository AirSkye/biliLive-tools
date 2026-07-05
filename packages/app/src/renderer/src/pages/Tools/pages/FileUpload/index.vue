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
      <n-button :loading="detectingLocalUploadedFiles" @click="detectLocalUploadedFiles">
        检测已上传未删除
      </n-button>
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
    >
      <div v-if="localUploadedFilesResult" class="detect-summary">
        <span>扫描文件：{{ localUploadedFilesResult.scannedFileCount }}</span>
        <span>稿件：{{ localUploadedFilesResult.archiveCount }}</span>
        <span>分P：{{ localUploadedFilesResult.remotePartCount }}</span>
        <span>匹配：{{ localUploadedFilesResult.matches.length }}</span>
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
      <n-empty v-if="localUploadedRows.length === 0" description="没有检测到疑似残留文件" />
      <n-data-table
        v-else
        :columns="localUploadedColumns"
        :data="localUploadedRows"
        :pagination="{ pageSize: 8 }"
        size="small"
      />
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { toReactive } from "@vueuse/core";
import { NButton, useNotification } from "naive-ui";
import type { DataTableColumns } from "naive-ui";

import FileSelect from "@renderer/pages/Tools/pages/FileUpload/components/FileSelect.vue";
import BiliSetting from "@renderer/components/BiliSetting.vue";
import AppendVideoDialog from "@renderer/components/AppendVideoDialog.vue";
import { useBili } from "@renderer/hooks";
import { useUserInfoStore, useAppConfig } from "@renderer/stores";
import { biliApi } from "@renderer/apis";
import hotkeys from "hotkeys-js";

import { deepRaw } from "@renderer/utils";
import type { LocalUploadedFileMatch, LocalUploadedFilesResult } from "@renderer/apis/bili";

defineOptions({
  name: "Upload",
});

const { userInfo } = storeToRefs(useUserInfoStore());
const { handlePresetOptions, presetOptions } = useBili();
const appConfigStore = useAppConfig();
const { appConfig } = storeToRefs(appConfigStore);

const notice = useNotification();

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
const localUploadedFilesResult = ref<LocalUploadedFilesResult | null>(null);
const localUploadedRows = computed(() => localUploadedFilesResult.value?.matches ?? []);

const openLocalFolder = (filePath: string) => {
  window.api.openPath(window.path.dirname(filePath));
};

const openBiliArchive = (aid: number) => {
  const url = `https://member.bilibili.com/platform/upload/video/frame?type=edit&version=new&aid=${aid}`;
  window.api.openExternal(url);
};

const localUploadedColumns: DataTableColumns<LocalUploadedFileMatch> = [
  {
    title: "本地文件",
    key: "fileName",
    minWidth: 220,
    render: (row) => h("span", { title: row.localPath }, row.fileName),
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
    render: (row) => new Date(row.mtimeMs).toLocaleString(),
  },
  {
    title: "操作",
    key: "actions",
    width: 180,
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
              onClick: () => openBiliArchive(row.aid),
            },
            { default: () => "打开稿件" },
          ),
        ],
      ),
  },
];

const detectLocalUploadedFiles = async () => {
  const hasLogin = !!userInfo.value.uid;
  if (!hasLogin) {
    notice.error({
      title: `请点击左侧头像处先进行登录`,
      duration: 1000,
    });
    return;
  }

  detectingLocalUploadedFiles.value = true;
  try {
    localUploadedFilesResult.value = await biliApi.detectLocalUploadedFiles(userInfo.value.uid!);
    localUploadedFilesVisible.value = true;
  } catch (error) {
    notice.error({
      title: "检测失败",
      content: error instanceof Error ? error.message : String(error),
      duration: 3000,
    });
  } finally {
    detectingLocalUploadedFiles.value = false;
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
</style>
