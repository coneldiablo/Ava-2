#!/usr/bin/env python3
"""Opt-in isolated Local-channel ARI/AudioSocket gate. Never loads SIP modules.

Run on the AVA host with Python3.11+, docker and Asterisk22. No production
configuration, directories, channels or containers are changed. Only --run
creates resources and performs a metered synthetic Yandex session.
The single caller-classification shim is disclosed in the receipt: this is
media/engine acceptance, NOT SIP INVITE acceptance or production CRM acceptance.
"""
import argparse
import array
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import wave

MODULES = ["res_timing_timerfd", "codec_ulaw", "codec_resample", "format_pcm", "format_sln", "format_wav",
           "bridge_simple", "bridge_softmix", "pbx_config", "res_sorcery_config", "res_sorcery_memory",
           "res_http_websocket", "res_websocket_client", "res_stasis",
           "res_stasis_answer", "res_stasis_playback", "res_stasis_recording", "res_stasis_snoop",
           "res_ari", "res_ari_model", "res_ari_asterisk", "res_ari_events", "res_ari_channels", "res_ari_bridges",
           "res_ari_playbacks", "res_ari_recordings", "res_ari_applications", "app_stasis", "app_playback",
           "app_mixmonitor", "res_audiosocket", "chan_audiosocket", "app_audiosocket"]
PORTS = {"ari": 16888, "audio": 19090, "health": 15999, "crm": 15998}


def private_write(path, text):
    path.write_text(text)
    path.chmod(0o600)


def command(argv, timeout=20):
    result = subprocess.run(argv, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("command_failed:" + Path(argv[0]).name)
    return result.stdout


def request(url, user=None, password=None, body=None):
    headers = {"Content-Type": "application/json"}
    if user:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    req = Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urlopen(req, timeout=3) as response:
        return json.load(response)


def until(check, timeout, label):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, HTTPError, ValueError, sqlite3.Error):
            pass
        time.sleep(0.25)
    raise RuntimeError("timeout:" + label)


def fixture_8k(source, output):
    with wave.open(str(source), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getcomptype()) != (1, 2, "NONE"):
            raise ValueError("synthetic WAV must be mono PCM16")
        rate, count = wav.getframerate(), wav.getnframes()
        if not 1 <= count / rate <= 20:
            raise ValueError("synthetic WAV must be 1..20 seconds")
        pcm = array.array("h", wav.readframes(count))
    import sys
    if sys.byteorder != "little":
        pcm.byteswap()
    # Linear interpolation sufficient for the synthetic fixture, no external API.
    out = array.array("h")
    for index in range(int(len(pcm) * 8000 / rate)):
        position = index * rate / 8000
        left = int(position)
        right = min(left + 1, len(pcm) - 1)
        out.append(round(pcm[left] * (1-(position-left)) + pcm[right] * (position-left)))
    if sys.byteorder != "little":
        out.byteswap()
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(out.tobytes())
    output.chmod(0o600)


def production_fingerprint():
    engine = json.loads(command(["docker", "inspect", "ai_engine", "--format", '{{json .}}']))
    return {"container_id": engine["Id"], "image_id": engine["Image"],
            "started_at": engine["State"]["StartedAt"], "restart_count": engine["RestartCount"]}


def production_channels(asterisk):
    import re
    output = command([asterisk, "-rx", "core show channels count"]).decode()
    found = re.search(r"(\d+) active channels", output)
    if not found:
        raise RuntimeError("production_channel_count_unavailable")
    return int(found.group(1))


