"""Persistent Python workspace kernel for Generic AI's `python` tool.

Adapted from Prime Agent (PrimeIntellect-ai/prime-agent, prime-agent-runtime/src/rlm/repl.py and
repl.md). Copyright (c) Prime Intellect. MIT License; see THIRD_PARTY_NOTICES.md.

Speaks newline-delimited JSON on stdio. Requests arrive on stdin; events leave on a private dup of
the original stdout. Cells run with top-level await in one persistent namespace on one asyncio
event loop, so variables, imports and background tasks survive between cells.

Requests:  execute {id, code} | interrupt {id?} | host_reply {id, data} | set_vars {id, vars}
           describe {id} | snapshot {id, path} | restore {id, path} | shutdown {id?}
Events:    ready | stdout/stderr {id, text} | result {id, text} | error {id, ename, evalue,
           traceback} | host_request {id, data} | done {id, status, ...}
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import inspect
import io
import json
import linecache
import os
import pickle
import platform
import signal
import sys
import threading
import traceback
import types
from typing import Any

PROTOCOL_VERSION = 1
_TEXT_CAP = 1_048_576
_FRAME_TEXT_CAP = 64 * 1024
_ALWAYS_SKIP = {"rlm", "asyncio", "exit", "quit", "open", "In", "Out", "get_ipython"}

# --- channels ------------------------------------------------------------------------------------

# Protocol frames go to a private dup of fd 1. Raw writes to fd 1 (C extensions, subprocesses) are
# sent to fd 2, which the host reads as unattributed output, so they cannot corrupt the protocol.
_protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
os.dup2(2, 1)
_requests = os.fdopen(os.dup(0), "rb")
_devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(_devnull, 0)
_write_lock = threading.Lock()


def _send(frame: dict[str, Any]) -> None:
    line = json.dumps(frame, ensure_ascii=False, default=repr)
    with _write_lock:
        _protocol.write(line + "\n")
        _protocol.flush()


def _cap(text: str) -> str:
    if len(text) <= _TEXT_CAP:
        return text
    return text[:_TEXT_CAP] + f"\n[... truncated at {_TEXT_CAP} characters ...]"


_cell_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("cell_id", default=None)


class _CellWriter(io.TextIOBase):
    """`sys.stdout`/`sys.stderr` replacement that tags each write with the writing cell's id."""

    def __init__(self, name: str) -> None:
        self._name = name

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:  # type: ignore[override]
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        cell = _cell_id.get()
        for start in range(0, len(text), _FRAME_TEXT_CAP):
            _send({"event": self._name, "id": cell, "text": text[start : start + _FRAME_TEXT_CAP]})
        return len(text)

    def flush(self) -> None:
        pass

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"


sys.stdout = _CellWriter("stdout")
sys.stderr = _CellWriter("stderr")
sys.stdin = open(os.devnull, encoding="utf-8")

# --- host bridge -----------------------------------------------------------------------------------

_loop: asyncio.AbstractEventLoop | None = None
_pending_host: dict[str, asyncio.Future[Any]] = {}
_host_counter = 0


class RLMHostError(Exception):
    """The host refused or failed a request (a model call, a tool call)."""


async def _host_request(kind: str, payload: dict[str, Any]) -> Any:
    global _host_counter
    assert _loop is not None
    _host_counter += 1
    request_id = f"h{_host_counter}"
    future: asyncio.Future[Any] = _loop.create_future()
    _pending_host[request_id] = future
    try:
        _send({"event": "host_request", "id": request_id, "cell": _cell_id.get(), "data": {"type": kind, **payload}})
        return await future
    finally:
        _pending_host.pop(request_id, None)


def _resolve_host_reply(request_id: str, data: Any) -> None:
    future = _pending_host.get(request_id)
    if future is None or future.done():
        return
    if isinstance(data, dict) and data.get("status") == "ok":
        future.set_result(data.get("result"))
    else:
        message = data.get("error") if isinstance(data, dict) else None
        future.set_exception(RLMHostError(str(message or "host request failed")))


class ToolResult:
    """What `rlm.tool` returns: the tool's text, its details, and whether it failed."""

    def __init__(self, text: str, details: Any, is_error: bool) -> None:
        self.text = text
        self.details = details
        self.is_error = is_error

    def __str__(self) -> str:
        return self.text

    def __repr__(self) -> str:
        preview = self.text if len(self.text) <= 200 else self.text[:200] + "..."
        return f"ToolResult(is_error={self.is_error}, text={preview!r}, chars={len(self.text)})"


