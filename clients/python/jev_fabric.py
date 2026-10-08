"""A thin client for `jev-fabric -- serve`, the JSONL session protocol.

One file, standard library only, Python 3.9+. Copy it next to your code, or
import it from ``~/.local/share/jev-fabric/current/clients/python``.

The client starts one ``serve`` child, writes one request line per call and
returns the response that carries the same id. Calls from several threads may
overlap: serve answers them concurrently, in any order. Budgets, deadlines,
credentials and Jev validation all live in the executable; this module only
frames JSON.

    from jev_fabric import Fabric

    with Fabric(max_evaluations=10) as fabric:
        job = fabric.start(["/bin/sh", "-c", "npm run dev"])
        fabric.watch(job, "ready", timeout_ms=30000)

        repl = fabric.spawn(["python3", "-i"])["id"]    # a session child
        fabric.write(repl, "print(6 * 7)\n")
        out = fabric.read(repl, "stdout", wait_ms=5000)
    # leaving the block ends the session and stops repl
"""

from __future__ import annotations

import itertools
import json
import os
import math
import re
from types import MappingProxyType
import subprocess
import threading
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence, TypedDict, Union

__all__ = ["Fabric", "FabricError", "PROTOCOL", "DecisionTarget", "DecisionProfiles", "DecisionResolution", "DecisionTargetView"]

# The protocol major this client speaks; features are only added within it.
PROTOCOL = 2

Json = Dict[str, Any]


class _TargetRequired(TypedDict):
    provider: str


class DecisionTarget(_TargetRequired, total=False):
    api: str
    model: str
    endpoint: str
    allowLocal: bool
    allowGenerated: bool
    providerOptions: Dict[str, Any]
    temperature: float


class _ProfilesRequired(TypedDict):
    version: Literal[1]
    profiles: Dict[str, DecisionTarget]


class DecisionProfiles(_ProfilesRequired, total=False):
    defaultProfile: str


class _ResolvedRequired(TypedDict):
    provider: str
    api: str
    model: str
    endpoint: str
    allowLocal: bool
    allowGenerated: bool


class _ResolvedTarget(_ResolvedRequired, total=False):
    providerOptions: Dict[str, Any]
    temperature: float


class _Credential(TypedDict):
    env: str
    resolved: Literal[False]


class _ResolutionRequired(TypedDict):
    target: _ResolvedTarget
    credential: _Credential
    imageSupport: Literal["supported", "unsupported", "model-dependent"]
    generated: bool


class DecisionResolution(_ResolutionRequired, total=False):
    profile: str

_DECISION_APIS = {"system-one", "cloudflare", "openai-decisions", "vercel-evaluate", "llama-cpp", "llama-system-one", "anthropic", "google"}
_TARGET_FIELDS = {"provider", "api", "model", "endpoint", "allowLocal", "allowGenerated", "providerOptions", "temperature"}
_CONFIG_ERROR = "Invalid decision target/profile: expected non-secret, finite JSON with only supported fields"


def _secret_field(key: str) -> bool:
    key = re.sub(r"[^a-z0-9]", "", key.lower())
    return bool(re.search(r"secret|password|credential|apikey|authorization", key)) or key in {
        "auth", "headers", "token", "accesstoken", "refreshtoken", "privatekey"
    }


def _object_fields(value: Any, allowed: Optional[set] = None) -> None:
    if type(value) is not dict or (allowed is not None and not value.keys() <= allowed):
        raise ValueError(_CONFIG_ERROR)


def _clone_json(value: Any, seen: Optional[set] = None, depth: int = 0, reject_secrets: bool = False) -> Any:
    if depth > 64:
        raise ValueError(_CONFIG_ERROR)
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    if type(value) not in (dict, list):
        raise ValueError(_CONFIG_ERROR)
    seen = set() if seen is None else seen
    if id(value) in seen:
        raise ValueError(_CONFIG_ERROR)
    seen.add(id(value))
    if type(value) is list:
        result = [_clone_json(v, seen, depth + 1, reject_secrets) for v in value]
    else:
        result = {}
        for key, item in value.items():
            if type(key) is not str or (reject_secrets and _secret_field(key)):
                raise ValueError(_CONFIG_ERROR)
            result[key] = _clone_json(item, seen, depth + 1, reject_secrets)
    seen.remove(id(value))
    return result


def _profile_name(value: Any) -> str:
    if type(value) is not str or re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value) is None or value in {"__proto__", "prototype", "constructor"}:
        raise ValueError(_CONFIG_ERROR)
    return value


