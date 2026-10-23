"""Bend's code generation on Modal, clang here.

Bend spends most of a native build turning a program into C: single-threaded,
minutes long and up to ~12 GB for jev-fabric. The C it emits is the same on
every platform, and its binary is `clang -std=c11 -O3 <c> -lpthread -lm` of it.
So each target's C is generated in its own Modal container, all at once, and
compiled by the local clang for the local platform.

    modal run scripts/modal-bend.py --targets "native/main.bend=build/jev-fabric ..."

Needs a Modal account (`modal setup`). Uploads the Git-tracked files under
native/ and examples/ (the sources, nothing else) and nothing is kept remotely.
Behind an HTTP proxy Modal's client needs `python-socks`; set
MODAL_DISABLE_API_PROXY=1 to connect directly instead.
"""

import io
import os
import subprocess
import sys
import tarfile
import time
import zlib
from concurrent.futures import ThreadPoolExecutor

import modal

BEND = "2.0.38"
# https://github.com/bendlang/bend/releases/tag/v2.0.38, as in scripts/setup-bend-ci.sh
BEND_SHA256 = "f19d088b079c9e1a8834ecd153b7d58c11a5f8f9ab1bdb78dbc96a6bf49aaa81"
ARCHIVE = f"https://github.com/bendlang/bend/releases/download/v{BEND}/bend-{BEND}-linux-x64.tar.gz"

image = (
    modal.Image.debian_slim()
    .apt_install("curl", "ca-certificates")
    .run_commands(
        f"curl --proto '=https' --tlsv1.2 -fsSL {ARCHIVE} -o /tmp/bend.tar.gz",
        f"echo '{BEND_SHA256}  /tmp/bend.tar.gz' | sha256sum -c -",
        "mkdir -p /opt && tar -xzf /tmp/bend.tar.gz -C /opt && rm /tmp/bend.tar.gz",
        f"test \"$(/opt/bend/bin/bend version)\" = 'bend {BEND}'",
    )
    .env({"BEND_NO_TELEMETRY": "1", "PATH": "/opt/bend/bin:/usr/local/bin:/usr/bin:/bin"})
)

app = modal.App("jev-fabric-bend", image=image)


@app.function(scaledown_window=2, cpu=4, memory=16384, timeout=1800, retries=0)
def emit(sources: bytes, target: str) -> tuple[str, bytes, float, str]:
    """The C for one target, zlib-compressed, with Bend's time and output."""
    import tempfile

    work = tempfile.mkdtemp()
    with tarfile.open(fileobj=io.BytesIO(sources)) as tar:
        tar.extractall(work, filter="data")
    started = time.monotonic()
    out = os.path.join(work, "out.c")
    run = subprocess.run(["bend", target, "-o", out], cwd=work, capture_output=True, text=True)
    elapsed = time.monotonic() - started
    log = (run.stdout + run.stderr)[-20000:]
    if run.returncode != 0:
        return target, b"", elapsed, log
    with open(out, "rb") as f:
        return target, zlib.compress(f.read(), 6), elapsed, log


def tracked_sources() -> bytes:
    files = subprocess.run(
        ["git", "ls-files", "-z", "--", "native", "examples"], capture_output=True, check=True
    ).stdout.decode().split("\0")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path in filter(None, files):
            tar.add(path, recursive=False)
    return buf.getvalue()


def clang(c_path: str, out: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["clang", "-std=c11", "-O3", c_path, "-o", out, "-lpthread", "-lm"], capture_output=True, text=True
    )


@app.local_entrypoint()
def main(targets: str, c_dir: str = "build/modal-c"):
    pairs = [t.split("=", 1) for t in targets.split()]
    if not pairs or any(len(p) != 2 or not p[0].endswith(".bend") for p in pairs):
        sys.exit("--targets takes space-separated <file.bend>=<binary> pairs")
    os.makedirs(c_dir, exist_ok=True)
    sources = tracked_sources()
    print(f"Bend {BEND} on Modal: {len(pairs)} target(s), {len(sources) // 1024} KiB of sources")
    started = time.monotonic()
    failed = []

    outputs = dict(pairs)

    def finish(result):
        src, compressed, bend_s, log = result
        out = outputs[src]
        if not compressed:
            failed.append(src)
            print(f"\nFAILED {src} on Modal after {bend_s:.0f}s:\n{log}", file=sys.stderr)
            return
        c_path = os.path.join(c_dir, os.path.basename(out) + ".c")
        with open(c_path, "wb") as f:
            f.write(zlib.decompress(compressed))
        t = time.monotonic()
        done = clang(c_path, out)
        if done.returncode != 0:
            failed.append(src)
            print(f"\nFAILED {src}: clang\n{done.stderr[-4000:]}", file=sys.stderr)
            return
        print(f"Built {out}: Bend {bend_s:.0f}s on Modal, clang {time.monotonic() - t:.0f}s here")

    # Remote calls run concurrently; each result is compiled here as it arrives.
    with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) // 2)) as pool:
        futures = []
        for result in emit.starmap([(sources, src) for src, _ in pairs], order_outputs=False):
            futures.append(pool.submit(finish, result))
        for f in futures:
            f.result()
    print(f"{len(pairs) - len(failed)}/{len(pairs)} built in {time.monotonic() - started:.0f}s")
    if failed:
        sys.exit(1)