class _RLM:
    """Helpers the host provides inside the workspace, available as `rlm`."""

    async def llm(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """Ask a model one question and return its text answer. `model` is "provider/id" or a name
        the host knows; without it the host's default sub-model answers."""
        payload: dict[str, Any] = {"prompt": str(prompt)}
        if model is not None:
            payload["model"] = model
        if system is not None:
            payload["system"] = system
        if max_tokens is not None:
            payload["maxTokens"] = int(max_tokens)
        result = await _host_request("llm", payload)
        return str(result.get("text", ""))

    async def llm_batch(
        self,
        prompts: list[str],
        *,
        model: str | None = None,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> list[str]:
        """Ask the same model several questions concurrently; answers come back in order."""
        return list(
            await asyncio.gather(
                *(self.llm(prompt, model=model, system=system, max_tokens=max_tokens) for prompt in prompts)
            )
        )

    async def models(self) -> list[dict[str, Any]]:
        """Models `llm` can use, as dicts with provider, id, name and contextWindow."""
        result = await _host_request("models", {})
        return list(result.get("models", []))

    async def tool(self, name: str, **arguments: Any) -> ToolResult:
        """Call one of the agent's tools from code. The result stays in the workspace unless you
        print it, so large outputs never enter the conversation."""
        result = await _host_request("tool", {"name": name, "arguments": arguments})
        return ToolResult(str(result.get("text", "")), result.get("details"), bool(result.get("isError")))

    async def tools(self) -> list[dict[str, Any]]:
        """Tools `tool` can call, as dicts with name and description."""
        result = await _host_request("tools", {})
        return list(result.get("tools", []))

    async def messages(self, start: int = -10, limit: int = 10, role: str = "*") -> list[dict[str, Any]]:
        """This conversation's messages as data: `rows[start:][:limit]` of those with `role`
        ("user", "assistant", "toolResult" or "*"), each with index, role and text."""
        result = await _host_request("messages", {"start": int(start), "limit": int(limit), "role": role})
        return list(result.get("messages", []))

    def __repr__(self) -> str:
        return "<rlm: llm, llm_batch, models, tool, tools, messages>"


_namespace: dict[str, Any] = {"__name__": "__main__", "__builtins__": __builtins__}
_namespace["rlm"] = _RLM()
_namespace["asyncio"] = asyncio
sys.modules["__main__"] = types.ModuleType("__main__")
sys.modules["__main__"].__dict__.update(_namespace)
_namespace = sys.modules["__main__"].__dict__

# --- execution -------------------------------------------------------------------------------------

_cell_counter = 0
_active_task: asyncio.Task[Any] | None = None
_active_id: str | None = None
_parked_interrupts: set[str] = set()
_interrupt_next = False
_main_thread = threading.main_thread()


def _format_exception(error: BaseException) -> dict[str, Any]:
    frames = traceback.extract_tb(error.__traceback__)
    for index, frame in enumerate(frames):
        if frame.filename.startswith("<cell-"):
            frames = frames[index:]
            break
    lines = ["Traceback (most recent call last):\n"] if frames else []
    lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(error), error)
    return {
        "ename": type(error).__name__,
        "evalue": _cap(str(error)),
        "traceback": [_cap(line) for line in lines],
    }


async def _run_cell(request_id: str, code: str) -> None:
    # asyncio re-raises SystemExit out of the event loop, which would end the kernel.
    try:
        await _run_cell_body(request_id, code)
    except SystemExit:
        raise RuntimeError("SystemExit is not allowed in the workspace; the kernel keeps running") from None


async def _run_cell_body(request_id: str, code: str) -> None:
    global _cell_counter
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    tree = ast.parse(code, filename, "exec")
    trailing: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        trailing = ast.Expression(tree.body.pop().value)  # type: ignore[attr-defined]
    body = compile(tree, filename, "exec", flags=flags)
    value = eval(body, _namespace)
    if inspect.iscoroutine(value):
        await value
    if trailing is not None:
        result = eval(compile(trailing, filename, "eval", flags=flags), _namespace)
        if inspect.iscoroutine(result):
            result = await result
        if result is not None:
            _namespace["_"] = result
            _send({"event": "result", "id": request_id, "text": _cap(repr(result))})


async def _execute(request_id: str, code: str) -> None:
    global _active_task, _active_id, _interrupt_next
    token = _cell_id.set(request_id)
    try:
        task = asyncio.ensure_future(_run_cell(request_id, code))
    finally:
        _cell_id.reset(token)
    _active_task = task
    _active_id = request_id
    if request_id in _parked_interrupts or _interrupt_next:
        _parked_interrupts.discard(request_id)
        _interrupt_next = False
        task.cancel()
    status = "ok"
    try:
        await task
    except (asyncio.CancelledError, KeyboardInterrupt):
        status = "error"
        _send({"event": "error", "id": request_id, "ename": "KeyboardInterrupt", "evalue": "interrupted", "traceback": ["KeyboardInterrupt: interrupted\n"]})
    except BaseException as error:  # noqa: BLE001 - report every failure to the host
        status = "error"
        _send({"event": "error", "id": request_id, **_format_exception(error)})
    finally:
        _active_task = None
        _active_id = None
    _send({"event": "done", "id": request_id, "status": status})


def _on_sigint(signum: int, frame: Any) -> None:
    task = _active_task
    if task is None or _loop is None:
        return
    try:
        running = asyncio.current_task(_loop)
    except RuntimeError:
        running = None
    if running is task:
        # The cell itself is running synchronous code: interrupt it where it stands.
        raise KeyboardInterrupt
    # The cell is waiting at an await (or another task is running): cancel it.
    _loop.call_soon_threadsafe(task.cancel)


def _user_names() -> list[str]:
    return sorted(
        name
        for name, value in _namespace.items()
        if not name.startswith("_") and name not in _ALWAYS_SKIP and not isinstance(value, types.ModuleType)
    )


def _describe(value: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {"type": type(value).__name__}
    try:
        entry["length"] = len(value)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        pass
    try:
        text = repr(value)
    except Exception:  # noqa: BLE001
        text = f"<{type(value).__name__}>"
    entry["preview"] = text if len(text) <= 120 else text[:117] + "..."
    return entry


def _snapshot(path: str) -> dict[str, Any]:
    saved: list[str] = []
    skipped: list[str] = []
    payload: dict[str, bytes] = {}
    for name in _user_names():
        try:
            payload[name] = pickle.dumps(_namespace[name])
            saved.append(name)
        except Exception:  # noqa: BLE001 - functions, sockets, generators and the like
            skipped.append(name)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "wb") as handle:
        pickle.dump(payload, handle)
    os.replace(temporary, path)
    return {"saved": saved, "skipped": skipped}


def _restore(path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"restored": [], "failed": [], "reason": "snapshot not found"}
    with open(path, "rb") as handle:
        payload = pickle.load(handle)
    restored: list[str] = []
    failed: list[str] = []
    for name, data in payload.items():
        try:
            _namespace[name] = pickle.loads(data)
            restored.append(name)
        except Exception:  # noqa: BLE001
            failed.append(name)
    return {"restored": restored, "failed": failed}


async def _handle(request: dict[str, Any]) -> bool:
    kind = request.get("type")
    request_id = request.get("id")
    if kind == "execute":
        await _execute(str(request_id), str(request.get("code", "")))
        return True
    if kind == "shutdown":
        if request_id is not None:
            _send({"event": "done", "id": request_id, "status": "ok"})
        return False
    try:
        extra: dict[str, Any]
        if kind == "set_vars":
            values = request.get("vars") or {}
            for name, value in values.items():
                if not str(name).isidentifier():
                    raise ValueError(f"not a valid variable name: {name!r}")
                _namespace[str(name)] = value
            extra = {"names": sorted(values)}
        elif kind == "describe":
            extra = {"variables": {name: _describe(_namespace[name]) for name in _user_names()}}
        elif kind == "snapshot":
            extra = _snapshot(str(request["path"]))
        elif kind == "restore":
            extra = _restore(str(request["path"]))
        else:
            raise ValueError(f"unknown request type: {kind!r}")
        _send({"event": "done", "id": request_id, "status": "ok", **extra})
    except Exception as error:  # noqa: BLE001
        _send({"event": "done", "id": request_id, "status": "error", "reason": str(error)})
    return True


def _reader(queue: asyncio.Queue[dict[str, Any] | None]) -> None:
    global _interrupt_next
    assert _loop is not None
    for raw in _requests:
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
        except Exception as error:  # noqa: BLE001
            _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": str(error), "traceback": []})
            continue
        kind = request.get("type")
        if kind == "interrupt":
            target = request.get("id")
            if _active_id is not None and (target is None or target == _active_id):
                signal.pthread_kill(_main_thread.ident or 0, signal.SIGINT)
            elif target is not None:
                _parked_interrupts.add(str(target))
            else:
                _interrupt_next = True
            continue
        if kind == "host_reply":
            _loop.call_soon_threadsafe(_resolve_host_reply, str(request.get("id")), request.get("data"))
            continue
        _loop.call_soon_threadsafe(queue.put_nowait, request)
    # The host is gone: stop the running cell and fail requests it waits on, then shut down.
    _loop.call_soon_threadsafe(_on_eof, queue)


def _on_eof(queue: asyncio.Queue[dict[str, Any] | None]) -> None:
    for future in list(_pending_host.values()):
        if not future.done():
            future.set_exception(RLMHostError("host closed the connection"))
    if _active_task is not None:
        _active_task.cancel()
    queue.put_nowait(None)


async def _serve() -> None:
    global _loop
    _loop = asyncio.get_running_loop()
    signal.signal(signal.SIGINT, _on_sigint)
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    threading.Thread(target=_reader, args=(queue,), daemon=True).start()
    _send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": platform.python_version()})
    while True:
        request = await queue.get()
        if request is None:
            break
        if not await _handle(request):
            break


if __name__ == "__main__":
    asyncio.run(_serve())
    os._exit(0)
