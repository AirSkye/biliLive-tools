#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Commit, SSH push, tag-trigger release.yml, and print Windows release links.

Examples:
  py scripts/tag_release_build.py -m "fix: local detection"
  py scripts/tag_release_build.py -m "fix: quick build" --skip-verify
  py scripts/tag_release_build.py --no-commit --tag codex-build-test
  py scripts/tag_release_build.py --resume-tag codex-build-20260708-151714
  py scripts/tag_release_build.py --resume-latest-tag

Notes:
  - This script triggers the existing release workflow by pushing a tag.
  - It does not require GitHub CLI.
  - GitHub API reads are public when the repo is public. If rate-limited or private,
    set GITHUB_TOKEN, GH_TOKEN, or GITHUB_PAT in the environment.
  - Tokens are never printed and are not required for git push.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable


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


class ReleaseBuild:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.repo_root = Path(__file__).resolve().parents[1]
        self.log_dir = self.repo_root / "scripts" / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = self.log_dir / f"tag-release-build-{datetime.now():%Y%m%d-%H%M%S}.log"
        self.repo_slug = ""
        self.branch = ""
        self.head_sha = ""
        self.tag_name = ""
        self.github_token = self._read_optional_token()
        self.run_id: int | None = None

    def log(self, message: str, level: str = "INFO") -> None:
        line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] [{level}] {message}"
        with self.log_file.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")

        color = LEVEL_COLORS.get(level, "")
        if sys.stdout.isatty() and color:
            print(f"{color}{line}{RESET}")
        else:
            print(line)

    @staticmethod
    def _format_command(command: Iterable[str]) -> str:
        def quote(part: str) -> str:
            if re.search(r"\s", part):
                return f'"{part}"'
            return part

        return " ".join(quote(str(item)) for item in command)

    def run_cmd(
        self,
        command: list[str],
        *,
        allow_failure: bool = False,
        env: dict[str, str] | None = None,
    ) -> CommandResult:
        self.log(f"执行命令：{self._format_command(command)}", "CMD")
        process = subprocess.run(
            command,
            cwd=str(self.repo_root),
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
            raise RuntimeError(f"命令失败，退出码 {process.returncode}：{self._format_command(command)}")

        return CommandResult(stdout=stdout, stderr=stderr, returncode=process.returncode)

    @staticmethod
    def _is_retryable_git_push_failure(result: CommandResult) -> bool:
        text = f"{result.stdout}\n{result.stderr}".lower()
        hard_failures = [
            "permission denied (publickey)",
            "repository not found",
            "could not resolve hostname",
            "authentication failed",
        ]
        if any(item in text for item in hard_failures):
            return False

        retryable = [
            "connection closed",
            "connection reset",
            "connection timed out",
            "operation timed out",
            "kex_exchange_identification",
            "banner exchange",
            "remote host closed",
            "early eof",
            "failed to connect",
            "connection refused",
            "broken pipe",
        ]
        return any(item in text for item in retryable)

    def _git_push_retry_delay(self, attempt: int) -> float:
        base = max(float(self.args.git_push_retry_base_seconds), 0.1)
        return min(base * (2 ** max(attempt - 1, 0)), 45.0)

    def run_git_push(self, command: list[str]) -> CommandResult:
        attempts = max(int(self.args.git_push_retries), 0) + 1
        env = self.ssh_git_env()
        last_result: CommandResult | None = None
        for attempt in range(1, attempts + 1):
            result = self.run_cmd(command, allow_failure=True, env=env)
            last_result = result
            if result.returncode == 0:
                return result
            if attempt < attempts and self._is_retryable_git_push_failure(result):
                delay = self._git_push_retry_delay(attempt)
                self.log(
                    f"git push SSH 连接异常，{delay:.1f}s 后重试 "
                    f"({attempt}/{attempts - 1})",
                    "WARN",
                )
                time.sleep(delay)
                continue
            break

        returncode = last_result.returncode if last_result else -1
        raise RuntimeError(
            f"命令失败，退出码 {returncode}：{self._format_command(command)}"
        )

    def git_text(self, *arguments: str, allow_failure: bool = False) -> str:
        result = self.run_cmd(["git", *arguments], allow_failure=allow_failure)
        return result.stdout.strip()

    def local_bin(self, name: str) -> str:
        suffix = ".cmd" if os.name == "nt" else ""
        path = self.repo_root / "node_modules" / ".bin" / f"{name}{suffix}"
        return str(path)

    def require_command(self, name: str) -> None:
        if shutil.which(name) is None:
            raise RuntimeError(f"缺少命令：{name}")
        self.log(f"命令可用：{name}", "OK")

    def _read_optional_token(self) -> str:
        if self.args.token:
            return self.args.token
        for name in ("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"):
            value = os.environ.get(name)
            if value:
                return value
        return ""

    @staticmethod
    def _is_retryable_http_error(error: urllib.error.HTTPError, raw: str) -> bool:
        if error.code in {429, 500, 502, 503, 504}:
            return True
        return error.code == 403 and "rate limit" in raw.lower()

    def _github_retry_delay(self, attempt: int, error: urllib.error.HTTPError | None = None) -> float:
        if error is not None:
            retry_after = error.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                return min(float(retry_after), 60.0)
        base = max(float(self.args.api_retry_base_seconds), 0.1)
        return min(base * (2 ** max(attempt - 1, 0)), 30.0)

    def github_api(self, path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        url = f"https://api.github.com/repos/{self.repo_slug}/{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "biliLive-tools-tag-release-build",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.github_token:
            headers["Authorization"] = f"Bearer {self.github_token}"

        data: bytes | None = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        self.log(f"GitHub API {method} {path}", "API")
        attempts = max(int(self.args.api_retries), 0) + 1
        for attempt in range(1, attempts + 1):
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=self.args.api_timeout_seconds) as response:
                    raw = response.read()
                    if not raw:
                        return None
                    return json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as error:
                raw = error.read().decode("utf-8", errors="replace")
                if attempt < attempts and self._is_retryable_http_error(error, raw):
                    delay = self._github_retry_delay(attempt, error)
                    self.log(
                        f"GitHub API 暂时失败，{delay:.1f}s 后重试 "
                        f"({attempt}/{attempts - 1})：HTTP {error.code}",
                        "WARN",
                    )
                    time.sleep(delay)
                    continue
                raise RuntimeError(f"GitHub API 失败：{method} {path} -> HTTP {error.code}: {raw}") from error
            except (urllib.error.URLError, TimeoutError, ssl.SSLError, ConnectionResetError, OSError) as error:
                if attempt < attempts:
                    delay = self._github_retry_delay(attempt)
                    self.log(
                        f"GitHub API 网络异常，{delay:.1f}s 后重试 "
                        f"({attempt}/{attempts - 1})：{type(error).__name__}: {error}",
                        "WARN",
                    )
                    time.sleep(delay)
                    continue
                raise RuntimeError(f"GitHub API 网络失败：{method} {path} -> {error}") from error

        raise RuntimeError(f"GitHub API 网络失败：{method} {path}")

    def resolve_repo_slug(self) -> str:
        if self.args.repo:
            return self.args.repo.strip().removeprefix("https://github.com/").removesuffix(".git")

        remote_url = self.git_text("config", "--get", f"remote.{self.args.remote}.url")
        patterns = [
            r"(?:github\.com|ssh\.github\.com)(?::\d+)?[:/](?P<slug>[^/]+/[^/]+?)(?:\.git)?$",
            r"git@(?:github\.com|ssh\.github\.com):(?P<slug>[^/]+/[^/]+?)(?:\.git)?$",
        ]
        for pattern in patterns:
            match = re.search(pattern, remote_url)
            if match:
                return match.group("slug").removesuffix(".git")
        raise RuntimeError(f"无法从 remote URL 解析 GitHub 仓库：{remote_url}")

    def resolve_branch(self) -> str:
        if self.args.branch:
            return self.args.branch
        branch = self.git_text("rev-parse", "--abbrev-ref", "HEAD")
        if branch == "HEAD":
            raise RuntimeError("当前处于 detached HEAD，请用 --branch 指定要推送的分支")
        return branch

    def resolve_ssh_key(self) -> str:
        candidates: list[Path] = []
        if self.args.ssh_key:
            supplied = Path(self.args.ssh_key).expanduser()
            if supplied.is_file():
                candidates.append(supplied)
            elif supplied.is_dir():
                candidates.extend([supplied / "id_rsa", supplied / "id_ed25519"])

        ssh_dir = Path.home() / ".ssh"
        candidates.extend([ssh_dir / "id_rsa", ssh_dir / "id_ed25519"])
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate.resolve())
        return ""

    def ssh_git_env(self) -> dict[str, str]:
        private_key = self.resolve_ssh_key()
        if not private_key:
            self.log("未找到 SSH 私钥，将使用 git 默认认证方式", "WARN")
            return os.environ.copy()

        env = os.environ.copy()
        env["GIT_SSH_COMMAND"] = (
            f'ssh -i "{private_key}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
        )
        self.log(f"SSH 私钥：{private_key}", "INFO")
        return env

    def push_url(self) -> str:
        if self.args.push_url:
            return self.args.push_url
        return f"ssh://git@ssh.github.com:443/{self.repo_slug}.git"

    def verify(self) -> None:
        if self.args.skip_verify:
            self.log("传入 --skip-verify，跳过本地校验", "WARN")
            return

        self.log("开始本地校验", "INFO")
        self.run_cmd(["git", "diff", "--check"])

        tsc = self.local_bin("tsc")
        if Path(tsc).exists():
            self.run_cmd(
                [
                    tsc,
                    "--noEmit",
                    "-p",
                    r"packages\http\tsconfig.json",
                    "--composite",
                    "false",
                ]
            )
            self.run_cmd(
                [
                    tsc,
                    "--noEmit",
                    "-p",
                    r"packages\app\tsconfig.web.json",
                    "--composite",
                    "false",
                ]
            )
        else:
            self.log(f"未找到 {tsc}，跳过 TypeScript 检查", "WARN")

        vitest = self.local_bin("vitest")
        if Path(vitest).exists():
            self.run_cmd([vitest, "run", r"packages\http\test\webhook.test.ts"])
        else:
            self.log(f"未找到 {vitest}，跳过 webhook 测试", "WARN")

        self.log("本地校验完成", "OK")

    def scan_staged_diff_for_secrets(self) -> None:
        diff = self.run_cmd(["git", "diff", "--cached", "--"], allow_failure=False).stdout
        patterns = [
            r"github_pat_[A-Za-z0-9_]+",
            r"gh[pousr]_[A-Za-z0-9_]+",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        ]
        hits: list[str] = []
        for pattern in patterns:
            if re.search(pattern, diff):
                hits.append(pattern)
        if hits:
            raise RuntimeError(f"疑似密钥出现在待提交 diff 中，已停止：{', '.join(hits)}")
        self.log("待提交 diff 未发现常见 GitHub token/private key 特征", "OK")

    def commit_if_needed(self) -> None:
        status = self.run_cmd(["git", "status", "--porcelain"]).stdout.splitlines()
        if not status:
            self.log("工作区没有待提交改动，跳过提交", "INFO")
            return

        if self.args.no_commit:
            self.log("工作区有改动，但传入 --no-commit，跳过提交", "WARN")
            return

        message = self.args.message.strip()
        if not message:
            message = f"chore: local release build {datetime.now():%Y%m%d-%H%M}"
            self.log(f"未传入 --message，使用默认提交信息：{message}", "WARN")

        self.run_cmd(["git", "add", "-A"])
        self.scan_staged_diff_for_secrets()
        self.run_cmd(["git", "diff", "--cached", "--stat"])
        self.run_cmd(["git", "commit", "-m", message])
        self.log(f"提交完成：{message}", "OK")

    def push_head(self) -> None:
        if self.args.no_push:
            self.log("传入 --no-push，跳过分支推送", "WARN")
            return

        refspec = f"HEAD:{self.branch}"
        self.run_git_push(["git", "push", self.push_url(), refspec])
        self.log(f"分支已推送：{refspec}", "OK")

    def create_tag_name(self) -> str:
        if self.args.tag:
            return self.args.tag.strip()
        return f"{self.args.tag_prefix}-{datetime.now():%Y%m%d-%H%M%S}"

    def ensure_local_tag(self) -> None:
        self.tag_name = self.create_tag_name()
        exists = self.run_cmd(["git", "rev-parse", "-q", "--verify", f"refs/tags/{self.tag_name}"], allow_failure=True)
        if exists.returncode == 0:
            if not self.args.force_tag:
                raise RuntimeError(f"本地 tag 已存在：{self.tag_name}。可换名或加 --force-tag。")
            self.run_cmd(["git", "tag", "-d", self.tag_name])

        self.run_cmd(["git", "tag", self.tag_name])
        self.log(f"本地 tag 已创建：{self.tag_name}", "OK")

    def push_tag(self) -> None:
        if self.args.no_push:
            self.log("传入 --no-push，跳过 tag 推送", "WARN")
            return

        ref = f"refs/tags/{self.tag_name}"
        command = ["git", "push", self.push_url(), ref]
        if self.args.force_tag:
            command = ["git", "push", "--force", self.push_url(), ref]
        self.run_git_push(command)
        self.log(f"tag 已推送：{self.tag_name}", "OK")

    def resolve_latest_tag_name(self) -> str:
        pattern = f"{self.args.tag_prefix}-*"
        tags: set[str] = set()

        remote_tags = self.run_cmd(
            ["git", "ls-remote", "--tags", self.args.remote, pattern],
            allow_failure=True,
        )
        if remote_tags.returncode == 0:
            for line in remote_tags.stdout.splitlines():
                match = re.search(r"refs/tags/([^\^{}]+)$", line.strip())
                if match:
                    tags.add(match.group(1))

        local_tags = self.run_cmd(["git", "tag", "--list", pattern], allow_failure=True)
        if local_tags.returncode == 0:
            for line in local_tags.stdout.splitlines():
                tag = line.strip()
                if tag:
                    tags.add(tag)

        if not tags:
            raise RuntimeError(f"没有找到匹配的 tag：{pattern}")

        tag = sorted(tags)[-1]
        self.log(f"最新 tag：{tag}", "OK")
        return tag

    def resolve_resume_tag(self) -> str:
        if self.args.resume_tag:
            return self.args.resume_tag.strip()
        if self.args.resume_latest_tag:
            return self.resolve_latest_tag_name()
        return ""

    def resolve_tag_head_sha(self, tag: str) -> str:
        local = self.run_cmd(["git", "rev-list", "-n", "1", tag], allow_failure=True)
        if local.returncode == 0 and local.stdout.strip():
            return local.stdout.strip()

        remote = self.run_cmd(
            ["git", "ls-remote", "--tags", self.args.remote, f"refs/tags/{tag}"],
            allow_failure=True,
        )
        if remote.returncode == 0:
            for line in remote.stdout.splitlines():
                sha = line.split(maxsplit=1)[0].strip()
                if sha:
                    return sha

        raise RuntimeError(f"无法解析 tag 对应提交：{tag}")

    @staticmethod
    def parse_github_time(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def wait_for_run(self, run_after: datetime | None) -> dict[str, Any]:
        deadline = time.time() + self.args.timeout_minutes * 60
        encoded_workflow = urllib.parse.quote(self.args.workflow, safe="")
        encoded_tag = urllib.parse.quote(self.tag_name, safe="")
        while time.time() < deadline:
            runs = self.github_api(
                f"actions/workflows/{encoded_workflow}/runs?event=push&branch={encoded_tag}&per_page=20"
            )
            for run in runs.get("workflow_runs", []):
                created_at = self.parse_github_time(run.get("created_at", "1970-01-01T00:00:00Z"))
                if self.head_sha and run.get("head_sha") != self.head_sha:
                    continue
                if run_after and created_at < run_after:
                    continue
                self.run_id = int(run["id"])
                self.log(
                    f"找到 Action Run：id={run['id']} status={run.get('status')} url={run.get('html_url')}",
                    "OK",
                )
                return run

            self.log("等待 GitHub Actions 创建 tag push run...", "INFO")
            time.sleep(self.args.poll_seconds)

        raise RuntimeError("超时：未找到本次 tag push 对应的 Action Run")

    def log_jobs(self, run_id: int) -> None:
        jobs = self.github_api(f"actions/runs/{run_id}/jobs?per_page=100")
        for job in jobs.get("jobs", []):
            self.log(
                "Job: {name} | status={status} | conclusion={conclusion} | started={started} | completed={completed}".format(
                    name=job.get("name"),
                    status=job.get("status"),
                    conclusion=job.get("conclusion"),
                    started=job.get("started_at"),
                    completed=job.get("completed_at"),
                ),
                "INFO",
            )

    def wait_for_run_success(self, run: dict[str, Any]) -> dict[str, Any]:
        deadline = time.time() + self.args.timeout_minutes * 60
        run_id = int(run["id"])
        while time.time() < deadline:
            current = self.github_api(f"actions/runs/{run_id}")
            self.log(
                f"Run 状态：status={current.get('status')} conclusion={current.get('conclusion')} "
                f"updated={current.get('updated_at')} url={current.get('html_url')}",
                "INFO",
            )
            self.log_jobs(run_id)

            if current.get("status") == "completed":
                if current.get("conclusion") != "success":
                    raise RuntimeError(
                        f"Action 未成功：conclusion={current.get('conclusion')} url={current.get('html_url')}"
                    )
                self.log(f"Action 成功：{current.get('html_url')}", "OK")
                return current

            time.sleep(self.args.poll_seconds)

        raise RuntimeError(f"超时：Action 未在 {self.args.timeout_minutes} 分钟内完成")

    def wait_for_release_assets(self) -> list[dict[str, Any]]:
        deadline = time.time() + self.args.release_timeout_minutes * 60
        encoded_tag = urllib.parse.quote(self.tag_name, safe="")
        while time.time() < deadline:
            try:
                release = self.github_api(f"releases/tags/{encoded_tag}")
            except RuntimeError as exc:
                self.log(f"Release 暂不可用：{exc}", "WARN")
                time.sleep(self.args.poll_seconds)
                continue

            assets = release.get("assets", [])
            self.log(f"Release 已找到：{release.get('html_url')}，assets={len(assets)}", "OK")
            for asset in assets:
                self.log(
                    f"Asset: {asset.get('name')} | size={asset.get('size')} | url={asset.get('browser_download_url')}",
                    "OK",
                )

            windows_assets = [
                asset
                for asset in assets
                if re.search(self.args.windows_asset_regex, asset.get("name", ""), re.I)
            ]
            if windows_assets:
                return windows_assets

            self.log(f"尚未找到 Windows 产物，匹配规则：{self.args.windows_asset_regex}", "INFO")
            time.sleep(self.args.poll_seconds)

        raise RuntimeError("超时：Release 中没有等到 Windows 下载产物")

    def log_download_result(
        self,
        windows_assets: list[dict[str, Any]],
        completed: dict[str, Any] | None = None,
    ) -> None:
        self.log("Windows 下载链接：", "OK")
        for asset in windows_assets:
            self.log(asset["browser_download_url"], "OK")
        if completed:
            self.log(f"Action：{completed.get('html_url')}", "OK")
        self.log(f"Release：https://github.com/{self.repo_slug}/releases/tag/{self.tag_name}", "OK")

    def resume_existing_tag(self, tag_name: str) -> None:
        self.tag_name = tag_name
        self.head_sha = self.resolve_tag_head_sha(self.tag_name)
        self.log(f"续查已有 tag：{self.tag_name}", "INFO")
        self.log(f"tag HEAD：{self.head_sha}", "INFO")
        self.log("续查模式不会提交、推送分支、创建 tag，也不会重新触发 Action", "OK")

        if self.args.no_wait:
            self.log("传入 --no-wait，不等待 Action/Release", "WARN")
            self.log(f"Action 页面：https://github.com/{self.repo_slug}/actions/workflows/{self.args.workflow}", "OK")
            self.log(f"Release：https://github.com/{self.repo_slug}/releases/tag/{self.tag_name}", "OK")
            return

        run = self.wait_for_run(None)
        completed = self.wait_for_run_success(run)
        windows_assets = self.wait_for_release_assets()
        self.log_download_result(windows_assets, completed)
        self.log("续查完成", "OK")

    def run_all(self) -> None:
        os.chdir(self.repo_root)
        self.log(f"日志文件：{self.log_file}", "INFO")
        self.log(f"仓库目录：{self.repo_root}", "INFO")
        self.require_command("git")

        self.repo_slug = self.resolve_repo_slug()
        self.branch = self.resolve_branch()
        self.log(f"目标仓库：{self.repo_slug}", "INFO")
        self.log(f"目标分支：{self.branch}", "INFO")
        self.log(f"目标 workflow：{self.args.workflow}", "INFO")
        self.log("GitHub API token：已配置" if self.github_token else "GitHub API token：未配置，使用公开 API", "INFO")

        resume_tag = self.resolve_resume_tag()
        if resume_tag:
            self.resume_existing_tag(resume_tag)
            return

        self.verify()
        self.commit_if_needed()
        self.head_sha = self.git_text("rev-parse", "HEAD")
        self.log(f"当前 HEAD：{self.head_sha}", "INFO")

        self.push_head()
        run_after = datetime.now(timezone.utc) - timedelta(seconds=15)
        self.ensure_local_tag()
        self.push_tag()

        if self.args.no_push:
            self.log("传入 --no-push，tag 未推送，不会触发 Action；流程到此结束", "WARN")
            return

        if self.args.no_wait:
            self.log("传入 --no-wait，已完成提交/推送/tag 触发，不等待 Action", "WARN")
            self.log(f"Action 页面：https://github.com/{self.repo_slug}/actions/workflows/{self.args.workflow}", "OK")
            return

        run = self.wait_for_run(run_after)
        completed = self.wait_for_run_success(run)
        windows_assets = self.wait_for_release_assets()
        self.log_download_result(windows_assets, completed)
        self.log("流程完成", "OK")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Commit, SSH push, tag-trigger release.yml, and print Windows release links."
    )
    parser.add_argument("-m", "--message", default="", help="Git commit message.")
    parser.add_argument("--repo", default="", help="GitHub repo slug, for example AirSkye/biliLive-tools.")
    parser.add_argument("--remote", default="origin", help="Remote name used to infer repo slug.")
    parser.add_argument("--branch", default="", help="Branch to push. Defaults to current branch.")
    parser.add_argument("--workflow", default="release.yml", help="Workflow file name or id.")
    parser.add_argument("--ssh-key", default=str(Path.home() / ".ssh" / "id_rsa"), help="SSH key file or .ssh dir.")
    parser.add_argument("--push-url", default="", help="Override git push URL.")
    parser.add_argument("--token", default="", help="Optional GitHub API token. Prefer env vars.")
    parser.add_argument("--tag", default="", help="Explicit tag name. Defaults to <tag-prefix>-yyyyMMdd-HHmmss.")
    parser.add_argument("--tag-prefix", default="codex-build", help="Tag prefix when --tag is omitted.")
    parser.add_argument("--resume-tag", default="", help="Only wait an existing tag's Action/Release; no commit or push.")
    parser.add_argument(
        "--resume-latest-tag",
        action="store_true",
        help="Only wait the latest <tag-prefix>-* tag's Action/Release; no commit or push.",
    )
    parser.add_argument("--force-tag", action="store_true", help="Delete/recreate local tag and force-push tag.")
    parser.add_argument("--skip-verify", action="store_true", help="Skip local git diff, tsc, and vitest checks.")
    parser.add_argument("--no-commit", action="store_true", help="Do not commit local changes.")
    parser.add_argument("--no-push", action="store_true", help="Do not push branch or tag.")
    parser.add_argument("--no-wait", action="store_true", help="Do not wait for Actions or release assets.")
    parser.add_argument("--poll-seconds", type=int, default=30, help="Polling interval for GitHub API.")
    parser.add_argument("--timeout-minutes", type=int, default=90, help="Action run timeout.")
    parser.add_argument("--release-timeout-minutes", type=int, default=20, help="Release asset timeout.")
    parser.add_argument("--api-timeout-seconds", type=int, default=60, help="Single GitHub API HTTP timeout.")
    parser.add_argument("--api-retries", type=int, default=5, help="Retries for transient GitHub API errors.")
    parser.add_argument(
        "--api-retry-base-seconds",
        type=float,
        default=3.0,
        help="Base backoff seconds for transient GitHub API retries.",
    )
    parser.add_argument("--git-push-retries", type=int, default=4, help="Retries for transient git push SSH errors.")
    parser.add_argument(
        "--git-push-retry-base-seconds",
        type=float,
        default=5.0,
        help="Base backoff seconds for transient git push retries.",
    )
    parser.add_argument(
        "--windows-asset-regex",
        default=r"win-x64\.(exe|zip)$",
        help="Regex for release assets to print as Windows downloads.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    runner = ReleaseBuild(args)
    try:
        runner.run_all()
        return 0
    except Exception as exc:  # noqa: BLE001
        runner.log(str(exc), "ERROR")
        runner.log(f"流程失败，完整日志见：{runner.log_file}", "ERROR")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