def build_config(model="speech-realtime-max-tts-live/latest"):
    prompt = ("Ты изолированный тестовый ассистент. Никаких внешних действий или инструментов. "
              "Отвечай по-русски. На любой вопрос дай десять полных предложений о синтетическом тесте, "
              "чтобы проверить прерывание речи. Не называй реальные цены или контакты.")
    return {"asterisk": {"app_name": "yandex-isolated-qa"}, "llm": {"prompt": prompt},
            "default_provider": "yandex_realtime", "audio_transport": "audiosocket", "downstream_mode": "stream",
            "audiosocket": {"host": "127.0.0.1", "advertise_host": "127.0.0.1", "port": PORTS["audio"], "format": "slin"},
            "external_media": {"rtp_host": "127.0.0.1", "rtp_port": 19092, "port_range": "19092:19102"},
            "health": {"host": "127.0.0.1", "port": PORTS["health"]},
            "barge_in": {"enabled": True, "initial_protection_ms": 100, "min_ms": 150, "energy_threshold": 700},
            "streaming": {"sample_rate": 8000, "chunk_size_ms": 20, "greeting_min_start_ms": 40, "min_start_ms": 100},
            "providers": {"yandex_realtime": {"enabled": True, "voice": "sofia", "role": "support",
                "model": model, "instructions": prompt,
                "greeting": "Здравствуйте. Начинаем изолированный тест.", "input_encoding": "pcm16",
                "input_sample_rate_hz": 8000, "provider_input_sample_rate_hz": 24000,
                "output_sample_rate_hz": 24000, "target_encoding": "pcm16", "target_sample_rate_hz": 8000}},
            "contexts": {"yandex_qa": {"provider": "yandex_realtime", "business_id": 900001,
                "prompt": prompt, "greeting": "Здравствуйте. Начинаем изолированный тест.", "tools": [],
                "pre_call_tools": [], "post_call_tools": ["qa_durable_receipt"]}},
            "tools": {"qa_durable_receipt": {"kind": "generic_webhook", "phase": "post_call", "enabled": True,
                "require_ack": True, "timeout_ms": 2000, "url": f"http://127.0.0.1:{PORTS['crm']}/qa/post-call"}},
            "mcp": {"enabled": False}, "logging": {"level": "info"}}


def copy_runtime_assets(asset_root, base):
    # Asterisk22 core Stasis needs XML configuration documentation during
    # initialization. Copy package assets only, never /etc or production data.
    for name in ("documentation", "rest-api"):
        origin = Path(asset_root) / name
        if not origin.is_dir():
            raise ValueError("missing packaged Asterisk runtime assets")
        for directory in (base / "data", base / "lib"):
            shutil.copytree(origin, directory / name)


ENTRY = '''import asyncio, os, signal
from src.engine import Engine
from src.config import load_config
from src.logging_config import configure_logging
class IsolatedEngine(Engine):
    def _is_caller_channel(self, channel):
        return (channel.get("id") == os.environ["QA_ENGINE_CHANNEL_ID"] and
                channel.get("name", "").startswith("Local/fixture@qa-fixture-")) or super()._is_caller_channel(channel)
async def main():
    configure_logging(log_level="INFO")
    engine = IsolatedEngine(load_config("/app/config/ai-agent.yaml"))
    done = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, done.set)
    task = asyncio.create_task(engine.start())
    await done.wait()
    await engine.stop()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
asyncio.run(main())
'''