def _validate_target(value: Any) -> DecisionTarget:
    target = _clone_json(value, reject_secrets=True)
    _object_fields(target, _TARGET_FIELDS)
    if type(target.get("provider")) is not str or not target["provider"].strip():
        raise ValueError(_CONFIG_ERROR)
    for key in ("provider", "api", "model", "endpoint"):
        if key in target and (type(target[key]) is not str or not target[key] or re.search(r"[\x00-\x1f\x7f]", target[key])):
            raise ValueError(_CONFIG_ERROR)
    if "api" in target and target["api"] not in _DECISION_APIS:
        raise ValueError(_CONFIG_ERROR)
    if "model" in target and (len(target["model"]) > 256 or re.search(r"[\ud800-\udfff]", target["model"])):
        raise ValueError(_CONFIG_ERROR)
    for key in ("allowLocal", "allowGenerated"):
        if key in target and type(target[key]) is not bool:
            raise ValueError(_CONFIG_ERROR)
    if "temperature" in target and (type(target["temperature"]) not in (float, int) or not 0 <= target["temperature"] <= 2):
        raise ValueError(_CONFIG_ERROR)
    if "providerOptions" in target:
        _object_fields(target["providerOptions"])
    if "endpoint" in target:
        # Raw shape matches native; selected preflight enforces loopback opt-in.
        endpoint = target["endpoint"]
        match = re.fullmatch(r"(https?)://([A-Za-z0-9.-]+|\[::1\])(?::([0-9]+))?(?:/.*)?", endpoint)
        if (not match or re.search(r"[^\x21-\x7e]|[?#\\]", endpoint) or len(endpoint) > 4096
                or (match[3] is not None and not 1 <= int(match[3]) <= 65535)
                or (match[1] != "https" and match[2] not in {"127.0.0.1", "[::1]"})):
            raise ValueError(_CONFIG_ERROR)
    return target


def _validate_resolved_target(value: Any) -> _ResolvedTarget:
    target = _validate_target(value)
    if not {"provider", "api", "model", "endpoint", "allowLocal", "allowGenerated"} <= target.keys():
        raise ValueError(_CONFIG_ERROR)
    if target["api"] not in _DECISION_APIS:
        raise ValueError(_CONFIG_ERROR)
    return target


