from __future__ import annotations

import json
import os
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


DEFAULT_CONTAINER_REPO_DIR = "/opt/generic-ai"
DEFAULT_CONTAINER_AGENT_DIR = "/opt/generic-ai-pi-agent"
DEFAULT_NODE_VERSION = "v24.13.0"
REMOTE_ARTIFACT_DIR = "/logs/artifacts/generic-ai"
REMOTE_INSTRUCTION_PATH = "/tmp/generic-ai-instruction.md"
REMOTE_ARCHIVE_PATH = "/tmp/generic-ai-repo.tgz"
REMOTE_INSTALL_SCRIPT_PATH = "/tmp/install-generic-ai.sh"

EXCLUDED_ARCHIVE_PARTS = {
    ".git",
    ".agents",
    ".claude",
    ".codex",
    "node_modules",
    "dist",
    "jobs",
    "reports",
    "__pycache__",
    "%SystemDrive%",
}


def _repo_root() -> Path:
    override = os.environ.get("GENERIC_AI_REPO_ROOT")
    if override:
        return Path(override).expanduser().resolve()

    return Path(__file__).resolve().parents[3]


def _should_archive(path: Path, root: Path) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False

    if any(part in EXCLUDED_ARCHIVE_PARTS for part in relative.parts):
        return False

    return not path.name.endswith(".tsbuildinfo")


def _create_repo_archive(root: Path) -> Path:
    archive = tempfile.NamedTemporaryFile(prefix="generic-ai-repo-", suffix=".tgz", delete=False)
    archive_path = Path(archive.name)
    archive.close()

    with tarfile.open(archive_path, "w:gz") as tar:
        for path in root.rglob("*"):
            if not path.is_file() or not _should_archive(path, root):
                continue

            tar.add(path, arcname=str(Path("generic-ai") / path.relative_to(root)))

    return archive_path


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None

    return value if isinstance(value, dict) else None


