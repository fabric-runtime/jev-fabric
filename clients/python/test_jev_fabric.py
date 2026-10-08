"""Offline tests for the Python serve client.

    JEV_FABRIC_BIN=build/jev-fabric python3 clients/python/test_jev_fabric.py

native/tests/clients.test.ts runs this file as part of the native suite.
"""

import os
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jev_fabric import Fabric, FabricError  # noqa: E402

REQUEST = {
    "state": "synthetic",
    "questions": {"ok": {"type": "noul", "instructions": "Is two plus two four?"}},
}


class FabricTest(unittest.TestCase):
    def setUp(self):
        # Job storage refuses symlinked paths, such as macOS's /var -> /private/var.
        parent = os.environ.get("JEV_FABRIC_TEST_TMP") or os.path.realpath(tempfile.gettempdir())
        self.home = tempfile.mkdtemp(prefix="jev-fabric-py-", dir=parent)
        self.env = {"PATH": os.environ["PATH"], "JEV_FABRIC_HOME": self.home}

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def open(self, **options):
        return Fabric(env=self.env, **options)

    def test_ready_reports_session_budgets(self):
        with self.open(timeout_ms=60000, max_evaluations=4, max_tokens=900) as fabric:
            self.assertEqual(fabric.ready["protocol"], 2)
            self.assertEqual(fabric.ready["store"], 1)
            self.assertIn("sessions", fabric.ready["features"])
            self.assertEqual(fabric.capabilities()["features"], fabric.ready["features"])
            self.assertEqual(fabric.ready["timeoutMs"], 60000)
            self.assertEqual(fabric.ready["maxEvaluations"], 4)
            self.assertEqual(fabric.ready["maxTokens"], 900)
        with self.open(max_tokens=10) as fabric:
            self.assertEqual(fabric.ready["maxEvaluations"], 1)

    def test_exec_receipts_and_errors(self):
        with self.open() as fabric:
            self.assertEqual(fabric.exec(["/bin/echo", "hi"])["stdout"], "hi\n")
            self.assertEqual(fabric.exec(["/bin/cat"], stdin="é\n")["stdout"], "é\n")
            failed = fabric.exec(["/bin/sh", "-c", "exit 3"])
            self.assertEqual((failed["state"], failed["exitCode"]), ("failed", 3))
            with self.assertRaises(FabricError) as caught:
                fabric.exec([])
            self.assertEqual(caught.exception.code, 2)
            self.assertEqual(caught.exception.op, "exec")
            self.assertEqual(fabric.exec(["/bin/echo", "after"])["stdout"], "after\n")
        self.assertEqual(fabric.close(), 0)

    def test_jobs(self):
        with self.open() as fabric:
            job = fabric.start(["/bin/sh", "-c", "sleep 0.2; echo ready; sleep 0.2"])
            records = fabric.watch(job, "ready", timeout_ms=5000)
            lines = [line["text"] for r in records if r["type"] == "monitor.batch" for line in r["lines"]]
            self.assertEqual(lines, ["ready"])
            self.assertEqual(fabric.wait(job, timeout_ms=5000)["state"], "exited")
            self.assertEqual(fabric.status(job)["stdout"], "ready\n")
            self.assertTrue(all("sequence" in e for e in fabric.events(job)))
            self.assertEqual(fabric.stop(job)["state"], "exited")

    def test_labels_long_poll_and_list(self):
        with self.open() as fabric:
            job = fabric.start(["/bin/sh", "-c", "sleep 0.3; echo later"], label="py job", timeout_ms=86400000)
            cursor = fabric.events(job)[-1]["sequence"]
            later = fabric.events(job, after=cursor, wait_ms=20000)
            self.assertTrue(later)
            self.assertTrue(all(e["sequence"] > cursor for e in later))
            receipt = fabric.wait(job, timeout_ms=5000)
            self.assertEqual((receipt["label"], receipt["state"]), ("py job", "exited"))
            listing = fabric.list()
            self.assertFalse(listing["truncated"])
            entry = next(j for j in listing["jobs"] if j["id"] == job)
            self.assertEqual((entry["state"], entry["label"], entry["exitCode"]), ("exited", "py job", 0))
            with self.assertRaises(FabricError) as caught:
                fabric.start(["/bin/echo"], label="x" * 121)
            self.assertEqual(caught.exception.code, 2)

    def test_validate_and_jev_budget(self):
        with self.open(max_evaluations=0) as fabric:
            self.assertEqual(fabric.validate(REQUEST), REQUEST)
            with self.assertRaises(FabricError) as caught:
                fabric.validate({"state": "x", "questions": {}})
            self.assertEqual(caught.exception.code, 22)
            with self.assertRaises(FabricError) as caught:
                fabric.jev(REQUEST)
            self.assertEqual(caught.exception.message, "Jev budget exhausted")

    def test_decision_discovery_validation_and_budget(self):
        request = {"state": {"evidence": "hello"}, "questions": {
            "q": {"type": "boolean", "instructions": "Is this greeting?"}
        }}
        with self.open(max_evaluations=0) as fabric:
            self.assertIn("decisions", fabric.ready["features"])
            providers = fabric.decision_providers()
            self.assertTrue(any(p["provider"] == "openai" for p in providers))
            self.assertEqual(fabric.validate_decision(request), request)
            with self.assertRaises(FabricError) as caught:
                fabric.decide(request)
            self.assertEqual(caught.exception.message, "decision budget exhausted")

    def test_threads_share_one_session(self):
        results = []
        with self.open() as fabric:
            def run(n):
                results.append(fabric.exec(["/bin/echo", str(n)])["stdout"])
            threads = [threading.Thread(target=run, args=(n,)) for n in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(sorted(results), ["0\n", "1\n", "2\n", "3\n"])

    def test_session_children(self):
        with self.open() as fabric:
            child = fabric.spawn(["/bin/cat"], label="echo")
            job = child["id"]
            self.assertTrue(job.startswith("s-"))
            self.assertEqual((child["lifetime"], child["state"]), ("session", "running"))
            # A long poll waits in its own thread while this one writes.
            box = {}
            reader = threading.Thread(target=lambda: box.update(read=fabric.read(job, "stdout", wait_ms=20000)))
            reader.start()
            time.sleep(0.2)
            self.assertEqual(fabric.write(job, "héllo\n"), {"id": job, "written": 7, "closed": False})
            reader.join()
            self.assertEqual(box["read"]["text"], "héllo\n")
            self.assertEqual(box["read"]["next"], 7)
            raw = fabric.read(job, "stdout", encoding="base64")
            self.assertEqual(raw["data"], "aMOpbGxvCg==")
            self.assertEqual(fabric.list(scope="session")["jobs"][0]["id"], job)
            self.assertTrue(fabric.close_input(job)["closed"])
            self.assertEqual(fabric.wait(job, timeout_ms=5000)["state"], "exited")
            with self.assertRaises(FabricError) as caught:
                fabric.write(job, "late")
            self.assertEqual(caught.exception.code, 1)
            sleeper = fabric.spawn(["/bin/sleep", "30"])["id"]
        # Ending the session stopped the child it spawned.
        self.assertEqual(fabric.close(), 0)
        self.assertTrue(sleeper.startswith("s-"))

    def test_durable_interactive_job(self):
        with self.open() as fabric:
            job = fabric.start(["/bin/cat"], input="pipe")
            self.assertEqual(fabric.write(job, "queued\n"), {"id": job, "written": 7, "closed": False})
            self.assertEqual(fabric.read(job, "stdout", wait_ms=5000)["text"], "queued\n")
            self.assertTrue(fabric.close_input(job)["closed"])
            self.assertEqual(fabric.wait(job, timeout_ms=5000)["state"], "exited")

    def test_startup_failure_raises(self):
        with self.assertRaises(FabricError) as caught:
            Fabric(env=self.env, timeout_ms=0)
        self.assertEqual(caught.exception.code, 2)
        with self.assertRaises(FileNotFoundError):
            Fabric(env=self.env, binary=os.path.join(self.home, "missing"))

    def test_session_end_is_reported(self):
        # Less than the two-second receipt grace remains, so no request can run.
        fabric = self.open(timeout_ms=2100)
        time.sleep(0.2)
        with self.assertRaises(FabricError) as caught:
            fabric.exec(["/bin/echo", "late"])
        self.assertEqual(caught.exception.code, 124)
        with self.assertRaises(FabricError) as caught:
            fabric.exec(["/bin/echo", "ended"])
        self.assertEqual(caught.exception.code, 124)
        self.assertIn("serve deadline expired", caught.exception.message)
        self.assertEqual(fabric.close(), 124)


# A deterministic protocol peer, not a provider simulator: no network or credentials.
# Also used by native/tests/decision-target-clients.test.ts.
FAKE_DECISION_PEER = r'''
import json, os, sys, time
features = ["decisions"] + ([] if os.environ.get("OLD_PEER") else ["decision-targets"])
args = sys.argv[3:]
if args[:1] == ["--timeout-ms"]:
    args = args[2:]
remaining = int(args[0]) if args else 2
ready = dict(protocol=2, version="fake", store=1, platform="fake", features=features,
             timeoutMs=60000, maxEvaluations=remaining, maxTokens=100000)
print(json.dumps({"ready": ready}), flush=True)
counts = dict(profileResolves=0, resolves=0, dispatches=0)
preflight = None
for line in sys.stdin:
    wire = json.loads(line)
    op = wire["op"]
    request = wire.get("request", {})
    result = {"wire": wire, "pid": os.getpid(), "remaining": remaining}
    if op == "resolveDecision":
        counts["resolves"] += 1
        target = dict(provider="fixture", api="system-one", model="fixture",
                      endpoint="https://fixture.invalid", allowLocal=False, allowGenerated=False)
        if "profile" in request:
            counts["profileResolves"] += 1
            preflight = wire
            time.sleep(0.03)  # Leave concurrent first-use callers waiting on binding.
            path = os.environ.get("DECISION_PROFILES_FILE")
            if path and os.path.isfile(path):
                with open(path) as source:
                    target = json.load(source)["profiles"][request["profile"]]
            elif os.environ.get("ROTATE_PROFILE"):
                target["model"] = "revision-" + str(counts["profileResolves"])
            if counts["profileResolves"] == 1 and os.environ.get("BAD_TARGET_ONCE"):
                target = json.loads(os.environ["BAD_TARGET_ONCE"])
            result["profile"] = request["profile"]
        else:
            target.update({k: v for k, v in request.items() if k not in ("state", "questions", "images")})
        if not request.get("questions"):
            print(json.dumps({"id": wire["id"], "ok": False,
                              "error": {"code": 22, "message": "invalid evidence"}}), flush=True)
            continue
        result.update(target=target, credential={"env": "FIXTURE_API_KEY", "resolved": False},
                      imageSupport="unsupported", generated=False)
    if op == "capabilities":
        result.update(counts=counts, preflight=preflight)
        result.update(env={key: os.environ.get(key) for key in
                          ["DECISION_PROFILES", "DECISION_PROFILES_FILE", "ENV_SENTINEL", "ONLY_CHILD"]},
                      argv=sys.argv[1:])
    if op in ("decide", "jev"):
        if remaining <= 0:
            print(json.dumps({"id": wire["id"], "ok": False,
                              "error": {"code": 22, "message": "shared budget exhausted"}}), flush=True)
            continue
        remaining -= 1
        counts["dispatches"] += 1
        failure = os.environ.get("FAIL_DISPATCH_ONCE") if counts["dispatches"] == 1 else None
        if failure == "throw":
            print(json.dumps({"id": wire["id"], "ok": False,
                              "error": {"code": 1, "message": "model dispatch failed"}}), flush=True)
            continue
        result.update(status="error" if failure else "ok", remaining=remaining)
    print(json.dumps({"id": wire["id"], "ok": True, "result": result}), flush=True)
'''


FAKE_TARGET = dict(provider="fixture", api="system-one", model="fixture", endpoint="https://fixture.invalid",
                   allowLocal=False, allowGenerated=False)
FULL_TARGET = dict(FAKE_TARGET, model="initial", endpoint="http://127.0.0.1:1234/decisions",
                   allowLocal=True, allowGenerated=True, temperature=0.5,
                   providerOptions={"gateway": {"models": ["initial"]}})


class DecisionTargetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="decision-client-")
        self.binary = os.path.join(self.tmp.name, "peer")
        with open(self.binary, "w") as f:
            f.write("#!" + sys.executable + "\n" + FAKE_DECISION_PEER)
        os.chmod(self.binary, 0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def open(self, **kwargs):
        fabric = Fabric(binary=self.binary, **kwargs)
        def cleanup():
            fabric.close()
            fabric._reader.join()
            fabric._process.stdout.close()
            fabric._process.stderr.close()
        self.addCleanup(cleanup)
        return fabric

    def test_resolution_wire_and_public_types(self):
        from jev_fabric import DecisionTarget, DecisionProfiles, DecisionResolution, DecisionTargetView
        self.assertTrue(all([DecisionTarget, DecisionProfiles, DecisionResolution, DecisionTargetView]))
        with self.open(max_evaluations=0) as f:
            req = dict(REQUEST, profile="work")
            resolution = f.resolve_decision(req)
            self.assertEqual(resolution["wire"], {"id": 1, "op": "resolveDecision", "request": req})
            self.assertEqual(resolution["credential"], {"env": "FIXTURE_API_KEY", "resolved": False})
            self.assertEqual(resolution["profile"], "work")
            self.assertEqual(f.validate_decision(req)["wire"]["request"], req)
            with self.assertRaisesRegex(FabricError, "shared budget"):
                f.decide(req)

    def test_view_snapshot_and_shared_budget(self):
        target = {"provider": "fixture", "providerOptions": {"gateway": {"models": ["original"]}}}
        with self.open(max_evaluations=2, max_tokens=50) as f:
            view = f.with_decision_target(target)
            target["providerOptions"]["gateway"]["models"][0] = "mutated"
            self.assertEqual(view.target["providerOptions"]["gateway"]["models"], ("original",))
            with self.assertRaises(TypeError):
                view.target["provider"] = "mutated"
            with self.assertRaises(TypeError):
                view.target["providerOptions"]["gateway"]["models"][0] = "mutated"
            with self.assertRaises(AttributeError):
                view.target = "mutated"
            self.assertFalse(hasattr(view, "close"))
            self.assertFalse(hasattr(view, "open"))
            resolved = view.resolve_decision(REQUEST)
            first = view.decide(REQUEST, timeout_ms=321, credential="one-shot-sentinel")
            self.assertEqual(first["wire"]["request"]["providerOptions"]["gateway"]["models"], ["original"])
            self.assertEqual(first["wire"]["timeoutMs"], 321)
            self.assertEqual(first["wire"]["credential"], "one-shot-sentinel")
            profile = f.with_decision_target("team.v1")
            self.assertEqual(profile.target, "team.v1")
            second = profile.decide(REQUEST)
            self.assertEqual(second["wire"]["request"], dict(REQUEST, **FAKE_TARGET))
            self.assertNotIn("credential", second["wire"])
            self.assertNotIn("one-shot-sentinel", repr(view.target))
            self.assertEqual(first["pid"], resolved["pid"])
            self.assertEqual(first["pid"], second["pid"])
            with self.assertRaisesRegex(FabricError, "shared budget"):
                f.jev(REQUEST)
            # View disposal does not close its parent, nor does resolution spend budget.
            del view
            self.assertEqual(f.resolve_decision(REQUEST)["pid"], first["pid"])
        with self.assertRaises(FabricError):
            profile.decide(REQUEST)

    def test_named_resolution_freezes_full_target_without_retaining_call_data(self):
        path = os.path.join(self.tmp.name, "profiles.json")
        def save(target):
            with open(path, "w") as source:
                json.dump({"version": 1, "profiles": {"vision": target}}, source)
        save(FULL_TARGET)
        with self.open(env={"DECISION_PROFILES_FILE": path}, max_evaluations=2) as f:
            view = f.with_decision_target("vision")
            self.assertEqual(f.capabilities()["counts"], dict(profileResolves=0, resolves=0, dispatches=0))
            first = view.resolve_decision(REQUEST)
            self.assertEqual(first["target"], FULL_TARGET)
            self.assertEqual(first["profile"], "vision")
            first["target"]["model"] = "caller-mutated"
            first["target"]["providerOptions"]["gateway"]["models"][0] = "caller-mutated"
            save(dict(FAKE_TARGET, provider="changed", model="changed"))
            fresh = dict(REQUEST, state="fresh-evidence", images=[{"data": "fixture-image", "mimeType": "image/png"}])
            second = view.resolve_decision(fresh)
            self.assertEqual(second["wire"]["request"], dict(fresh, **FULL_TARGET))
            self.assertEqual(second["target"], FULL_TARGET)
            one = view.decide(fresh, timeout_ms=321, credential="ephemeral-secret")
            two = view.decide(REQUEST)
            self.assertEqual(one["wire"]["request"], dict(fresh, **FULL_TARGET))
            self.assertEqual(one["wire"]["timeoutMs"], 321)
            self.assertEqual(one["wire"]["credential"], "ephemeral-secret")
            self.assertEqual(two["wire"]["request"], dict(REQUEST, **FULL_TARGET))
            self.assertNotIn("credential", two["wire"])
            self.assertNotIn("timeoutMs", two["wire"])
            self.assertEqual(view.target, "vision")
            cached = view._DecisionTargetView__resolved
            self.assertEqual(set(cached), set(FULL_TARGET))
            with self.assertRaises(TypeError):
                cached["providerOptions"]["gateway"]["models"][0] = "mutate"
            c = f.capabilities()
            self.assertEqual(c["counts"], dict(profileResolves=1, resolves=2, dispatches=2))
            self.assertEqual(c["preflight"]["request"], dict(REQUEST, profile="vision"))
            self.assertNotIn("credential", c["preflight"])
            self.assertEqual([one["pid"], two["pid"], second["pid"]], [c["pid"]] * 3)
            self.assertEqual(c["remaining"], 0)
            with self.assertRaisesRegex(FabricError, "shared budget"):
                f.jev(REQUEST)

    def test_named_concurrent_first_use_binds_once(self):
        with self.open(env={"ROTATE_PROFILE": "1"}, max_evaluations=4) as f:
            view = f.with_decision_target("vision")
            inputs = [dict(REQUEST, state="evidence-" + str(i), images=[{"data": "fixture-image", "mimeType": "image/png"}]) for i in range(4)]
            barrier = threading.Barrier(4)
            def decide(evidence):
                barrier.wait(timeout=5)
                return view.decide(evidence)
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(decide, inputs))
            for result, evidence in zip(results, inputs):
                self.assertEqual(result["wire"]["request"], dict(evidence, **dict(FAKE_TARGET, model="revision-1")))
            c = f.capabilities()
            self.assertEqual(c["counts"], dict(profileResolves=1, resolves=1, dispatches=4))
            self.assertIn(c["preflight"]["request"], [dict(e, profile="vision") for e in inputs])
            self.assertTrue(all(r["pid"] == c["pid"] for r in results))
            self.assertEqual(c["remaining"], 0)
            with self.assertRaisesRegex(FabricError, "shared budget"):
                view.decide(REQUEST)

    def test_named_failed_preflight_retries_without_dispatch(self):
        invalid = [None, {"provider": "fixture"}, dict(FAKE_TARGET, api=""),
                   dict(FAKE_TARGET, api="unknown"), dict(FAKE_TARGET, allowLocal=1),
                   dict(FAKE_TARGET, providerOptions={"nested": {"api_key": "DO_NOT_CACHE"}}),
                   dict(FAKE_TARGET, endpoint="https://user:DO_NOT_CACHE@fixture.invalid")]
        for bad in ["evidence"] + invalid:
            env = {"ROTATE_PROFILE": "1"}
            if bad != "evidence":
                env["BAD_TARGET_ONCE"] = json.dumps(bad)
            with self.subTest(bad=bad), self.open(env=env, max_evaluations=1) as f:
                view = f.with_decision_target("vision")
                with self.assertRaises((FabricError, ValueError)):
                    view.decide(dict(REQUEST, questions={}) if bad == "evidence" else REQUEST, credential="not-for-preflight")
                before = f.capabilities()
                self.assertEqual(before["counts"], dict(profileResolves=1, resolves=1, dispatches=0))
                self.assertEqual(before["remaining"], 1)
                self.assertNotIn("credential", before["preflight"])
                self.assertIsNone(view._DecisionTargetView__resolved)
                success = view.decide(REQUEST)
                self.assertEqual(success["wire"]["request"], dict(REQUEST, **dict(FAKE_TARGET, model="revision-2")))
                self.assertNotIn("credential", success["wire"])
                self.assertEqual(f.capabilities()["counts"], dict(profileResolves=2, resolves=2, dispatches=1))

    def test_named_failed_dispatch_never_rebinds(self):
        for failure in ["throw", "status"]:
            with self.subTest(failure=failure), self.open(env={"ROTATE_PROFILE": "1", "FAIL_DISPATCH_ONCE": failure}, max_evaluations=2) as f:
                view = f.with_decision_target("vision")
                if failure == "throw":
                    with self.assertRaisesRegex(FabricError, "model dispatch failed"):
                        view.decide(REQUEST, credential="failed-call-only")
                else:
                    self.assertEqual(view.decide(REQUEST, credential="failed-call-only")["status"], "error")
                second = view.decide(dict(REQUEST, state="retry"))
                self.assertEqual(second["wire"]["request"], dict(REQUEST, **dict(FAKE_TARGET, model="revision-1"), state="retry"))
                self.assertNotIn("credential", second["wire"])
                self.assertEqual(second["remaining"], 0)
                self.assertEqual(f.capabilities()["counts"], dict(profileResolves=1, resolves=1, dispatches=2))

    def test_views_refuse_all_routing_and_extra_evidence(self):
        with self.open() as f:
            view = f.with_decision_target("work")
            for key in ["profile", "provider", "api", "model", "endpoint", "allowLocal", "allowGenerated", "providerOptions", "temperature", "credential", "extra"]:
                for call in [view.decide, view.resolve_decision]:
                    with self.subTest(key=key, call=call.__name__), self.assertRaises(ValueError):
                        call(dict(REQUEST, **{key: None}))
            self.assertEqual(f.resolve_decision(REQUEST)["wire"]["id"], 1)

    def test_startup_snapshot_and_environment_replacement(self):
        doc = {"version": 1, "defaultProfile": "work", "profiles": {"work": {"provider": "fixture"}}}
        env = {"ONLY_CHILD": "yes", "DECISION_PROFILES": "overridden", "DECISION_PROFILES_FILE": "untouched"}
        with patch.dict(os.environ, {"ENV_SENTINEL": "ambient"}):
            with self.open(env=env, decision_profiles=doc, max_evaluations=0) as f:
                doc["profiles"]["work"]["provider"] = "changed"
                c = f.capabilities()
                self.assertEqual(json.loads(c["env"]["DECISION_PROFILES"])["profiles"]["work"]["provider"], "fixture")
                self.assertIsNone(c["env"]["ENV_SENTINEL"])
                self.assertEqual(c["env"]["ONLY_CHILD"], "yes")
                self.assertEqual(c["env"]["DECISION_PROFILES_FILE"], "untouched")
                self.assertNotIn("DECISION_PROFILES", " ".join(c["argv"]))
            self.assertEqual(env["DECISION_PROFILES"], "overridden")
            with self.open(env={"ONLY_CHILD": "yes"}) as f:
                self.assertIsNone(f.capabilities()["env"]["ENV_SENTINEL"])
            with self.open() as f:
                self.assertEqual(f.capabilities()["env"]["ENV_SENTINEL"], "ambient")
            with self.open(decision_profiles=doc) as f:
                self.assertEqual(f.capabilities()["env"]["ENV_SENTINEL"], "ambient")

    def test_strict_configuration_before_spawn(self):
        bad_targets = [None, {}, {"provider": ""}, {"provider": "x", "allowLocal": 1},
                       {"provider": "x", "temperature": float("nan")}, {"provider": "x", "temperature": True},
                       {"provider": "x", "providerOptions": []},
                       {"provider": "x", "providerOptions": {"nested": {"api_key": "DO_NOT_ECHO"}}},
                       {"provider": "x", "providerOptions": {"n": float("inf")}},
                       {"provider": "x", "endpoint": "https://user:DO_NOT_ECHO@fixture.invalid"},
                       {"provider": "x", "endpoint": "https://fixture.invalid?token=DO_NOT_ECHO"}]
        bad_targets += [{"provider": "x", k: "DO_NOT_ECHO"} for k in ["unknown", "state", "questions", "images", "credential", "profile"]]
        bad_docs = [{}, {"version": True, "profiles": {}}, {"version": 2, "profiles": {}},
                    {"version": 1, "profiles": {}, "extra": 1}, {"version": 1, "profiles": []},
                    {"version": 1, "profiles": {}, "defaultProfile": "missing"},
                    {"version": 1, "profiles": {str(i): {"provider": "x"} for i in range(129)}},
                    {"version": 1, "profiles": {"x": {"provider": "x", "model": "é" * 40000}}}]
        bad_docs += [{"version": 1, "profiles": {name: {"provider": "x"}}} for name in ["", "a/b", "é", "x\n", "x" * 129, "__proto__", "prototype", "constructor"]]
        bad_docs += [{"version": 1, "profiles": {"x": target}} for target in bad_targets]
        for doc in bad_docs:
            with self.subTest(doc=str(doc)[:100]), self.assertRaises(ValueError) as caught:
                Fabric(binary="/nonexistent/no-spawn", decision_profiles=doc)
            self.assertNotIn("DO_NOT_ECHO", str(caught.exception))
        with self.open() as f:
            for target in bad_targets + ["", "é", "x" * 129]:
                with self.assertRaises(ValueError):
                    f.with_decision_target(target)
            for name in ["__proto__", "prototype", "constructor"]:
                with self.assertRaises(ValueError):
                    f.with_decision_target(name)
                for call in [f.decide, f.validate_decision, f.resolve_decision]:
                    with self.assertRaises(ValueError):
                        call(dict(REQUEST, profile=name))
            cyclic = {"provider": "x", "providerOptions": {}}
            cyclic["providerOptions"]["loop"] = cyclic
            with self.assertRaises(ValueError):
                f.with_decision_target(cyclic)
        for name in ["__proto__", "prototype", "constructor", "toString"]:
            with self.assertRaises(ValueError):
                Fabric(binary="/nonexistent/no-spawn", decision_profiles={"version": 1, "profiles": {}, "defaultProfile": name})
        boundary = {"version": 1, "profiles": {"x": {"provider": "x", "providerOptions": {"padding": ""}}}}
        boundary["profiles"]["x"]["providerOptions"]["padding"] = "m" * (65536 - len(json.dumps(boundary, separators=(",", ":")).encode()))
        with self.open(decision_profiles=boundary):
            pass
        boundary["profiles"]["x"]["providerOptions"]["padding"] += "m"
        with self.assertRaises(ValueError):
            Fabric(binary="/nonexistent/no-spawn", decision_profiles=boundary)
        # All 128 safe ASCII names and the full length are valid; secret-like names are names, not fields.
        doc = {"version": 1, "profiles": {str(i): {"provider": "x"} for i in range(126)}}
        doc["profiles"].update({"secret": {"provider": "x"}, "x" * 128: {"provider": "x"}})
        with self.open(decision_profiles=doc):
            pass

    def test_old_binary_feature_gates_only_new_usage(self):
        with self.open(env={"OLD_PEER": "1"}, max_evaluations=2) as f:
            f.decide(dict(REQUEST, provider="openai"))
            f.validate_decision(REQUEST)
            for call in [lambda: f.resolve_decision(REQUEST), lambda: f.with_decision_target("work"),
                         lambda: f.with_decision_target({"provider": "openai"}),
                         lambda: f.decide(dict(REQUEST, profile="work")),
                         lambda: f.validate_decision(dict(REQUEST, profile="work"))]:
                with self.assertRaisesRegex(FabricError, "decision-targets.*update"):
                    call()
            self.assertEqual(f.capabilities()["wire"]["id"], 3)
        with self.assertRaisesRegex(FabricError, "decision-targets.*update"):
            self.open(env={"OLD_PEER": "1"}, decision_profiles={"version": 1, "profiles": {}})


if __name__ == "__main__":
    unittest.main()