def _serialize_profiles(value: DecisionProfiles) -> str:
    doc = _clone_json(value)
    _object_fields(doc, {"version", "defaultProfile", "profiles"})
    if type(doc.get("version")) is not int or doc["version"] != 1:
        raise ValueError(_CONFIG_ERROR)
    _object_fields(doc.get("profiles"))
    if len(doc["profiles"]) > 128:
        raise ValueError(_CONFIG_ERROR)
    for name, target in doc["profiles"].items():
        _profile_name(name)
        _validate_target(target)
    if "defaultProfile" in doc and _profile_name(doc["defaultProfile"]) not in doc["profiles"]:
        raise ValueError(_CONFIG_ERROR)
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > 65536:
        raise ValueError(_CONFIG_ERROR)
    return text


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({k: _freeze(v) for k, v in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(v) for v in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _thaw(v) for k, v in value.items()}
    if isinstance(value, tuple):
        return [_thaw(v) for v in value]
    return value

class FabricError(Exception):
    """A request the session refused or could not complete.

    ``code`` follows the CLI's exit codes: 2 for a malformed request, 22 for a
    rejected value, 124 for an expired deadline, 1 otherwise.
    """

    def __init__(self, code: int, message: str, op: Optional[str] = None) -> None:
        super().__init__(f"{op}: {message}" if op else message)
        self.code = code
        self.message = message
        self.op = op


class DecisionTargetView:
    """Immutable routing snapshot; no open/close and no stored credentials.

    Calls share the exact parent connection, deadline and evaluation budget.
    ``target`` returns a fresh, recursively read-only copy (arrays are tuples).
    """

    __slots__ = ("__parent", "__target", "__resolved", "__bind_lock")

    def __init__(self, parent: Fabric, target: Union[DecisionTarget, str]) -> None:
        parent._require_decision_targets()
        bound = _profile_name(target) if isinstance(target, str) else _freeze(_validate_target(target))
        object.__setattr__(self, "_DecisionTargetView__parent", parent)
        object.__setattr__(self, "_DecisionTargetView__target", bound)
        object.__setattr__(self, "_DecisionTargetView__resolved", None)
        object.__setattr__(self, "_DecisionTargetView__bind_lock", threading.Lock())

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("DecisionTargetView is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("DecisionTargetView is immutable")

    @property
    def target(self) -> Union[Mapping[str, Any], str]:
        return _freeze(_thaw(self.__target))

    def _prepare(self, evidence: Json) -> Any:
        request = _clone_json(evidence)
        _object_fields(request, {"state", "questions", "images"})
        resolution = None
        if isinstance(self.__target, str):
            # Hold the lock through offline preflight. Publish only a validated,
            # frozen target; failures leave the view unbound and retryable.
            with self.__bind_lock:
                if self.__resolved is None:
                    resolution = self.__parent.resolve_decision(dict(request, profile=self.__target))
                    target = _freeze(_validate_resolved_target(resolution.get("target")))
                    object.__setattr__(self, "_DecisionTargetView__resolved", target)
                routing = self.__resolved
        else:
            routing = self.__target
        request.update(_thaw(routing))
        return request, resolution

    def decide(self, evidence: Json, *, timeout_ms: Optional[int] = None, credential: Optional[str] = None) -> Json:
        request, _ = self._prepare(evidence)
        return self.__parent.decide(request, timeout_ms=timeout_ms, credential=credential)

    def resolve_decision(self, evidence: Json) -> DecisionResolution:
        request, resolution = self._prepare(evidence)
        return resolution if resolution is not None else self.__parent.resolve_decision(request)

class _Slot:
    """One request waiting for the response with its id."""

    __slots__ = ("done", "response")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.response: Optional[Json] = None


class Fabric:
    """One ``jev-fabric -- serve`` session.

    ``timeout_ms`` bounds the whole session (default: the CLI work default, one
    hour; at most 86400000). ``max_evaluations`` and ``max_tokens`` bound Jev
    calls for the whole session (defaults: 1 evaluation, 100000 reported
    tokens, as for ``jev``). ``binary`` defaults to ``$JEV_FABRIC_BIN`` or
    ``jev-fabric`` on PATH.

    The object is safe to share between threads, and their calls overlap:
    a background thread matches each response to its request by id. Writes,
    closes and stops of one session child apply in the order they were sent;
    ``jev`` calls run one at a time. Closing the session stops its children.
    """

    def __init__(
        self,
        *,
        binary: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        max_evaluations: Optional[int] = None,
        max_tokens: Optional[int] = None,
        env: Optional[Mapping[str, str]] = None,
        cwd: Optional[str] = None,
        decision_profiles: Optional[DecisionProfiles] = None,
    ) -> None:
        profiles = None if decision_profiles is None else _serialize_profiles(decision_profiles)
        if profiles is not None:
            env = dict(os.environ if env is None else env)
            env["DECISION_PROFILES"] = profiles
        executable = binary or os.environ.get("JEV_FABRIC_BIN") or "jev-fabric"
        argv = [executable, "--", "serve"]
        if timeout_ms is not None:
            argv += ["--timeout-ms", str(timeout_ms)]
        if max_tokens is not None and max_evaluations is None:
            max_evaluations = 1
        if max_evaluations is not None:
            argv.append(str(max_evaluations))
        if max_tokens is not None:
            argv.append(str(max_tokens))
        self._process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=None if env is None else dict(env),
            cwd=cwd,
        )
        self._ids = itertools.count(1)
        # The reader thread takes only _lock; a writer blocked on a full pipe
        # holds _write_lock and never stops responses from being delivered.
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: Dict[int, _Slot] = {}
        self._ended_error: Optional[FabricError] = None
        banner = self._read_line()
        ready = banner.get("ready")
        if not isinstance(ready, dict) or ready.get("protocol") != PROTOCOL:
            self.close()
            raise FabricError(1, f"unsupported serve protocol: {banner!r}")
        self.ready: Json = ready
        self._reader = threading.Thread(target=self._pump, name="jev-fabric-serve", daemon=True)
        self._reader.start()
        if profiles is not None:
            try:
                self._require_decision_targets()
            except FabricError:
                self.close()
                self._reader.join()
                self._process.stdout.close()
                self._process.stderr.close()
                raise

    # -- processes -----------------------------------------------------------

    def exec(
        self,
        argv: Sequence[str],
        *,
        stdin: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        cwd: Optional[str] = None,
    ) -> Json:
        """Run literal argv to completion and return its bounded receipt.

        A nonzero exit is a receipt with ``state: "failed"``, not an error.
        ``cwd`` is an absolute directory the command starts in.
        """
        return self._call("exec", argv=list(argv), stdin=stdin, timeoutMs=timeout_ms, cwd=cwd)

    def start(
        self,
        argv: Sequence[str],
        *,
        timeout_ms: Optional[int] = None,
        label: Optional[str] = None,
        cwd: Optional[str] = None,
        input: Optional[str] = None,
    ) -> str:
        """Start a detached job that outlives this session; returns its id.

        ``timeout_ms`` is the job's own lifetime, up to 86400000 (24 hours).
        ``label`` is 1..120 printable characters on one line. With
        ``input="pipe"`` its stdin stays open for :meth:`write`.
        """
        return self._call(
            "start", argv=list(argv), timeoutMs=timeout_ms, label=label, cwd=cwd, input=input
        )["id"]

    def spawn(
        self,
        argv: Sequence[str],
        *,
        stdin: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        label: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> Json:
        """Start a session child and return its running state (``id`` is ``s-…``).

        It lives until it exits, its own ``timeout_ms`` (up to 24 hours) passes,
        it is stopped, or this session ends. With ``stdin="pipe"`` (the default)
        its stdin stays open for :meth:`write`; ``"null"`` starts it closed.
        """
        return self._call(
            "spawn", argv=list(argv), stdin=stdin, timeoutMs=timeout_ms, label=label, cwd=cwd
        )

    def write(self, job: str, text: str) -> Json:
        """Append up to 65536 characters to an interactive child's stdin, in order."""
        return self._call("write", job=job, text=text)

    def close_input(self, job: str) -> Json:
        """End an interactive child's stdin. Idempotent."""
        return self._call("closeInput", job=job)

    def read(
        self,
        job: str,
        stream: str,
        *,
        offset: Optional[int] = None,
        max: Optional[int] = None,
        wait_ms: Optional[int] = None,
        encoding: Optional[str] = None,
    ) -> Json:
        """Up to ``max`` (default and limit 65536) bytes of ``stream`` from ``offset``.

        Returns a read record: ``offset``, ``bytes``, ``omittedBytes`` (loss
        before this read), ``text`` (or ``data`` in base64 with
        ``encoding="base64"``), ``next``, ``eof`` and ``state``. With ``wait_ms``
        (1..300000), a long poll that answers as soon as bytes past ``offset``
        exist, the stream ends, or ``wait_ms`` passes.
        """
        return self._call(
            "read", job=job, stream=stream, offset=offset, max=max, waitMs=wait_ms, encoding=encoding
        )

    def status(self, job: str) -> Json:
        return self._call("status", job=job)

    def events(self, job: str, *, after: int = 0, wait_ms: Optional[int] = None) -> List[Json]:
        """Retained events with a sequence above ``after`` (a bounded snapshot).

        With ``wait_ms`` (1..300000), a long poll: it returns once such an event
        exists or the job is terminal, or the (possibly empty) list once
        ``wait_ms`` passes.
        """
        return self._call("events", job=job, after=after, waitMs=wait_ms)

    def list(self, *, scope: Optional[str] = None) -> Json:
        """Job directories under the storage root: ``{"jobs": [...], "truncated": bool}``.

        With ``scope="session"``, this session's children instead.
        """
        return self._call("list", scope=scope)

    def capabilities(self) -> Json:
        """The binary's version, protocol, store format, platform and features."""
        return self._call("capabilities")

    def wait(self, job: str, *, timeout_ms: Optional[int] = None) -> Json:
        """The final receipt, or the running state once ``timeout_ms`` passes."""
        return self._call("wait", job=job, timeoutMs=timeout_ms)

    def stop(self, job: str) -> Json:
        return self._call("stop", job=job)

    def watch(self, job: str, literal: str, *, timeout_ms: Optional[int] = None) -> List[Json]:
        """Live output lines containing ``literal``, as monitor records."""
        return self._call("watch", job=job, literal=literal, timeoutMs=timeout_ms)

    # -- Jev -----------------------------------------------------------------

    def decision_providers(self) -> List[Json]:
        """List registered presets offline; this does not probe models or credentials."""
        return self._call("decisionProviders")

    def validate_decision(self, request: Json) -> Json:
        """Validate a decision request offline, without retrieving credentials."""
        if "profile" in request:
            self._require_decision_targets()
            _profile_name(request["profile"])
        return self._call("validateDecision", request=request)

    def decide(
        self,
        request: Json,
        *,
        timeout_ms: Optional[int] = None,
        credential: Optional[str] = None,
    ) -> Json:
        """One decision against the shared evaluation budget. Check ``status``.

        ``rawJson`` preserves provider JSON for exact-number parsing, for example
        ``json.loads(result["rawJson"], parse_float=decimal.Decimal)``.
        """
        if "profile" in request:
            self._require_decision_targets()
            _profile_name(request["profile"])
        return self._call("decide", request=request, timeoutMs=timeout_ms, credential=credential)

    def _require_decision_targets(self) -> None:
        if "decision-targets" not in self.ready.get("features", []):
            raise FabricError(1, "decision-targets requires an updated jev-fabric binary; update jev-fabric")

    def resolve_decision(self, request: Json) -> DecisionResolution:
        """Resolve routing offline; name credentials without retrieving them."""
        self._require_decision_targets()
        if "profile" in request:
            _profile_name(request["profile"])
        return self._call("resolveDecision", request=request)

    def with_decision_target(self, target: Union[DecisionTarget, str]) -> DecisionTargetView:
        """Snapshot non-secret routing in a non-owning view of this session."""
        self._require_decision_targets()
        return DecisionTargetView(self, target)

    def validate(self, request: Json) -> Json:
        """Strictly validate a Jev request offline, without credentials."""
        return self._call("validate", request=request)

    def jev(
        self,
        request: Json,
        *,
        timeout_ms: Optional[int] = None,
        provider: Optional[str] = None,
        credential: Optional[str] = None,
    ) -> Json:
        """One explicit, billed evaluation against the session budget.

        ``provider`` and ``credential`` apply to this request only; the
        credential travels over the private pipe and is never cached or echoed.
        """
        return self._call(
            "jev", request=request, timeoutMs=timeout_ms, provider=provider, credential=credential
        )

    # -- session -------------------------------------------------------------

    def close(self, timeout: float = 10.0) -> int:
        """End the session by closing its input; returns the exit code.

        serve answers every request in flight and stops the session children
        before it exits.
        """
        process = self._process
        if process.stdin and not process.stdin.closed:
            try:
                with self._write_lock:
                    process.stdin.close()
            except BrokenPipeError:
                pass
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait()

    def __enter__(self) -> "Fabric":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- framing -------------------------------------------------------------

    def _call(self, op: str, **fields: Any) -> Any:
        slot = _Slot()
        with self._lock:
            if self._ended_error is not None:
                raise self._error_for(op)
            request_id = next(self._ids)
            self._pending[request_id] = slot
        request = {"id": request_id, "op": op}
        request.update((k, v) for k, v in fields.items() if v is not None)
        line = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
        try:
            with self._write_lock:
                assert self._process.stdin is not None
                self._process.stdin.write(line.encode("utf-8") + b"\n")
                self._process.stdin.flush()
        except (BrokenPipeError, ValueError):
            with self._lock:
                self._pending.pop(request_id, None)
            self._reader.join()
            raise self._error_for(op) from None
        slot.done.wait()
        response = slot.response
        if response is None:
            raise self._error_for(op)
        if response.get("ok"):
            return response["result"]
        error = response.get("error") or {}
        raise FabricError(int(error.get("code", 1)), str(error.get("message", "request failed")), op)

    def _pump(self) -> None:
        """Delivers each response line to the request with the same id."""
        assert self._process.stdout is not None
        try:
            for line in self._process.stdout:
                response = json.loads(line)
                with self._lock:
                    slot = self._pending.pop(response.get("id"), None) if isinstance(response.get("id"), int) else None
                if slot is not None:
                    slot.response = response
                    slot.done.set()
        finally:
            error = self._ended(None)
            with self._lock:
                self._ended_error = error
                waiting = list(self._pending.values())
                self._pending.clear()
            for slot in waiting:
                slot.done.set()

    def _error_for(self, op: Optional[str]) -> FabricError:
        ended = self._ended_error or self._ended(None)
        return FabricError(ended.code, ended.message, op)

    def _read_line(self, op: Optional[str] = None) -> Json:
        assert self._process.stdout is not None
        line = self._process.stdout.readline()
        if not line:
            raise self._ended(op)
        return json.loads(line)

    def _ended(self, op: Optional[str]) -> FabricError:
        code = self._process.wait()
        stderr = self._process.stderr.read().decode("utf-8", "replace").strip() if self._process.stderr else ""
        return FabricError(code or 1, stderr or f"serve exited with code {code}", op)
