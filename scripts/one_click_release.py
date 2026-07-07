#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
One-click local verify, commit, SSH push, GitHub Actions dispatch, and artifact output.

Examples:
  set GITHUB_TOKEN=<your token>
  py scripts/one_click_release.py -m "fix: local audit and disk check"

  py scripts/one_click_release.py -m "fix: quick build" --skip-verify

  py scripts/one_click_release.py --skip-verify --no-commit --no-push --no-dispatch

Notes:
  - The token is read from --token, GITHUB_TOKEN, GH_TOKEN, or GITHUB_PAT.
  - The token is never printed.
  - GitHub API is called with Python stdlib only; GitHub CLI is not required.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


LEVEL_COLORS = {
    "INFO": "\033[90m",
    "OK": "\033[92m",
    "WARN": "\033[93m",
    "ERROR": "\033[91m",
    "CMD": "\033[90m",
    "API": "\033[96m",
}
RESET = "\033[0m"


@dataclass
class CommandResult:
    stdout: str
    stderr: str
    returncode: int


class OneClickRelease:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.repo_root = Path(__file__).resolve().parents[1]
        self.log_dir = self.repo_root / "scripts" / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = self.log_dir / f"one-click-release-{datetime.now():%Y%m%d-%H%M%S}.log"
        self.repo_slug = ""
        self.github_token = ""
        self.branch = args.branch
        self.head_sha = ""

    def log(self, text: str, level: str = "INFO") -> None:
        line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] [{level}] {text}"
        with self.log_file.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")

        color = LEVEL_COLORS.get(level, "")
        if sys.stdout.isatty() and color:
            print(f"{color}{line}{RESET}")
        else:
            print(line)

    def run(
        self,
        command: list[str],
        *,
        allow_failure: bool = False,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> CommandResult:
        cwd = cwd or self.repo_root
        printable = " ".join(command)
        self.log(f"执行命令：{printable}", "CMD")

        process = subprocess.run(
            command,
            cwd=str(cwd),
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )

        stdout = process.stdout or ""
        stderr = process.stderr or ""

        for line in stdout.splitlines():
            if line:
                self.log(line, "CMD")
        for line in stderr.splitlines():
            if line:
                self.log(f"stderr: {line}", "WARN" if process.returncode == 0 else "ERROR")

        self.log(f"退出码：{process.returncode}", "CMD")

        if process.returncode != 0 and not allow_failure:
            raise RuntimeError(f"命令失败，退出码 {process.returncode}：{printable}")

        return CommandResult(stdout=stdout, stderr=stderr, returncode=process.returncode)

    def git_text(self, *arguments: str) -> str:
        return self.run(["git", *arguments]).stdout.strip()

    def require_command(self, name: str) -> None:
        if shutil.which(name) is None:
            raise RuntimeError(f"缺少命令：{name}")

    def get_repo_slug(self) -> str:
        remote_url = self.git_text("config", "--get", f"remote.{self.args.remote}.url")
        patterns = [
            r"(?:github\.com|ssh\.github\.com)(?::\d+)?[:/](?P<slug>[^/]+/[^/]+?)(?:\.git)?$",
            r"git@(?:github\.com|ssh\.github\.com):(?P<slug>[^/]+/[^/]+?)(?:\.git)?$",
        ]
        for pattern in patterns:
            match = re.search(pattern, remote_url)
            if match:
                return re.sub(r"\.git$", "", match.group("slug"))
        raise RuntimeError(f"无法从 remote URL 解析 GitHub 仓库：{remote_url}")

    def get_github_token(self) -> str:
        if self.args.token:
            self.log("GitHub token 来源：--token 参数", "INFO")
            return self.args.token
        for name in ("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"):
            value = os.environ.get(name)
            if value:
                self.log(f"GitHub token 来源：环境变量 {name}", "INFO")
                return value
        return ""

    def github_api(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if not self.github_token:
            raise RuntimeError(
                "缺少 GitHub token。请设置 GITHUB_TOKEN / GH_TOKEN / GITHUB_PAT，或使用 --token 参数。"
            )

        url = f"https://api.github.com/repos/{self.repo_slug}/{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.github_token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "biliLive-tools-one-click-release",
        }
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        self.log(f"GitHub API {method} {path}", "API")
        request = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API 失败：{method} {path} -> HTTP {error.code}: {raw}") from error

    def script_path(self, relative: str) -> str:
        path = self.repo_root / relative
        if os.name == "nt":
            cmd_path = path.with_suffix(path.suffix + ".cmd")
            if cmd_path.exists():
                return str(cmd_path)
        return str(path)

    def verify(self) -> None:
        self.log("开始本地校验", "INFO")
        self.run(["git", "diff", "--check"])

        tsc = self.script_path(r"node_modules\.bin\tsc")
        if Path(tsc).exists():
            self.run(
                [
                    tsc,
                    "--noEmit",
                    "-p",
                    r"packages\http\tsconfig.json",
                    "--composite",
                    "false",
                ]
            )
        else:
            self.log(f"未找到 {tsc}，跳过 HTTP 类型检查", "WARN")

        vue_tsc = self.script_path(r"packages\app\node_modules\.bin\vue-tsc")
        if Path(vue_tsc).exists():
            self.run(
                [
                    vue_tsc,
                    "--noEmit",
                    "-p",
                    r"packages\app\tsconfig.web.json",
                    "--composite",
                    "false",
                ]
            )
        else:
            self.log(f"未找到 {vue_tsc}，跳过前端类型检查", "WARN")

        vitest = self.script_path(r"node_modules\.bin\vitest")
        if Path(vitest).exists():
            self.run([vitest, "run", r"packages\http\test\webhook.test.ts"])
        else:
            self.log(f"未找到 {vitest}，跳过 webhook 测试", "WARN")

        self.log("本地校验完成", "OK")

    def commit_changes(self) -> None:
        status = self.run(["git", "status", "--porcelain"]).stdout.splitlines()
        if not status:
            self.log("工作区没有待提交改动，跳过提交", "INFO")
            return

        if self.args.no_commit:
            self.log("检测到改动，但传入了 --no-commit，跳过提交", "WARN")
            return

        message = self.args.message
        if not message:
            message = f"chore: local update {datetime.now():%Y%m%d-%H%M}"
            self.log(f"未传入 --message，使用默认提交信息：{message}", "WARN")

        self.run(["git", "add", "-A"])
        self.run(["git", "commit", "-m", message])
        self.log(f"提交完成：{message}", "OK")

    def resolve_private_key(self) -> str:
        candidates: list[Path] = []
        if self.args.ssh_key:
            supplied = Path(self.args.ssh_key).expanduser()
            if supplied.is_file():
                return str(supplied.resolve())
            if supplied.is_dir():
                candidates.extend([supplied / "id_ed25519", supplied / "id_rsa"])

        ssh_dir = Path.home() / ".ssh"
        candidates.extend([ssh_dir / "id_ed25519", ssh_dir / "id_rsa"])
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate.resolve())
        return ""

    def push_current_head(self) -> None:
        if self.args.no_push:
            self.log("传入了 --no-push，跳过推送", "WARN")
            return

        refspec = f"HEAD:{self.branch}"
        if self.args.use_remote_push:
            self.run(["git", "push", self.args.remote, refspec])
            self.log(f"已通过 remote {self.args.remote} 推送 {refspec}", "OK")
            return

        private_key = self.resolve_private_key()
        if private_key:
            push_url = f"ssh://git@ssh.github.com:443/{self.repo_slug}.git"
            ssh_command = (
                f'ssh -i "{private_key}" -o IdentitiesOnly=yes '
                "-o StrictHostKeyChecking=accept-new"
            )
            self.run(["git", "-c", f"core.sshCommand={ssh_command}", "push", push_url, refspec])
            self.log(f"已通过 SSH key 推送 {refspec}", "OK")
            return

        self.log("未找到 SSH 私钥，回退到 git remote 推送", "WARN")
        self.run(["git", "push", self.args.remote, refspec])
        self.log(f"已通过 remote {self.args.remote} 推送 {refspec}", "OK")

    def enable_and_dispatch_workflow(self) -> dict[str, Any] | None:
        if self.args.no_dispatch:
            self.log("传入了 --no-dispatch，跳过触发 Action", "WARN")
            return None

        run_start = datetime.now(timezone.utc) - timedelta(seconds=15)

        try:
            self.github_api("PUT", f"actions/workflows/{self.args.workflow}/enable")
            self.log(f"Workflow 已启用：{self.args.workflow}", "OK")
        except Exception as exc:  # noqa: BLE001
            self.log(f"启用 workflow 失败或无需启用，将继续尝试触发：{exc}", "WARN")

        self.github_api(
            "POST",
            f"actions/workflows/{self.args.workflow}/dispatches",
            {"ref": self.branch},
        )
        self.log(f"已触发 workflow_dispatch：{self.args.workflow} @ {self.branch}", "OK")

        encoded_branch = urllib.parse.quote(self.branch, safe="")
        deadline = time.time() + self.args.timeout_minutes * 60
        while time.time() < deadline:
            runs = self.github_api(
                "GET",
                f"actions/workflows/{self.args.workflow}/runs"
                f"?branch={encoded_branch}&event=workflow_dispatch&per_page=20",
            )
            for run in runs.get("workflow_runs", []):
                created_at = self.parse_github_time(run["created_at"])
                if run.get("head_sha") == self.head_sha and created_at >= run_start:
                    self.log(
                        f"找到 Action Run：#{run.get('run_number')} id={run.get('id')} "
                        f"{run.get('html_url')}",
                        "OK",
                    )
                    return run
            self.log("等待 GitHub 创建 Action Run...", "INFO")
            time.sleep(self.args.poll_seconds)

        raise RuntimeError("超时：未找到刚触发的 Action Run")

    @staticmethod
    def parse_github_time(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def wait_workflow_run(self, run: dict[str, Any] | None) -> dict[str, Any] | None:
        if run is None:
            return None

        deadline = time.time() + self.args.timeout_minutes * 60
        while time.time() < deadline:
            current = self.github_api("GET", f"actions/runs/{run['id']}")
            self.log(
                "Run #{0} 状态：status={1}, conclusion={2}, url={3}".format(
                    current.get("run_number"),
                    current.get("status"),
                    current.get("conclusion"),
                    current.get("html_url"),
                ),
                "INFO",
            )

            try:
                jobs = self.github_api("GET", f"actions/runs/{run['id']}/jobs?per_page=100")
                for job in jobs.get("jobs", []):
                    self.log(
                        "Job: {0} | status={1} | conclusion={2}".format(
                            job.get("name"),
                            job.get("status"),
                            job.get("conclusion"),
                        ),
                        "INFO",
                    )
            except Exception as exc:  # noqa: BLE001
                self.log(f"读取 jobs 失败：{exc}", "WARN")

            if current.get("status") == "completed":
                if current.get("conclusion") != "success":
                    raise RuntimeError(
                        f"Action 执行结束但未成功：conclusion={current.get('conclusion')}，"
                        f"地址：{current.get('html_url')}"
                    )
                self.log(f"Action 执行成功：{current.get('html_url')}", "OK")
                return current

            time.sleep(self.args.poll_seconds)

        raise RuntimeError(f"超时：Action 未在 {self.args.timeout_minutes} 分钟内完成")

    def show_and_download_artifacts(self, run: dict[str, Any] | None) -> None:
        if run is None:
            return

        artifacts = self.github_api("GET", f"actions/runs/{run['id']}/artifacts?per_page=100")
        all_artifacts = artifacts.get("artifacts", [])
        if not all_artifacts:
            self.log("该 Run 没有 artifact", "WARN")
            return

        selected = [item for item in all_artifacts if re.search("windows", item.get("name", ""), re.I)]
        if not selected:
            self.log("没有找到 Windows artifact，改为列出全部 artifact", "WARN")
            selected = all_artifacts

        self.log("构建产物：", "OK")
        for artifact in selected:
            artifact_id = artifact.get("id")
            ui_url = f"https://github.com/{self.repo_slug}/actions/runs/{run['id']}/artifacts/{artifact_id}"
            self.log(
                "Artifact: {0} | size={1} bytes | expired={2}".format(
                    artifact.get("name"),
                    artifact.get("size_in_bytes"),
                    artifact.get("expired"),
                ),
                "OK",
            )
            self.log(f"浏览器下载页：{ui_url}", "OK")
            self.log(f"API zip 下载：{artifact.get('archive_download_url')}", "OK")

        if not self.args.download_windows_artifact:
            return

        download_dir = Path(
            self.args.download_dir or self.repo_root / "dist-artifacts" / f"run-{run['id']}"
        )
        download_dir.mkdir(parents=True, exist_ok=True)

        for artifact in selected:
            zip_path = download_dir / f"{artifact.get('name')}-{artifact.get('id')}.zip"
            self.log(f"开始下载 artifact：{artifact.get('name')} -> {zip_path}", "INFO")
            request = urllib.request.Request(
                artifact["archive_download_url"],
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {self.github_token}",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "biliLive-tools-one-click-release",
                },
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                zip_path.write_bytes(response.read())
            self.log(f"下载完成：{zip_path}", "OK")

    def run_all(self) -> None:
        os.chdir(self.repo_root)
        self.log(f"日志文件：{self.log_file}", "INFO")
        self.log(f"仓库目录：{self.repo_root}", "INFO")

        self.require_command("git")
        if not self.branch:
            self.branch = self.git_text("rev-parse", "--abbrev-ref", "HEAD")
        if self.branch == "HEAD":
            raise RuntimeError("当前处于 detached HEAD，请用 --branch 指定要推送和触发的分支")

        self.repo_slug = self.get_repo_slug()
        self.github_token = self.get_github_token()

        self.log(f"目标仓库：{self.repo_slug}", "INFO")
        self.log(f"目标分支：{self.branch}", "INFO")
        self.log(f"目标 workflow：{self.args.workflow}", "INFO")

        if self.args.skip_verify:
            self.log("传入了 --skip-verify，跳过本地校验", "WARN")
        else:
            self.verify()

        self.commit_changes()
        self.head_sha = self.git_text("rev-parse", "HEAD")
        self.log(f"当前 HEAD：{self.head_sha}", "INFO")

        self.push_current_head()
        run = self.enable_and_dispatch_workflow()
        completed_run = self.wait_workflow_run(run)
        self.show_and_download_artifacts(completed_run)
        self.log("一键流程完成", "OK")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify, commit, push, trigger release.yml, and print Windows artifact links."
    )
    parser.add_argument("-m", "--message", default="", help="Git commit message.")
    parser.add_argument("--workflow", default="release.yml", help="Workflow file name or id.")
    parser.add_argument("--branch", default="", help="Target branch. Defaults to current branch.")
    parser.add_argument("--remote", default="origin", help="Git remote name.")
    parser.add_argument(
        "--ssh-key",
        default=str(Path.home() / ".ssh" / "id_rsa"),
        help="SSH private key file or .ssh directory.",
    )
    parser.add_argument("--token", default="", help="GitHub token. Prefer env vars instead.")
    parser.add_argument("--poll-seconds", type=int, default=30, help="Polling interval.")
    parser.add_argument("--timeout-minutes", type=int, default=90, help="Workflow timeout.")
    parser.add_argument("--skip-verify", action="store_true", help="Skip local checks.")
    parser.add_argument("--no-commit", action="store_true", help="Do not commit changes.")
    parser.add_argument("--no-push", action="store_true", help="Do not push.")
    parser.add_argument("--no-dispatch", action="store_true", help="Do not trigger Actions.")
    parser.add_argument(
        "--use-remote-push",
        action="store_true",
        help="Use git push remote instead of SSH URL with explicit key.",
    )
    parser.add_argument(
        "--download-windows-artifact",
        action="store_true",
        help="Download Windows artifact zip after successful build.",
    )
    parser.add_argument("--download-dir", default="", help="Artifact download directory.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    runner = OneClickRelease(args)
    try:
        runner.run_all()
        return 0
    except Exception as exc:  # noqa: BLE001
        runner.log(str(exc), "ERROR")
        runner.log(f"流程失败，完整日志见：{runner.log_file}", "ERROR")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
