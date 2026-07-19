<div align="center">

<img src="assets/20260718_072854.jpg" width="820" alt="Brutus, an offline voice assistant running on Snapdragon X Elite"/>

<br/>
<br/>

# BRUTUS

### An offline, on device AI voice assistant that runs on Snapdragon X Elite.

No cloud round trip. No account. No data leaving the machine. You talk, it thinks on the NPU, it talks back.

<br/>

[![Snapdragon X Elite](https://img.shields.io/badge/Snapdragon-X%20Elite-C41E3A?style=for-the-badge&logo=qualcomm&logoColor=white)](https://www.qualcomm.com/products/mobile/snapdragon/laptops-and-tablets/snapdragon-x-elite)
[![Hexagon NPU](https://img.shields.io/badge/Runs%20on-Hexagon%20NPU-6E4AFF?style=for-the-badge)](https://www.qualcomm.com/products/technology/processors/hexagon)
[![Qwen3 4B](https://img.shields.io/badge/LLM-Qwen3%204B%20(W4A16)-00A67E?style=for-the-badge)](https://huggingface.co/Qwen/Qwen3-4B)
[![Electron](https://img.shields.io/badge/Cockpit-Electron%2041-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org)
[![React](https://img.shields.io/badge/UI-React%2019-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![License](https://img.shields.io/badge/License-MIT-EAB308?style=for-the-badge)](LICENSE)

</div>

---

## What Brutus actually is

Most voice assistants are a thin shell around someone else's cloud. You speak, your audio flies to a data center, a model you never see answers, and a bill quietly adds up. Brutus is the opposite of that.

Brutus is a full voice loop that lives on the device. Speech becomes text, text becomes an answer, and the answer becomes speech, all on the same machine, all on the Qualcomm silicon. Turn the Wi Fi off and it still works.

The system has two halves that talk over plain HTTP:

* **The Brain Node.** A headless inference appliance. It boots, loads three models once, holds them resident, and answers requests over the LAN forever. It runs no app and no tools. It only does inference. This is the part that runs on Snapdragon X Elite and uses the Hexagon NPU.
* **The Cockpit.** The app in this repository. An Electron and React desktop client that captures your voice, draws the face, runs the tools, shows the dashboard, and routes every AI call to the Brain Node. It does zero inference of its own. Think of it as a window into a brain that lives somewhere else on the network.

```
   You                Command PC  (this repo, the Cockpit)          Snapdragon X Elite  (the Brain Node)
  ┌─────┐            ┌───────────────────────────────┐            ┌────────────────────────────────────┐
  │ 🎙️  │  ───────►  │  voice capture + avatar + UI  │  ───HTTP──►│  /asr    Whisper base   (CPU)        │
  │ 🗣️  │  ◄───────  │  tool calls + dashboard       │  ◄───────  │  /v1/chat Qwen3 4B on the NPU        │
  └─────┘            └───────────────────────────────┘            │  /tts    Kokoro v1.0                 │
                                                                   │  /health status + heartbeat          │
                                                                   └────────────────────────────────────┘
```

---

## The brain: three models behind one door

When people ask "what model is Brutus," the honest answer is three of them, wrapped behind four HTTP endpoints.

### The language model: Qwen3 4B

The core is **Qwen3 4B**, the four billion parameter model from Alibaba's Qwen3 family. It is the locked in default (`geniex_model = "qualcomm/Qwen3-4B"`).

* **Quantized to W4A16.** Four bit weights, sixteen bit activations. That shrinks the weights to roughly **3.0 GiB**, small enough to sit on the NPU and run comfortably.
* **Ungated Qualcomm AI Hub bundle.** It ships as a precompiled NPU package you pull directly. There is no two to three hour self export step that gated models like Llama 3.2 force on you.
* **Runs on the Hexagon NPU.** Not the CPU, not the GPU. The measured throughput is about **15 tokens per second** on the NPU.
* **Quiet by default.** Qwen3 likes to emit long `<think>...</think>` reasoning blocks. Brutus appends `/no_think` to the system prompt so spoken replies stay short and fast.

The interesting part is how it executes, and it is a deliberate choice.

The language model does **not** run inside the Brain Node's Python process. It runs in a separate process called **GenieX**, Qualcomm's on device runtime built on QAIRT. GenieX loads the Qwen3 bundle onto the NPU and exposes an OpenAI compatible server at `http://127.0.0.1:18181`. The Brain Node's `geniex` backend is a thin HTTP proxy that streams tokens back from it.

Why split it out? The Brain Node already loads Qualcomm's `onnxruntime-qnn` stack, and GenieX runs its own QAIRT runtime. Put both in one process and you get two NPU runtimes fighting over one piece of hardware. Isolate GenieX in its own process and the contention just goes away. The boot script `start-brain-node.ps1` captures the whole dance in one command. It launches `geniex serve` in its own window, waits for port 18181 to come up, then starts the Brain Node pointed at it.

### The ears: Whisper base

Speech to text is **Whisper base**, run through `onnx-asr` on ONNX Runtime. This is the ARM64 friendly path. `faster-whisper` was ruled out because its CTranslate2 engine has no Windows ARM64 build. The model downloads from Hugging Face on first load. It runs on the CPU execution provider today, with a hook already in place to move it onto the NPU later.

### The voice: Kokoro v1.0

Text to speech is **Kokoro v1.0** in ONNX, fully offline, default voice `af_sarah`. It uses a bundled `espeak-ng` for phonemization so there is no system dependency to install. Both the ears and the voice are verified working end to end on real X Elite hardware. Text becomes speech, speech transcribes back correctly.

---

## Compression, or why 4 billion parameters fit

A four billion parameter model at full precision is heavy. Quantization is what makes it fit on the NPU and still answer fast. Here is the weight footprint at three precisions.

```
Qwen3 4B weight footprint

  FP16    ████████████████████████████   ~8.0 GB   full precision baseline
  INT8    ██████████████                  ~4.0 GB   half of FP16
  W4A16   ██████████                      ~3.0 GB   what ships on the NPU
```

| Precision | Approx. weight size | vs FP16 | Where it runs |
|---|---|---|---|
| FP16 (baseline) | ~8.0 GB | 1.0x | GPU or big memory |
| INT8 | ~4.0 GB | 0.5x | reference point |
| **W4A16 (Brutus)** | **~3.0 GiB** | **~0.38x** | **Hexagon NPU** |

That is roughly a **2.7x smaller** model than the full precision baseline, a **62 percent** cut in footprint, without dropping to a tiny model that cannot hold a conversation. W4A16 keeps the activations at sixteen bits, so quality stays high while the weights do the shrinking.

---

## Efficiency, and how it stays fast

The Brain Node is built to be boring in the best way. It starts once and then it is just there.

| Property | How Brutus does it | Why it matters |
|---|---|---|
| Model loading | Loaded once at boot, held resident in memory | No per request load cost, ever |
| Process model | Single worker | Models are never duplicated across workers |
| Cold start | A throwaway generation and TTS synth at boot (warm up) | The first real request is already warm |
| NPU contention | GenieX isolated in its own process | Two QNN runtimes never fight over the NPU |
| Network | Served over the LAN, no internet | Works on a plane, in a lab, behind a firewall |
| Privacy | Nothing leaves the device | No audio or text is sent to a third party |
| LLM throughput | ~15 tokens per second on the Hexagon NPU | Comfortable for spoken, short form replies |

---

## How a turn actually flows

Brutus speaks two ways, and you pick which one in Settings.

**Edge Server engine (fully on device).** This is the point of the whole project.

```
  you speak
     │
     ▼  microphone capture + voice activity detection        (Cockpit)
     ▼  POST /asr        Whisper base transcribes             (Brain Node, CPU)
     ▼  POST /v1/chat    Qwen3 4B answers on the Hexagon NPU  (via GenieX)
     ▼  POST /tts        Kokoro v1.0 synthesizes the reply    (Brain Node)
     ▼  audio plays and the on screen face reacts             (Cockpit)
```

**Cloud engine (fallback).** When you have no Brain Node on the network, the Cockpit can fall back to a streaming cloud model so the app still works. It is optional, it is clearly labelled, and the on device path is always the default when a Brain Node is reachable.

You flip between the two under **Settings, then API Keys, then Voice Uplink**. A small status pill shows the live state of the on device loop as it runs: listening, thinking, or speaking.

---

## The HTTP contract

The Brain Node exposes exactly four endpoints. That is the entire surface.

| Endpoint | Method | What it does |
|---|---|---|
| `/v1/chat` | POST | Chat completion from the LLM. Streams Server Sent Events, then a `brutus.metrics` event with time to first token and tokens per second. |
| `/asr` | POST | Speech to text. Send a WAV, get a transcript. |
| `/tts` | POST | Text to speech. Send text, get WAV audio back. |
| `/health` | GET | Liveness and a capability report used for the dashboard heartbeat. |

`/v1/chat` is deliberately shaped like the OpenAI API, so any OpenAI client works against it with no changes. Every reply is instructed to begin with an `[EMOTION:xxx]` tag, which the face layer strips off and uses to drive expressions and lip movement.

One design decision worth calling out: **the Brain Node is stateless.** The client sends the full message array on every request, and the node stores nothing between calls beyond an optional access log. Each answer is computed in isolation. That keeps the per device brain simple and fast, and it leaves room for a shared memory layer to sit in front of it later and give every device cross device context.

---

## Pluggable by design, testable anywhere

Every model type is an abstract interface, and a factory builds the real one from config. That means you can develop against the exact HTTP contract on any laptop, no NPU required.

| Model | Backends available | Default (real hardware) |
|---|---|---|
| LLM | `geniex`, `genai`, `anythingllm`, `mock` | `geniex` |
| ASR | `onnx`, `whisper`, `mock` | `onnx` |
| TTS | `kokoro`, `mock` | `kokoro` |

There are two modes:

* **mock** is the default. Deterministic fake backends with no heavy dependencies, so every other team on the project can build against the real contract on any machine and the test suite runs everywhere.
* **real** loads the on device models on the X Elite.

That split is the whole reason the plumbing can be verified without ever touching the NPU.

### Boot sequence

The Brain Node comes up in a fixed, defensive order:

1. **Verify the NPU.** Register the QNN plugin and enumerate devices, so every boot log proves the Hexagon NPU is reachable.
2. **Load each backend once** and hold it resident. Single worker, no duplication.
3. **Warm up.** A throwaway generation and a TTS synth, so the first real request is never cold.
4. **Flip ready to true.**

### Graceful degradation

If a backend fails to load, it is logged, marked unavailable, and the node still boots serving the rest. If GenieX is not up, `/health` reports `degraded` and `/v1/chat` returns 503, while `/asr` and `/tts` keep working. The boot never crashes. You always get a node that serves whatever it can.

---

## The Cockpit (this repository)

This repo is the desktop client. It is where you actually talk to Brutus, and it is where all the tools live. It runs no model itself. It sends every AI call to the Brain Node and falls back to a cloud model only when no node is reachable.

What it gives you:

* **Two voice engines,** edge and cloud, switchable in Settings, with a live listening and thinking and speaking status pill.
* **A text chat** that routes to the Brain Node `/v1/chat` with an automatic cloud fallback.
* **A talking face.** An on screen avatar whose eyes and expression follow the `[EMOTION:xxx]` tag and the current state of the conversation.
* **A tool layer** for real work: files and apps, OS automation, web search and deep research, email, presentations, a knowledge graph, document question and answer, and an Android link over ADB.
* **A PIN protected local vault** for your keys and settings. Keys are stored on your machine through the OS secure storage. Nothing phones home.
* **A Brain Node panel** in Settings to set the node URL, an optional access token, and toggle routing, with a one click connection test.

### Brutus vs a typical cloud assistant

| | Brutus (edge) | Typical cloud assistant |
|---|:---:|:---:|
| Works with no internet | yes | no |
| Audio leaves your device | no | yes |
| Cost per query | zero | metered |
| Latency path | your own LAN | data center round trip |
| Model you can see and swap | yes | no |
| Runs on the NPU | yes | not on your device |
| Data used to train someone else | no | often |

---

## Quick start

You need two things running: the Cockpit (this repo) and a Brain Node to point it at. You can start with the Cockpit alone and connect a node later.

### 1. Run the Cockpit

Prerequisites: **Node.js 18 or newer** (20 LTS is a good pick) on **Windows 10 or 11**.

```bash
git clone https://github.com/Aditya060806/Brutus.git
cd Brutus
npm install
npm run dev
```

That is the whole setup. `npm run dev` launches the app in development.

To build a Windows installer:

```bash
npm run build:win
```

### 2. Point it at a Brain Node

Open **Settings, then API Keys, then Brain Node** and set the URL, for example `http://127.0.0.1:8080` on the same machine or `http://<device ip>:8080` across the LAN. Press **Save and Connect** and the status badge tells you if the node is live and whether its LLM is ready.

Prefer environment variables? Create a `.env` from the template and set:

```env
# Where the Brain Node lives. Overrides the in app default.
BRUTUS_BRAIN_URL="http://127.0.0.1:8080"

# Only if your node is locked with a bearer token.
BRUTUS_API_KEY=""

# Optional cloud fallback so the app still answers when no node is reachable.
# Also powers UI generation, which always stays on the cloud model.
GEMINI_API_KEY="your_key_here"
```

Precedence is simple: the environment variable wins, then your saved setting, then the built in default.

### 3. Boot the Brain Node

On the Snapdragon X Elite, the node is one command:

```powershell
.\start-brain-node.ps1
```

That launches GenieX in its own window, waits for port 18181, then starts the Brain Node on port 8080. On any other machine, run the node in **mock** mode to develop against the real HTTP contract without an NPU.

Sanity check it from anywhere on the LAN:

```bash
curl http://<device ip>:8080/health
```

A healthy node reports `status: ok` with all three backends loaded. A `degraded` status means one model did not load, and the node is still serving the rest.

---

## Project layout (the Cockpit)

```
Brutus/
├── src/
│   ├── main/                         # Electron main process (Node)
│   │   ├── index.ts                  # entry, window, IPC registration
│   │   ├── services/
│   │   │   ├── llm-provider.ts        # Brain Node client + cloud fallback + config
│   │   │   ├── text-chat.ts           # chat routed through the provider
│   │   │   ├── architect.ts           # project scaffolding (cloud only)
│   │   │   └── ...                     # deck studio, knowledge graph, RAG, research
│   │   ├── logic/                     # the tool handlers (files, OS, ADB, memory)
│   │   ├── auto/                      # website builder, widget manager
│   │   └── security/                  # PIN vault + settings store
│   ├── preload/                       # context isolation and the IPC allowlist
│   └── renderer/                      # React 19 front end
│       └── src/
│           ├── services/
│           │   └── Brutus-voice-ai.ts  # both voice engines (cloud + edge server)
│           ├── components/
│           │   ├── BrutusEyes/          # the animated face, driven by emotion + state
│           │   └── EdgeStatusChip.tsx   # the live on device status pill
│           ├── views/                   # Dashboard, Settings, Notes, Phone, and more
│           └── utils/audioUtils.ts      # PCM, WAV, resampling helpers
├── assets/                            # images, icons, Arduino firmware
├── electron.vite.config.ts            # split process build config
└── package.json
```

---

## Tech stack

| Layer | Technology |
|---|---|
| On device LLM | Qwen3 4B (W4A16) on the Hexagon NPU via GenieX and QAIRT |
| On device ASR | Whisper base through `onnx-asr` on ONNX Runtime |
| On device TTS | Kokoro v1.0 ONNX with bundled `espeak-ng` |
| Node runtime verification | `onnxruntime-qnn` (QNN execution provider) |
| Desktop client | Electron 41 with electron vite |
| Front end | React 19 and Tailwind CSS v4 |
| State | Zustand |
| Motion and 3D | Framer Motion, GSAP, Three.js |
| Cloud fallback and UI generation | Google Gemini via `@google/genai` |
| Local vector store | LanceDB |
| Web automation | Puppeteer with stealth |
| OS automation | Nut.js |
| Android link | ADB over Wi Fi |

---

<div align="center">

<img src="assets/WhatsApp%20Image%202026-07-18%20at%2023.00.50.jpeg" width="720" alt="Brutus running fully offline on device"/>

<br/><sub>Brutus answering fully offline. The model runs on the NPU, the audio never leaves the machine.</sub>

</div>

---

## Roadmap

* Move Whisper ASR from the CPU execution provider onto the NPU.
* A shared memory layer in front of the stateless nodes, so every device gets cross device context.
* Streaming TTS so the voice starts before the full reply is generated.
* A device fleet dashboard: one tile per node with live heartbeats and per tier tokens per second.
* Wake word so you can start a turn hands free.
* macOS and Linux builds of the Cockpit.

---

## Security and privacy

* **Local first.** The on device path sends no audio and no text off the machine.
* **Bring your own keys.** Any cloud fallback key is yours, stored locally through OS secure storage, never uploaded.
* **PIN vault.** The app is gated by a local PIN, and your settings and keys sit behind it.
* **No telemetry.** Nothing phones home.
* **Honest fallback.** The one time data can leave the device is the optional cloud engine, and it is clearly labelled and off the critical path whenever a Brain Node is reachable.

---

## Author

**Aditya Pandey**

* GitHub: [@Aditya060806](https://github.com/Aditya060806)
* LinkedIn: [Aditya Pandey](https://www.linkedin.com/in/aditya-pandey-p1002/)
* Email: aditya060806@gmail.com

---

## License

MIT. See [LICENSE](LICENSE).

<div align="center">
<br/>
<b>Brutus. Your voice, your machine, your model. Nothing leaves the room.</b>
</div>
