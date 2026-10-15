"""Onyx voice: talk to Onyx, hear it answer. Everything runs on this PC.

  wake word  openWakeWord ("hey jarvis" by default), or the push-to-talk hotkey
  hearing    faster-whisper (OpenAI Whisper, run locally)
  speaking   Piper neural voices, falling back to the Windows voice

It is one more client of the Onyx core, like the hotkey window: it sends what
you say, speaks the reply as it streams in, and lets you answer approvals and
questions out loud ("yes" / "no").

  .venv\\Scripts\\python voice\\voice.py      (or: npm run voice)
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import sys
import threading
import time

import numpy as np
import sounddevice as sd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "models")
ONYX_HOME = os.environ.get("ONYX_HOME") or os.path.join(os.path.expanduser("~"), ".onyx")

RATE = 16000
FRAME = 1280  # 80 ms, what openWakeWord expects


def log(*a):
    print("[voice]", *a, flush=True)


def load_settings() -> dict:
    cfg = {}
    try:
        with open(os.path.join(ONYX_HOME, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        pass
    v = {"wakeWord": "hey_jarvis", "pushToTalk": "ctrl+alt+space", "whisperModel": "base.en", "piperVoice": "en_US-lessac-medium"}
    v.update(cfg.get("voice") or {})
    port = int(os.environ.get("ONYX_PORT") or cfg.get("port") or 8765)
    with open(os.path.join(ONYX_HOME, "token"), encoding="utf-8") as f:
        token = f.read().strip()
    return {"voice": v, "url": f"ws://127.0.0.1:{port}/ws", "token": token}


# ------------------------------------------------------------------ speaking


class Speaker:
    """Piper if a voice model is downloaded, else the built-in Windows voice."""

    def __init__(self, voice_name: str):
        self.piper = None
        self.engine = None
        self.stop_flag = threading.Event()
        self.speaking = threading.Event()
        path = os.path.join(MODELS, "piper", f"{voice_name}.onnx")
        if os.path.exists(path):
            try:
                from piper import PiperVoice

                self.piper = PiperVoice.load(path)
                log(f"voice: Piper {voice_name}")
            except Exception as err:
                log(f"Piper failed to load ({err}); using the Windows voice")
        if not self.piper:
            log("voice: Windows built-in (run `npm run setup` to download a natural Piper voice)")

    def say(self, text: str) -> None:
        text = clean_for_speech(text)
        if not text:
            return
        self.stop_flag.clear()
        self.speaking.set()
        try:
            if self.piper:
                for chunk in self.piper.synthesize(text):
                    if self.stop_flag.is_set():
                        break
                    audio = np.frombuffer(chunk.audio_int16_bytes, dtype=np.int16)
                    sd.play(audio, chunk.sample_rate)
                    while sd.get_stream().active:
                        if self.stop_flag.is_set():
                            sd.stop()
                            break
                        time.sleep(0.03)
            else:
                import pyttsx3

                # pyttsx3 engines are not reusable across threads: one per utterance.
                engine = pyttsx3.init()
                engine.setProperty("rate", 185)
                engine.say(text)
                engine.runAndWait()
        except Exception as err:
            log(f"speech failed: {err}")
        finally:
            self.speaking.clear()

    def stop(self) -> None:
        self.stop_flag.set()
        try:
            sd.stop()
        except Exception:
            pass


def clean_for_speech(text: str) -> str:
    t = re.sub(r"```.*?```", " ", text, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"https?://\S+", "a link", t)
    t = re.sub(r"[*_#>|]+", "", t)
    t = re.sub(r"[A-Za-z]:\\[^\s,]+", "the file", t)
    t = t.replace("₹", " rupees ")
    return re.sub(r"\s+", " ", t).strip()


def beep(freq=880, ms=90, vol=0.25):
    t = np.linspace(0, ms / 1000, int(RATE * ms / 1000), False)
    tone = (np.sin(2 * np.pi * freq * t) * vol * np.hanning(len(t))).astype(np.float32)
    try:
        sd.play(tone, RATE)
        sd.wait()
    except Exception:
        pass


# ------------------------------------------------------------------ hearing


class Ears:
    def __init__(self, settings: dict):
        self.frames: queue.Queue[np.ndarray] = queue.Queue(maxsize=400)
        self.wake = None
        self.whisper = None
        self.ptt = threading.Event()
        # Set while an approval or question is listening for its answer, so
        # the wake-word loop does not steal the microphone frames.
        self.exclusive = threading.Event()
        self.settings = settings
        self._load_wake(settings["wakeWord"])
        self._load_whisper(settings["whisperModel"])

    def _load_wake(self, name: str):
        try:
            from openwakeword.model import Model

            folder = os.path.join(MODELS, "openwakeword")
            path = os.path.join(folder, f"{name}_v0.1.onnx")
            custom = os.path.join(folder, f"{name}.onnx")
            if not os.path.exists(path) and os.path.exists(custom):
                path = custom
            if not os.path.exists(path):
                log(f'wake word "{name}" not downloaded: run `npm run setup`. Push-to-talk still works.')
                return
            self.wake = Model(
                wakeword_models=[path],
                inference_framework="onnx",
                melspec_model_path=os.path.join(folder, "melspectrogram.onnx"),
                embedding_model_path=os.path.join(folder, "embedding_model.onnx"),
            )
            log(f'wake word: "{name.replace("_", " ")}"')
        except Exception as err:
            log(f"wake word unavailable ({err}). Push-to-talk still works.")

    def _load_whisper(self, model: str):
        from faster_whisper import WhisperModel

        local = os.path.join(MODELS, "whisper", model)
        source = local if os.path.isdir(local) else model
        for device, compute in (("cuda", "float16"), ("cpu", "int8")):
            try:
                self.whisper = WhisperModel(source, device=device, compute_type=compute, download_root=os.path.join(MODELS, "whisper-cache"))
                # Run once so a missing CUDA library fails here, not mid-sentence.
                list(self.whisper.transcribe(np.zeros(RATE // 2, dtype=np.float32), language="en")[0])
                log(f"hearing: whisper {model} on {device}")
                return
            except Exception as err:
                if device == "cpu":
                    raise
                log(f"GPU speech recognition unavailable ({str(err)[:80]}); using CPU")

    def start(self):
        def callback(indata, frames, t, status):
            try:
                self.frames.put_nowait(indata[:, 0].copy())
            except queue.Full:
                pass

        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=FRAME, callback=callback)
        self.stream.start()

    def drain(self):
        while not self.frames.empty():
            try:
                self.frames.get_nowait()
            except queue.Empty:
                break

    def wait_for_wake(self, stop: threading.Event) -> str:
        """Blocks until the wake word or push-to-talk. Returns which."""
        self.drain()
        if self.wake:
            self.wake.reset()
        while not stop.is_set():
            if self.exclusive.is_set():
                time.sleep(0.05)
                continue
            if self.ptt.is_set():
                self.ptt.clear()
                return "ptt"
            try:
                frame = self.frames.get(timeout=0.2)
            except queue.Empty:
                continue
            if self.wake:
                scores = self.wake.predict(frame)
                if max(scores.values(), default=0) > 0.5:
                    self.wake.reset()
                    return "wake"
        return ""

    def record(self, max_sec=15.0, start_timeout=5.0) -> np.ndarray | None:
        """Record one utterance, ending at ~0.9 s of silence."""
        self.drain()
        chunks, voiced, silent = [], False, 0.0
        floor = None
        t0 = time.time()
        while time.time() - t0 < max_sec:
            try:
                f = self.frames.get(timeout=0.5)
            except queue.Empty:
                continue
            chunks.append(f)
            rms = float(np.sqrt(np.mean((f.astype(np.float32) / 32768) ** 2)))
            if floor is None:
                floor = rms
            floor = min(floor * 1.002 + 1e-5, rms) if not voiced else floor
            threshold = max(0.012, floor * 3.0)
            if rms > threshold:
                voiced, silent = True, 0.0
            elif voiced:
                silent += FRAME / RATE
                if silent > 0.9:
                    break
            elif time.time() - t0 > start_timeout:
                return None
        if not voiced:
            return None
        return np.concatenate(chunks).astype(np.float32) / 32768

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _ = self.whisper.transcribe(audio, language="en", beam_size=1, vad_filter=True)
        return " ".join(s.text for s in segments).strip()


YES = re.compile(r"\b(yes|yeah|yep|sure|ok(ay)?|go ahead|do it|allow|approve|confirm)\b", re.I)
TASK = re.compile(r"\b(this task|for (this|the) task|all of (it|them))\b", re.I)
NO = re.compile(r"\b(no|nope|don'?t|stop|cancel|deny|never)\b", re.I)
STOP_WORDS = re.compile(r"^\s*(stop|cancel|never ?mind|shut up|be quiet)\W*$", re.I)


# ------------------------------------------------------------------ the loop


class Voice:
    def __init__(self):
        self.cfg = load_settings()
        self.speaker = Speaker(self.cfg["voice"]["piperVoice"])
        self.ears = Ears(self.cfg["voice"])
        self.out: queue.Queue = queue.Queue()  # messages to the core
        self.events: queue.Queue = queue.Queue()  # messages from the core
        self.client_id = None
        self.my_turn = None
        self.buffer = ""
        self.stop = threading.Event()
        self.say_queue: queue.Queue[str | None] = queue.Queue()

    # -- core connection (asyncio thread)

    async def _socket(self):
        import websockets

        while not self.stop.is_set():
            try:
                async with websockets.connect(self.cfg["url"], max_size=8_000_000) as ws:
                    await ws.send(json.dumps({"type": "hello", "token": self.cfg["token"], "role": "voice"}))

                    async def pump_out():
                        while True:
                            msg = await asyncio.get_running_loop().run_in_executor(None, self.out.get)
                            await ws.send(json.dumps(msg))

                    sender = asyncio.create_task(pump_out())
                    try:
                        async for raw in ws:
                            self.events.put(json.loads(raw))
                    finally:
                        sender.cancel()
            except Exception as err:
                log(f"core not reachable ({err.__class__.__name__}); retrying")
                await asyncio.sleep(3)

    # -- speaking (its own thread so listening never blocks)

    def _speaker_loop(self):
        while True:
            text = self.say_queue.get()
            if text is None:
                return
            self.speaker.say(text)

    def say(self, text):
        self.say_queue.put(text)

    def hush(self):
        while not self.say_queue.empty():
            try:
                self.say_queue.get_nowait()
            except queue.Empty:
                break
        self.speaker.stop()

    # -- events from the core

    def _event_loop(self):
        while True:
            m = self.events.get()
            t = m.get("type")
            if t == "welcome":
                self.client_id = m["clientId"]
                log("connected to Onyx")
            elif t == "turn_start" and m.get("clientId") == self.client_id:
                self.my_turn, self.buffer = m["turn"], ""
            elif t == "text" and m.get("turn") == self.my_turn:
                self.buffer += m["delta"]
                # Speak each finished sentence as soon as it arrives.
                while True:
                    mm = re.search(r"^(.+?[.!?])(\s+|$)", self.buffer, re.S)
                    if not mm or (mm.end() == len(self.buffer) and not self.buffer.endswith((" ", "\n"))):
                        break
                    self.say(mm.group(1))
                    self.buffer = self.buffer[mm.end():]
            elif t in ("done", "error") and m.get("turn") == self.my_turn:
                rest = self.buffer.strip() or (m.get("message") if t == "error" else "")
                if rest:
                    self.say(rest)
                self.my_turn, self.buffer = None, ""
            elif t == "approval":
                threading.Thread(target=self._voice_approval, args=(m,), daemon=True).start()
            elif t == "question" and self.my_turn:
                threading.Thread(target=self._voice_question, args=(m,), daemon=True).start()
            elif t == "notify":
                self.say(f"{m.get('title', '')}. {m.get('body', '')}")
            elif t == "stopped":
                self.hush()

    def _listen_reply(self, prompt: str) -> str:
        self.say(prompt)
        while not self.say_queue.empty() or self.speaker.speaking.is_set():
            time.sleep(0.05)
        self.ears.exclusive.set()
        try:
            beep(990, 70)
            audio = self.ears.record(max_sec=8, start_timeout=6)
            return self.ears.transcribe(audio) if audio is not None else ""
        finally:
            self.ears.exclusive.clear()

    def _voice_approval(self, m):
        heard = self._listen_reply(f"I need your OK to: {m['label']}. Say yes or no.")
        log(f"approval answer: {heard!r}")
        if NO.search(heard):
            answer = "deny"
        elif YES.search(heard):
            answer = "allow_turn" if TASK.search(heard) and m.get("risk") != "danger" else "allow"
        else:
            self.say("I didn't catch that. You can answer on screen.")
            return
        self.out.put({"type": "approve", "id": m["id"], "answer": answer})

    def _voice_question(self, m):
        choices = m.get("choices") or []
        extra = f" Options: {', '.join(choices)}." if choices else ""
        heard = self._listen_reply(m["question"] + extra)
        if heard:
            pick = next((c for c in choices if c.lower() in heard.lower()), heard)
            self.out.put({"type": "answer", "id": m["id"], "text": pick})

    # -- main

    def run(self):
        threading.Thread(target=lambda: asyncio.run(self._socket()), daemon=True).start()
        threading.Thread(target=self._event_loop, daemon=True).start()
        threading.Thread(target=self._speaker_loop, daemon=True).start()
        try:
            import keyboard

            keyboard.add_hotkey(self.cfg["voice"]["pushToTalk"], self.ears.ptt.set)
            log(f"push-to-talk: {self.cfg['voice']['pushToTalk']}")
        except Exception as err:
            log(f"push-to-talk hotkey unavailable: {err}")
        self.ears.start()
        log("listening. Say the wake word, or press push-to-talk.")
        while not self.stop.is_set():
            how = self.ears.wait_for_wake(self.stop)
            if not how:
                continue
            self.hush()  # barge-in: talking over Onyx stops it speaking
            beep()
            audio = self.ears.record()
            if audio is None:
                beep(440, 80)
                continue
            text = self.ears.transcribe(audio)
            log(f"heard: {text!r}")
            if not text or len(text) < 2:
                continue
            if STOP_WORDS.match(text):
                self.out.put({"type": "stop"})
                continue
            self.out.put({"type": "ask", "text": text, "voice": True})


if __name__ == "__main__":
    try:
        Voice().run()
    except KeyboardInterrupt:
        pass