def run(args):
    source = Path(args.source).resolve()
    src = source / "src" if (source / "src").is_dir() else source
    if not (src / "providers/yandex_realtime.py").is_file():
        raise ValueError("candidate source not found")
    if os.geteuid() != 0:
        raise ValueError("isolated host runner requires root")
    for port in PORTS.values():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))  # fail rather than touch occupied services
    for name in MODULES:
        if not (Path(args.modules) / (name + ".so")).is_file():
            raise ValueError("missing_module:" + name)
    before = production_fingerprint()
    if production_channels(args.asterisk) != 0:
        raise RuntimeError("production_not_idle")
    # Resolve effective image identity without network or credentials; preserve
    # the image's configured user rather than escalating the engine to root.
    image_identity = json.loads(command(["docker", "run", "--rm", "--network", "none", "--entrypoint", "python",
        args.image, "-c", "import os,json;print(json.dumps({'uid':os.getuid(),'gid':os.getgid()}))"], timeout=20))
    image_uid, image_gid = int(image_identity["uid"]), int(image_identity["gid"])
    nonce = secrets.token_hex(6)
    base = Path(args.work_root).resolve() / ("run-" + nonce)
    base.mkdir(mode=0o700, parents=True)
    for directory in ["etc", "run", "spool", "data", "log", "db", "keys", "agi", "lib", "engine-data", "config", "media"]:
        (base / directory).mkdir(mode=0o700)
    copy_runtime_assets(args.asterisk_assets, base)
    fixture_8k(Path(args.wav), base / "data/input.wav")
    password = secrets.token_urlsafe(32)
    cid = "qa-engine-" + nonce
    container = "ava-yandex-isolated-" + nonce
    report = {"scope": "isolated_local_ari_audiosocket", "caller_classifier_shim": "exact synthetic Local channel ID only",
              "sip_verified": False, "production_crm_verified": False, "work_dir": str(base), "passed": False}
    report["production_channels_before"] = 0
    report["isolated_engine_uid"] = image_uid
    report["isolated_engine_gid"] = image_gid
    report["engine_source_sha256"] = hashlib.sha256((src / "engine.py").read_bytes()).hexdigest()
    private_write(base / "config/ai-agent.yaml", json.dumps(build_config(args.model), ensure_ascii=False))
    private_write(base / "entry.py", ENTRY)
    dirs = {"astetcdir": "etc", "astvarlibdir": "lib", "astdbdir": "db", "astkeydir": "keys", "astdatadir": "data",
            "astagidir": "agi", "astspooldir": "spool", "astrundir": "run", "astlogdir": "log"}
    private_write(base / "etc/custom.conf", "[directories]\n" + "\n".join(f"{k} => {base / v}" for k,v in dirs.items()) +
                  f"\nastmoddir => {args.modules}\n[options]\nverbose=3\ndebug=0\nmaxcalls=4\n[files]\nastctl=asterisk.ctl\nastctlpermissions=0600\n")
    private_write(base / "etc/modules.conf", "[modules]\nautoload=no\n" + "\n".join("load=" + n + ".so" for n in MODULES) + "\n")
    private_write(base / "etc/http.conf", f"[general]\nenabled=yes\nbindaddr=127.0.0.1\nbindport={PORTS['ari']}\n")
    private_write(base / "etc/ari.conf", f"[general]\nenabled=yes\npretty=no\n[qa]\ntype=user\nread_only=no\npassword={password}\n")
    private_write(base / "etc/websocket_client.conf", "; No outbound ARI websocket clients in isolated contour.\n")
    private_write(base / "etc/logger.conf", "[general]\n[logfiles]\nconsole => notice,warning,error\nmessages => notice,warning,error,verbose\n")
    private_write(base / "etc/extensions.conf", f"""[general]
static=yes
writeprotect=yes
[qa-fixture]
exten => fixture,1,Answer()
 same => n,MixMonitor({base}/data/mixed.wav,r({base}/data/agent.wav)t({base}/data/fixture.wav))
 same => n,Wait(5)
 same => n,Playback({base}/data/input)
 same => n,Wait(2)
 same => n,Playback({base}/data/input)
 same => n,Wait(18)
 same => n,StopMixMonitor()
 same => n,Hangup()
exten => h,1,StopMixMonitor()
""")
    # Build a narrow env file; do not forward unrelated CRM/SMTP/SIP credentials.
    identity = {}
    for line in Path(args.credentials).read_text().splitlines():
        line = line.removeprefix("export ").strip()
        name, sep, value = line.partition("=")
        if sep and name in {"YANDEX_CLOUD_API_KEY", "YANDEX_CLOUD_FOLDER_ID", "AI_PROVIDER_PROXY_URL"}:
            identity[name] = value.strip().strip("\"'")
    if not identity.get("YANDEX_CLOUD_API_KEY") or not identity.get("YANDEX_CLOUD_FOLDER_ID"):
        raise ValueError("protected credential file missing Yandex identity")
    identity.update({"ASTERISK_HOST": "127.0.0.1", "ASTERISK_ARI_PORT": str(PORTS["ari"]),
        "ASTERISK_ARI_USERNAME": "qa", "ASTERISK_ARI_PASSWORD": password,
        "QA_ENGINE_CHANNEL_ID": cid, "HEALTH_BIND_HOST": "127.0.0.1", "HEALTH_BIND_PORT": str(PORTS["health"]),
        "CALL_HISTORY_DB_PATH": "/app/data/call_history.db", "POST_CALL_OUTBOX_DB_PATH": "/app/data/call_history.db",
        "SALES_BRAIN_BASE_URL": f"http://127.0.0.1:{PORTS['crm']}", "CRM_SERVICE_API_TOKEN": password,
        "AAVA_DEFAULT_BUSINESS_ID": "900001", "PYTHONUNBUFFERED": "1", "PYTHONPATH": "/app"})
    private_write(base / "engine.env", "\n".join(f"{k}={v}" for k,v in identity.items()) + "\n")
    for mount in (base / "config", base / "entry.py", base / "engine-data", base / "media"):
        os.chown(mount, image_uid, image_gid)
        if mount.is_dir():
            for item in mount.rglob("*"):
                os.chown(item, image_uid, image_gid)
    receipts = base / "stub-receipts.db"
    with sqlite3.connect(receipts) as db:
        db.execute("CREATE TABLE receipts(business_id INTEGER,call_id TEXT,body TEXT,PRIMARY KEY(business_id,call_id))")
    attempts = [0]
    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass
        def reply(self, status, payload):
            content = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        def do_GET(self):
            profile = {"businessId": 900001, "instanceId": 900001, "id": 900001,
                       "name": "Synthetic QA", "voiceAiProvider": "yandex_realtime", "voiceModel": args.model,
                       "voiceName": "sofia", "systemPrompt": "Работай только с синтетическим тестом."}
            if self.path == "/api/ml/hotel-profiles/900001":
                self.reply(200, {"profile": profile})
            elif self.path == "/api/ml/hotel-profiles":
                self.reply(200, {"profiles": [profile]})
            else:
                self.reply(404, {"success": False})
        def do_POST(self):
            if self.path != "/qa/post-call":
                return self.reply(404, {"success": False})
            body = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 1024*1024))
            data = json.loads(body)
            if data.get("business_id") != 900001 or data.get("call_id") != cid:
                return self.reply(400, {"success": False})
            attempts[0] += 1
            if attempts[0] == 1:
                return self.reply(503, {"success": False})  # exercise durable retry
            with sqlite3.connect(receipts) as db:
                db.execute("PRAGMA synchronous=FULL")
                db.execute("INSERT OR IGNORE INTO receipts VALUES(?,?,?)", (900001, cid, body.decode()))
            self.reply(200, {"success": True})
    server = ThreadingHTTPServer(("127.0.0.1", PORTS["crm"]), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ast = None
    created = False
    log = (base / "log/asterisk-console.log").open("wb")
    (base / "log/asterisk-console.log").chmod(0o600)
    ari = f"http://127.0.0.1:{PORTS['ari']}/ari"
    try:
        ast = subprocess.Popen([args.asterisk, "-f", "-C", str(base / "etc/custom.conf")], stdout=log, stderr=subprocess.STDOUT)
        until(lambda: request(ari + "/asterisk/info", "qa", password), 20, "isolated_ari")
        loaded = command([args.asterisk, "-C", str(base / "etc/custom.conf"), "-rx", "module show"]).decode()
        if any(name in loaded for name in ("chan_pjsip.so", "chan_sip.so", "chan_dahdi.so", "chan_iax2.so")):
            raise RuntimeError("unexpected_sip_module")
        report["isolated_no_sip_modules"] = True
        report["stage"] = "ari_ready"
        command(["docker", "run", "-d", "--name", container, "--network", "host", "--env-file", str(base / "engine.env"),
            "--workdir", "/app",
            "-v", f"{src}:/app/src:ro", "-v", f"{base / 'config'}:/app/config:ro",
            "-v", f"{base / 'engine-data'}:/app/data", "-v", f"{base / 'media'}:/mnt/asterisk_media",
            "-v", f"{base / 'entry.py'}:/qa-entry.py:ro", "--entrypoint", "python", args.image, "/qa-entry.py"], timeout=30)
        created = True
        until(lambda: request(ari + "/applications/yandex-isolated-qa", "qa", password), 30, "engine_ari_registered")
        until(lambda: request(f"http://127.0.0.1:{PORTS['health']}/health"), 15, "engine_health")
        report["stage"] = "engine_ready"
        # Only this fixed Local endpoint exists in the private dialplan. No SIP technology loaded.
        query = urlencode({"endpoint": "Local/fixture@qa-fixture/n", "app": "yandex-isolated-qa", "channelId": cid,
                           "otherChannelId": "qa-fixture-" + nonce, "timeout": 10})
        request(ari + "/channels?" + query, "qa", password, {"variables": {
            "AI_CONTEXT": "yandex_qa", "AI_PROVIDER": "yandex_realtime", "AAVA_BUSINESS_ID": "900001", "AAVA_INSTANCE_ID": "900001"}})
        report["stage"] = "local_call_originated"
        until(lambda: not request(ari + "/channels", "qa", password), 70, "local_call_end")
        dbpath = base / "engine-data/call_history.db"
        def persisted():
            with sqlite3.connect(dbpath) as db:
                row = db.execute("SELECT state,attempts FROM post_call_deliveries WHERE business_id=900001 AND call_id=?", (cid,)).fetchone()
                return row if row and row[0] == "delivered" else None
        delivery = until(persisted, 20, "durable_delivery_after_retry")
        with sqlite3.connect(dbpath) as db:
            row = db.execute("SELECT provider_name,business_id,conversation_history,barge_in_count,outcome FROM call_records WHERE call_id=?", (cid,)).fetchone()
        if not row:
            raise RuntimeError("call_history_missing")
        history = json.loads(row[2])
        report.update({"provider": row[0], "business_id": row[1], "user_turns": sum(m.get("role")=="user" for m in history),
            "assistant_turns": sum(m.get("role")=="assistant" for m in history), "barge_in_count": row[3], "outcome": row[4],
            "outbox_state": delivery[0], "delivery_attempts": delivery[1], "stub_http_attempts": attempts[0]})
        with sqlite3.connect(receipts) as db:
            report["stub_durable_rows"] = db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0]
        with wave.open(str(base / "data/agent.wav"), "rb") as wav:
            audio = wav.readframes(wav.getnframes())
            samples = array.array("h", audio)
            report["recorded_agent_seconds"] = round(wav.getnframes()/wav.getframerate(), 2)
            report["recorded_agent_rms"] = round(math.sqrt(sum(x*x for x in samples)/max(1,len(samples))), 1)
            report["recorded_agent_sha256"] = hashlib.sha256(audio).hexdigest()
        report["passed"] = bool(row[0] == "yandex_realtime" and row[1] == 900001 and report["user_turns"] >= 1 and
            report["assistant_turns"] >= 1 and report["barge_in_count"] >= 1 and report["recorded_agent_rms"] > 50 and
            delivery[1] >= 2 and report["stub_durable_rows"] == 1 and row[4] != "error")
        report["audio_listening_verified"] = False
        report["stage"] = "completed"
    except Exception as exc:
        report["error_class"] = type(exc).__name__
        # Our own fixed codes only; subprocess/server bodies are private and never output.
        value = str(exc)
        report["failure_code"] = value if isinstance(exc, RuntimeError) and value.startswith(("timeout:", "command_failed:", "call_history_missing")) else "details_suppressed"
    finally:
        report["cleanup_errors"] = []
        try:
            exists = created or subprocess.run(["docker", "inspect", "--type", "container", container], capture_output=True, timeout=5).returncode == 0
            if exists:
                result = subprocess.run(["docker", "logs", container], capture_output=True, timeout=10)
                private_write(base / "log/engine.log", (result.stdout + result.stderr).decode(errors="replace"))
                subprocess.run(["docker", "stop", "-t", "5", container], capture_output=True, timeout=15)
                removed = subprocess.run(["docker", "rm", container], capture_output=True, timeout=10)
                if removed.returncode:
                    report["cleanup_errors"].append("isolated_container_remove")
        except Exception:
            report["cleanup_errors"].append("isolated_container_cleanup")
        if ast:
            ast.terminate()
            try:
                ast.wait(timeout=10)
            except subprocess.TimeoutExpired:
                ast.kill()
                ast.wait(timeout=3)
        log.close()
        server.shutdown()
        server.server_close()
        report["production_unchanged"] = before == production_fingerprint()
        report["production_channels_after"] = production_channels(args.asterisk)
        report["passed"] &= report["production_unchanged"]
        report["passed"] &= report["production_channels_after"] == 0
        report["passed"] &= not report["cleanup_errors"]
        private_write(base / "receipt.json", json.dumps(report, indent=2, sort_keys=True))
        # Credentials are ephemeral; logs/audio/SQLite remain private for real inspection.
        (base / "engine.env").unlink(missing_ok=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--model", choices=["speech-realtime-max-tts-live/latest", "aliceai-llm-flash"], default="speech-realtime-max-tts-live/latest")
    parser.add_argument("--source", required=True, help="absolute final runtime src directory, or repository containing src; preserve production overlay")
    parser.add_argument("--wav", default="/root/ava-releases/yandex-realtime-probe-20260930/question.wav")
    parser.add_argument("--credentials", default="/root/ava-private/yandex-realtime-20260930.env")
    parser.add_argument("--work-root", default="/root/ava-yandex-isolated-qa")
    parser.add_argument("--image", default="ava-release-engine:20260915T104238Z")
    parser.add_argument("--asterisk", default="/usr/sbin/asterisk")
    parser.add_argument("--modules", default="/usr/lib/asterisk/modules")
    parser.add_argument("--asterisk-assets", default="/var/lib/asterisk", help="packaged documentation/rest-api only; no config or production DB is copied")
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({"run": False, "ports": PORTS, "scope": "isolated Local ARI/AudioSocket + stub CRM", "caller_classifier_shim": True, "sip_verified": False}))
        return
    try:
        report = run(args)
        print(json.dumps(report, sort_keys=True))
        raise SystemExit(0 if report["passed"] else 1)
    except Exception as exc:
        print(json.dumps({"passed": False, "error_class": type(exc).__name__, "details": "suppressed before receipt"}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