class GenericAIInstalledAgent(BaseInstalledAgent):
    """Harbor installed-agent adapter for the private Generic AI Terminal-Bench example."""

    SUPPORTS_ATIF = True

    @staticmethod
    def name() -> str:
        return "generic-ai"

    def version(self) -> str | None:
        return self._version or "0.0.0"

    @property
    def _container_repo_dir(self) -> str:
        return os.environ.get("GENERIC_AI_CONTAINER_REPO_DIR", DEFAULT_CONTAINER_REPO_DIR)

    def _resolve_model(self) -> str:
        env_model = self._get_env("GENERIC_AI_MODEL")
        if env_model:
            return env_model

        if self.model_name and "/" in self.model_name:
            return self.model_name.split("/", maxsplit=1)[1]

        return self.model_name or "gpt-5.5"

    def _host_agent_dir(self) -> Path | None:
        override = os.environ.get("GENERIC_AI_HOST_AGENT_DIR")
        if override:
            candidate = Path(override).expanduser().resolve()
        else:
            candidate = Path.home() / ".pi" / "agent"

        return candidate if candidate.exists() else None

    def _render_install_script(self) -> Path:
        template_path = Path(__file__).resolve().parent / "install-generic-ai.sh.j2"
        script = template_path.read_text(encoding="utf-8")
        script = script.replace("{{GENERIC_AI_REPO_DIR}}", self._container_repo_dir)
        script = script.replace(
            "{{GENERIC_AI_NODE_VERSION}}",
            os.environ.get("GENERIC_AI_NODE_VERSION", DEFAULT_NODE_VERSION),
        )

        handle = tempfile.NamedTemporaryFile(
            prefix="install-generic-ai-",
            suffix=".sh",
            delete=False,
            mode="w",
            encoding="utf-8",
            newline="\n",
        )
        with handle:
            handle.write(script)

        return Path(handle.name)

    def _archive_path(self) -> tuple[Path, bool]:
        existing = os.environ.get("GENERIC_AI_REPO_ARCHIVE")
        if existing:
            return Path(existing).expanduser().resolve(), False

        return _create_repo_archive(_repo_root()), True

    async def install(self, environment: BaseEnvironment) -> None:
        await environment.exec(command="mkdir -p /opt /tmp", user="root")

        archive_path, remove_archive = self._archive_path()
        script_path = self._render_install_script()
        try:
            await environment.upload_file(archive_path, REMOTE_ARCHIVE_PATH)
            await environment.upload_file(script_path, REMOTE_INSTALL_SCRIPT_PATH)
            await self.exec_as_root(
                environment,
                command=f"bash {REMOTE_INSTALL_SCRIPT_PATH}",
                timeout_sec=int(os.environ.get("GENERIC_AI_INSTALL_TIMEOUT_SEC", "1800")),
            )
            host_agent_dir = self._host_agent_dir()
            if host_agent_dir is not None:
                await environment.upload_dir(host_agent_dir, DEFAULT_CONTAINER_AGENT_DIR)
                await self.exec_as_root(
                    environment,
                    command=f"chmod -R a+rX {DEFAULT_CONTAINER_AGENT_DIR}",
                    timeout_sec=60,
                )
        finally:
            if remove_archive:
                archive_path.unlink(missing_ok=True)
            script_path.unlink(missing_ok=True)

    def _agent_env(self) -> dict[str, str]:
        env = {
            "GENERIC_AI_BENCHMARK_ARTIFACT_DIR": REMOTE_ARTIFACT_DIR,
            "GENERIC_AI_DISABLE_NESTED_SANDBOX": "1",
            "GENERIC_AI_MODEL": self._resolve_model(),
            "GENERIC_AI_RUNTIME_ADAPTER": self._get_env("GENERIC_AI_RUNTIME_ADAPTER")
            or "openai-codex",
        }

        api_key = self._get_env("GENERIC_AI_PROVIDER_API_KEY")
        if api_key:
            env["GENERIC_AI_PROVIDER_API_KEY"] = api_key
        elif self._host_agent_dir() is not None:
            env["GENERIC_AI_AGENT_DIR"] = DEFAULT_CONTAINER_AGENT_DIR

        for key in (
            "GENERIC_AI_BENCHMARK_COMMAND_TIMEOUT_MS",
            "GENERIC_AI_BENCHMARK_TRIAL_TIMEOUT_MS",
            "GENERIC_AI_BENCHMARK_MAX_COMMAND_OUTPUT_BYTES",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value

        return env

    async def _upload_instruction(self, environment: BaseEnvironment, instruction: str) -> None:
        handle = tempfile.NamedTemporaryFile(
            prefix="generic-ai-instruction-", suffix=".md", delete=False, mode="w", encoding="utf-8"
        )
        instruction_path = Path(handle.name)
        try:
            with handle:
                handle.write(instruction)
            await environment.upload_file(instruction_path, REMOTE_INSTRUCTION_PATH)
        finally:
            instruction_path.unlink(missing_ok=True)

    async def _download_artifacts(self, environment: BaseEnvironment) -> None:
        target = self.logs_dir / "generic-ai"
        target.mkdir(parents=True, exist_ok=True)
        try:
            await environment.download_dir(REMOTE_ARTIFACT_DIR, target)
        except Exception as exc:  # pragma: no cover - Harbor environment specific
            self.logger.warning("Could not download Generic AI artifacts: %s", exc)
            return

        trajectory = target / "trajectory.json"
        if trajectory.exists():
            shutil.copy2(trajectory, self.logs_dir / "trajectory.json")

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._upload_instruction(environment, instruction)
        command = (
            f"mkdir -p {REMOTE_ARTIFACT_DIR} && "
            f"node {self._container_repo_dir}/examples/terminal-bench/dist/benchmark-agent.js "
            f"--instruction-file {REMOTE_INSTRUCTION_PATH} "
            f"--output-dir {REMOTE_ARTIFACT_DIR} "
            '--workspace "$(pwd)"'
        )

        try:
            await self.exec_as_agent(
                environment,
                command=command,
                env=self._agent_env(),
            )
        finally:
            await self._download_artifacts(environment)
            self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        summary = _read_json(self.logs_dir / "generic-ai" / "summary.json")
        if summary is None:
            return

        token_usage = summary.get("tokenUsage")
        if isinstance(token_usage, dict):
            if isinstance(token_usage.get("inputTokens"), int):
                context.n_input_tokens = token_usage["inputTokens"]
            if isinstance(token_usage.get("outputTokens"), int):
                context.n_output_tokens = token_usage["outputTokens"]
            if isinstance(token_usage.get("cacheTokens"), int):
                context.n_cache_tokens = token_usage["cacheTokens"]

        cost_usd = summary.get("costUsd")
        if isinstance(cost_usd, (int, float)):
            context.cost_usd = float(cost_usd)

        metadata = context.metadata or {}
        metadata.update(
            {
                "generic_ai_status": summary.get("status"),
                "generic_ai_run_id": summary.get("runId"),
                "generic_ai_adapter": summary.get("adapter"),
                "generic_ai_model": summary.get("model"),
                "generic_ai_artifact_dir": REMOTE_ARTIFACT_DIR,
            }
        )
        context.metadata = metadata
