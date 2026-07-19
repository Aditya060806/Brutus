<div align="center">

<img src="assets/20260718_072854.jpg" width="820" alt="Brutus, an offline voice assistant running on Snapdragon X Elite"/>

<br/>
<br/>

# BRUTUS

### An offline first AI that thinks on the edge. It listens on your machine, reasons on Snapdragon silicon, keeps a tiny reflex brain on an Arduino, and answers with a face full of servos.

You talk, it thinks on the NPU, it talks back. No cloud round trip on the critical path. No account. Pull the network and it keeps going.

<br/>

[![Snapdragon X Elite](https://img.shields.io/badge/Edge-Snapdragon%20X%20Elite-C41E3A?style=for-the-badge&logo=qualcomm&logoColor=white)](https://www.qualcomm.com/products/mobile/snapdragon/laptops-and-tablets/snapdragon-x-elite)
[![Hexagon NPU](https://img.shields.io/badge/Runs%20on-Hexagon%20NPU-6E4AFF?style=for-the-badge)](https://www.qualcomm.com/products/technology/processors/hexagon)
[![Qwen3 4B](https://img.shields.io/badge/Brain-Qwen3%204B%20(W4A16)-00A67E?style=for-the-badge)](https://huggingface.co/Qwen/Qwen3-4B)
[![Arduino Uno Q](https://img.shields.io/badge/Reflex-Arduino%20Uno%20Q-00979D?style=for-the-badge&logo=arduino&logoColor=white)](https://www.arduino.cc)
[![Electron](https://img.shields.io/badge/Hub-Electron%2041-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org)
[![License](https://img.shields.io/badge/License-MIT-EAB308?style=for-the-badge)](LICENSE)

<br/>

**[Watch the demo video](https://drive.google.com/file/d/1iEQ8_0RgrJ_upc7SoQQ_h8_tGQfKDFlC/view?usp=drive_link)**  ·  **[See the presentation](https://drive.google.com/file/d/10COwSTOePot8Zara3cNQorNXDBU2ZgEv/view?usp=drive_link)**  ·  **[Mobile app repo](https://github.com/Aditya060806/Brutus-app)**  ·  **[Brain Node server repo](https://github.com/Aditya060806/Ai-Qualcom-backend)**

</div>

---

## Team Brutus

| Name | Email |
|:--|:--|
| Aditya Pandey | aditya060806@gmail.com |
| Palak Rai | palakrai32323@gmail.com |
| Avik Srivastava | aviksrivastava786@gmail.com |

---

## Table of contents

* [Application description](#application-description)
* [The three repositories](#the-three-repositories)
* [Why this is an edge application](#why-this-is-an-edge-application)
* [Every model we use, nothing left out](#every-model-we-use-nothing-left-out)
* [The Arduino Uno Q reflex brain](#the-arduino-uno-q-reflex-brain)
* [Compression, or how big models fit on small hardware](#compression-or-how-big-models-fit-on-small-hardware)
* [Efficiency, and how it stays fast](#efficiency-and-how-it-stays-fast)
* [How a turn actually flows](#how-a-turn-actually-flows)
* [Brutus next to a typical cloud assistant](#brutus-next-to-a-typical-cloud-assistant)
* [The robots](#the-robots)
* [It in action](#it-in-action)
* [Setup from scratch](#setup-from-scratch)
* [Run and usage](#run-and-usage)
* [Tests and testing instructions](#tests-and-testing-instructions)
* [Platforms](#platforms)
* [Repository map](#repository-map)
* [Notes](#notes)
* [References](#references)
* [License](#license)

---

## Application description

Most voice assistants are a thin shell around someone else's cloud. You speak, your audio flies to a data center, a model you never see answers, and a bill quietly grows. Brutus is the opposite of that.

Brutus is a full voice loop that lives on your own hardware. Speech becomes text, text becomes an answer, and the answer becomes speech, all on silicon you can hold. Turn the Wi Fi off and it still holds a conversation. When it does reach the cloud, that is a fallback you choose, never the default.

The project is not one program. It is a small fleet of devices that each do one job well and talk over plain HTTP and Bluetooth:

* **The Command PC hub (this repository).** An Electron and React desktop app. It captures your voice, draws the animated face, runs a large tool layer, shows the dashboard, and routes every AI call to whichever brain you point it at. It does no inference of its own. Think of it as the cockpit.
* **The Snapdragon Brain Node.** A headless inference appliance on a Snapdragon X Elite laptop. It loads three models once and serves them over the LAN forever. This is the powerful edge brain, running a four billion parameter model on the Hexagon NPU.
* **The Arduino Uno Q reflex brain.** A tiny always on model running under llama.cpp directly on an Arduino Uno Q. It exists to keep the system honest: a fast, grounded, low temperature second opinion that catches and softens hallucinations from the bigger models and the web APIs, and answers instantly when everything else is busy or offline.
* **The mobile app and the robots.** An Android app that carries the same brains in your pocket, and two physical robots whose eyes and mouth move as Brutus speaks.

What you can actually do with it: hold a spoken conversation answered entirely on the edge, type to it, point a camera at something and ask about it, read text off the screen, search the web, run deep research, answer over your own documents, drive a robot face, and switch which brain thinks with a single tap.

---

## The three repositories

Brutus is a vast project, so it lives in three repositories that fit together.

| Repository | What it is | Link |
|:--|:--|:--|
| Brutus (this repo) | The Command PC hub. Electron and React desktop cockpit. | you are here |
| Brutus Brain Node | The Snapdragon inference server. Qwen3 4B on the NPU, plus Whisper and Kokoro. | [Ai-Qualcom-backend](https://github.com/Aditya060806/Ai-Qualcom-backend) |
| Brutus Mobile | The Flutter Android app. Same brains, robot control, camera eyes, Indic voice. | [Brutus-app](https://github.com/Aditya060806/Brutus-app) |

---

## Why this is an edge application

The majority of Brutus runs locally on device. Here is exactly where every piece of compute happens.

| Component | Where it runs | On the edge |
|:--|:--|:--:|
| Speech to text (Whisper base) | Snapdragon X Elite, ONNX Runtime | yes |
| Main reasoning (Qwen3 4B) | Snapdragon X Elite, Hexagon NPU | yes |
| Text to speech (Kokoro) | Snapdragon X Elite | yes |
| Reflex model (Qwen2.5 0.5B) | Arduino Uno Q, llama.cpp | yes |
| Hub app, tools, face, dashboard | Command PC, locally | yes |
| Phone brain (Gemma3 1B, FastVLM) | The phone's own NPU | yes |
| On device OCR, face tracking, memory | Command PC and phone | yes |
| Optional cloud fallback and UI generation | Gemini, Groq, Sarvam | no, only when chosen |

Every model in the core voice loop runs on the edge. The cloud is a labelled fallback that sits off the critical path whenever a local brain is reachable. That is what edge first should mean in practice.

---

## Every model we use, nothing left out

Brutus is not one model. It is a stack of them, chosen per job and per tier, from a seventy billion parameter cloud model down to a half billion parameter model on a board that costs less than lunch.

| Role | Model | Runs on | Offline | Notes |
|:--|:--|:--|:--:|:--|
| Main reasoning (edge) | Qwen3 4B, quantized W4A16 | Snapdragon X Elite NPU via GenieX | yes | The default brain, about 3.0 GiB, roughly 15 tokens per second |
| Reflex and grounding (edge) | Qwen2.5 0.5B Instruct, Q4 or Q5_K_M GGUF | Arduino Uno Q via llama.cpp | yes | The always on sanity checker, about 0.4 GB |
| Phone brain (edge) | Gemma3 1B | The phone's NPU | yes | On device chat for the mobile app, airplane mode friendly |
| Phone vision (edge) | FastVLM | The phone's NPU | yes | On device image understanding for the mobile app |
| Speech to text (edge) | Whisper base | ONNX Runtime, CPU | yes | ARM64 friendly path via onnx-asr |
| Text to speech (edge) | Kokoro v1.0 | Brain Node | yes | Fully offline, bundled espeak-ng, voice af_sarah |
| Live voice (cloud) | Gemini 2.5 Flash native audio | Google | no | The richest live conversation, a fallback engine |
| UI and vision (cloud) | Gemini 2.5 Flash and Gemini 3 Flash | Google | no | Website and layout generation, screen and camera vision |
| Research and RAG (cloud) | Groq Llama 3.3 70B | Groq | no | Fast deep research and document answers |
| Indic voice and chat (cloud) | Sarvam 30B and 105B, Bulbul v2 TTS | Sarvam | no | Hindi, Tamil, and other Indian languages |
| Embeddings | Gemini text-embedding-004, 768 dims | Google | no | Powers the document oracle |
| On device OCR | ML Kit text recognition and Tesseract | Phone and hub | yes | Read the screen, read a photo |
| On device face detection | ML Kit face detection | Phone | yes | Eye tracking that turns the robot's eyes toward you |
| Local vector store | LanceDB | Command PC | yes | Retrieval for the document oracle |

Every brain speaks the same contract to the hub: audio or text in, tokens and audio out, an optional tool call, and a reply that begins with an `[EMOTION:xxx]` tag. That is why any of them can stand in for another with no change to the app, the tools, or the robot.

---

## The Arduino Uno Q reflex brain

<div align="center">
<img src="assets/Arduino%20Uno%20Q%20inference.jpeg" width="760" alt="Qwen2.5 0.5B running under llama.cpp on the Arduino Uno Q, serving inference over ADB"/>
<br/>
<sub>Hallucination control and inference through the Arduino Uno Q. A half billion parameter model, served by llama.cpp, straight off the board.</sub>
</div>

<br/>

Big models are confident even when they are wrong, and web APIs go down or drift. So Brutus keeps a third brain that is small, fast, and always there. It is a Qwen2.5 0.5B Instruct model running under llama.cpp on an Arduino Uno Q, the board in the photo above.

What it is for:

* **Hallucination control.** The reflex brain gives a short, low temperature, grounded second opinion. When the local server or a web API returns something shaky, the hub can check it against a model that is cheap enough to call on every turn, and soften or flag an answer before it reaches you.
* **A failover that never leaves the room.** If the Snapdragon node is busy or a web API times out, the reflex brain answers in one sentence so the conversation never stalls. Because it lives on the board over USB, it is up whenever the machine has power.
* **Instant reflexes.** For short intent and quick facts, a half billion parameter model is plenty, and it replies with almost no latency.

The clever part is that the Arduino Uno Q speaks ADB, the exact tool the rest of the Brutus stack already uses everywhere, so wiring it in feels familiar rather than exotic.

### Bring the reflex brain up in five moves

**Plug it in.** Connect the Uno Q to the Command PC over USB-C. This is the normal App Lab developer connection, so power over the PC port is fine. Run `adb devices` and the board shows up, because it speaks ADB, the same tool your Brutus stack already uses. You already have the muscle memory for this.

**Push the payload.** Copy the runtime and the model onto the board, both pre downloaded on your USB drive.

```bash
adb push llama-server /home/arduino/
adb push qwen2.5-0.5b-q4.gguf /home/arduino/
adb shell
chmod +x /home/arduino/llama-server
./llama-server -m qwen2.5-0.5b-q4.gguf --port 8081 -c 1024 -t 4
```

**Bridge it to the PC.** One command forwards the port so the PC can reach the board.

```bash
adb forward tcp:8081 tcp:8081
```

Your PC now reaches the board at `http://localhost:8081/v1`, the same OpenAI style API your code already speaks. Re run the forward after any replug, and drop it in a startup batch file so you never think about it. If the board also appears as a USB network adapter with its own IP, you can use that IP directly instead. Use whichever shows up first.

**Add the layer.** Clone your existing backend client, point it at `localhost:8081`, set `max_tokens: 60`, and prompt it: "You are Brutus's reflex brain. Answer in one short sentence." Keep four fixes so it behaves like the rest of the fleet:

* Failover logic lives on the Command PC, not on the machine you unplug.
* Prepend `[EMOTION:neutral]` to its replies so the face layer stays happy.
* Send it stripped context, since it is small and short of window.
* Rehearse the failover question so the handoff is smooth on stage.

**Make it boot proof.** Add a systemd unit on the board so llama-server starts the moment it gets power. Plug in, wait about a minute, and the layer simply exists.

---

## Compression, or how big models fit on small hardware

Big models do not fit on an NPU or a tiny board by themselves. Quantization is the trick: trade a little precision for a large drop in size, and the model runs where a full precision one never could. Here are the on device brains at full precision versus the quantized build that actually ships.

```
On device model footprint  (full precision vs the quantized build we run)

  Qwen3 4B        FP16    ████████████████████████   ~8.0 GB
  Snapdragon NPU  W4A16   █████████                  ~3.0 GB     2.7x smaller

  Gemma3 1B       FP16    ██████                     ~2.0 GB
  phone NPU       INT4    ██                         ~0.5 GB     ~4x smaller

  Qwen2.5 0.5B    FP16    ███                        ~1.0 GB
  Arduino Uno Q   Q4/Q5   █                          ~0.4 GB     ~2.5x smaller
```

| Model | Full precision | Quantized build | Shrink | Where it runs |
|:--|:--|:--|:--:|:--|
| Qwen3 4B | ~8.0 GB (FP16) | ~3.0 GiB (W4A16) | ~2.7x | Snapdragon X Elite NPU |
| Gemma3 1B | ~2.0 GB (FP16) | ~0.5 GB (INT4, approx.) | ~4x | Phone NPU |
| Qwen2.5 0.5B Instruct | ~1.0 GB (FP16) | ~0.4 GB (Q4 or Q5_K_M) | ~2.5x | Arduino Uno Q |

W4A16 keeps activations at sixteen bits while squeezing the weights to four, so the big model stays sharp. Q4 and Q5_K_M are GGUF weight mixes that keep a half billion parameter model under half a gigabyte, small enough to stay resident on the Uno Q.

---

## Efficiency, and how it stays fast

The design goal is simple. Do as much as possible on the device, reach for the cloud only when it truly helps, and never restart what you can keep warm.

| Property | How Brutus does it | Why it matters |
|:--|:--|:--|
| Model loading | Each brain loads once at boot and stays resident | No per request load cost, ever |
| Warm up | A throwaway generation and TTS synth at boot | The first request a judge triggers is already warm |
| NPU contention | The LLM runtime is isolated in its own process | Two accelerator runtimes never fight over the NPU |
| Reflex latency | A half billion parameter model with a 1024 token window on four threads | Short answers land with almost no wait |
| One audio track | Stays open for the whole session | No stop and start churn between voice chunks |
| Mic discipline | Mic stays open, chunks dropped while Brutus talks | No cost to restart recording every turn |
| Network | Core loop served on the LAN, no internet | Works on a plane, in a lab, behind a firewall |
| Privacy | Nothing on the core path leaves the device | No audio or text sent to a third party by default |
| Throughput | About 15 tokens per second for Qwen3 4B on the NPU | Comfortable for short spoken replies |

---

## How a turn actually flows

You speak into the hub. The audio streams to whichever brain you picked. The brain streams voice back, plus any tool calls it wants to run. The voice plays through a single native audio track, and at the same time the hub tells the robot how to move its mouth and face. Tools run on the hub and hand results back so the conversation keeps flowing. The reflex brain sits alongside, ready to ground or answer.

```
        You speak
           │
           ▼
     ┌───────────┐        camera / screen frames
     │  Mic PCM  │◄──────────────────────────────┐
     └─────┬─────┘   (dropped while Brutus talks) │
           │                                      │
           ▼                                      │
  ┌────────────────────────┐          ┌───────────┴────────┐
  │  The brain you picked   │◄────────►│  Vision + Screen   │
  │  Snapdragon Qwen3 4B    │          └────────────────────┘
  │  or cloud fallback      │
  └───────┬────────────────┘
          │                     ┌──────────────────────────┐
          │   grounding check   │  Arduino Uno Q reflex     │
          ├────────────────────►│  Qwen2.5 0.5B, one line   │
          │◄────────────────────│  softens hallucinations   │
          │                     └──────────────────────────┘
    ┌─────┴───────────────┐
    ▼                     ▼
┌──────────┐        ┌───────────────┐
│  Voice   │        │  Tool calls   │
│  stream  │        │  (many)       │
└────┬─────┘        └───────────────┘
     │
 ┌───┴───────────────────────────┐
 ▼                               ▼
┌───────────────┐        ┌──────────────────────────┐
│  Speaker      │        │  Robots over BLE          │
│  (AudioTrack) │        │  mouth, eyes, mood, LED   │
└───────────────┘        └──────────────────────────┘
```

You flip the voice engine under **Settings, then API Keys, then Voice Uplink**. A small status pill shows the live state of the on device loop as it runs: listening, thinking, or speaking.

---

## Brutus next to a typical cloud assistant

| Capability | Brutus | Typical cloud assistant |
|:--|:--:|:--:|
| Works with no internet | yes | no |
| Core reasoning runs on the edge | yes | no |
| A tiny reflex model checks for hallucinations | yes | no |
| Audio leaves your device | no | yes |
| Cost per query | zero on the edge | metered |
| Latency path | your own LAN and USB | data center round trip |
| A physical face that lip syncs | yes | no |
| Model you can see, swap, and host | yes | no |
| Data used to train someone else | no | often |

---

## The robots

Brutus has two physical robots, driven by the phone over Bluetooth Low Energy.

<div align="center">
<table>
<tr>
<td align="center"><img src="assets/WhatsApp%20Image%202026-06-11%20at%2004.16.02.jpeg" width="360" alt="The finished Brutus robot head with glowing eyes"/><br/><sub>The finished robot head</sub></td>
<td align="center"><img src="assets/PCB%20Design.png" width="360" alt="Custom PCB for the robot"/><br/><sub>The custom PCB</sub></td>
</tr>
</table>
</div>

* **Robot one, the face.** Four SG90 servos move the eyes, eyelids, and mouth, plus an LED for mood and a sound sensor for idle lip flap, all run by an Arduino Uno with an HM 10 Bluetooth module. When Brutus speaks, the mouth moves with the voice and the expression follows the tone of the reply.
* **Robot two, the v2 build.** A larger build that splits a body controller and an audio controller across two ESP32 boards and adds an ESP32-CAM for eyes that stream the robot's view into the vision model.

The hub and the phone talk to the face over a BLE serial characteristic with a compact text protocol: set an expression with intensity, move the mouth for lip sync, look at a point, blink, play one of twenty animations, or set the LED. The full protocol, the parts list, and the firmware live in the [mobile app repository](https://github.com/Aditya060806/Brutus-app), which owns the robot layer.

---

## It in action

<div align="center">
<table>
<tr>
<td align="center"><img src="assets/Screenshot%202026-07-19%20115207.png" width="440" alt="Brutus hub in action"/></td>
<td align="center"><img src="assets/Screenshot%202026-07-19%20115234.png" width="440" alt="Brutus hub in action"/></td>
</tr>
</table>
</div>

---

## Setup from scratch

There are four pieces. You can run and demo the hub alone, then add the brains and the robots as you go.

### 1. The Command PC hub (this repository)

Prerequisites: **Node.js 18 or newer** (20 LTS is a good pick) on **Windows 10 or 11**.

```bash
git clone https://github.com/Aditya060806/Brutus.git
cd Brutus
npm install
npm run dev
```

That is the whole setup for the cockpit. `npm run dev` launches it in development. Build a Windows installer with:

```bash
npm run build:win
```

### 2. Point the hub at a brain

Open **Settings, then API Keys, then Brain Node** and set the URL, for example `http://<device ip>:8080` for the Snapdragon node on the LAN. Press **Save and Connect** and the badge tells you if the node is live. Prefer environment variables? Create a `.env`:

```env
BRUTUS_BRAIN_URL="http://127.0.0.1:8080"   # where the Snapdragon Brain Node lives
BRUTUS_API_KEY=""                          # only if the node is locked with a token
GEMINI_API_KEY="your_key_here"             # optional cloud fallback and UI generation
```

Precedence is simple: the environment variable wins, then your saved setting, then the built in default.

### 3. The Snapdragon Brain Node

Clone and run the companion server. On any laptop you can run it in mock mode to develop against the exact HTTP contract with no NPU. On the Snapdragon X Elite, one command brings up the real models.

```bash
git clone https://github.com/Aditya060806/Ai-Qualcom-backend.git
```

Full instructions, including the GenieX and Qwen3 4B steps, live in that repository's README.

### 4. The Arduino Uno Q reflex brain

Follow the five moves in [the reflex brain section above](#the-arduino-uno-q-reflex-brain): plug in over USB-C, `adb push` llama-server and the GGUF, run it on port 8081, `adb forward`, then point a small client at `http://localhost:8081/v1`.

### 5. The mobile app

The Flutter app carries the same brains in your pocket and owns the robot control. Setup lives in the [Brutus-app repository](https://github.com/Aditya060806/Brutus-app).

---

## Run and usage

* Launch the hub with `npm run dev`, connect a Brain Node, and press to talk. Watch the transcript and the animated face react.
* Ask it to see: point the camera or share the screen and ask what is there.
* Ask it to do: search the web, run deep research, answer over your own documents, draft an email, build a quick site, control an Android phone over ADB.
* Switch the voice engine any time in Settings between the on device edge loop and the cloud fallback, and watch the status pill.
* Bring up the Arduino Uno Q reflex brain to keep answers grounded and to keep the conversation alive when the big brain or a web API is busy.
* Pull the network to prove the point: with the Snapdragon node and the reflex brain up, Brutus keeps talking with nothing leaving the room.

---

## Tests and testing instructions

* **Type check the hub:** `npm run typecheck` runs the TypeScript checks for both the Node and web sides.
* **Build the hub:** `npm run build` type checks then bundles the whole app. A clean build is the fastest proof the cockpit is wired correctly.
* **Brain Node acceptance gate:** in the Brain Node repository, `python scripts\acceptance_test.py --base http://127.0.0.1:8080` checks health, does a real WAV round trip through text to speech and back through speech to text, streams a chat completion, and prints a pass or fail.
* **Reflex brain reachability:** with the Uno Q forwarded, `curl http://localhost:8081/v1/models` confirms the board is serving.
* **Brain Node health from the LAN:** `curl http://<device ip>:8080/health` reports `ok` when all three models loaded, or `degraded` if one did not while the rest keep serving.

---

## Platforms

* **Command PC hub:** Windows 10 and Windows 11. Packaged as a Windows installer with `npm run build:win`.
* **Snapdragon Brain Node:** Windows 11 on Snapdragon X Elite (ARM64) for real inference, or mock mode on any operating system with Python 3.12.
* **Reflex brain:** Arduino Uno Q, reached over ADB from the Command PC.
* **Mobile app:** Android 8 or newer.

The application installs and runs from the instructions above and behaves as described: a spoken turn is transcribed, reasoned about, grounded, and spoken back, with the core loop on the edge.

---

## Repository map

```
Brutus (this repo, the Command PC hub)
├── src/
│   ├── main/                         Electron main process (Node)
│   │   ├── services/llm-provider.ts   Brain Node client + cloud fallback + config
│   │   ├── services/text-chat.ts      chat routed through the provider
│   │   ├── logic/                     tool handlers (files, OS, ADB, memory)
│   │   ├── auto/                      website builder, widget manager
│   │   └── security/                  PIN vault + settings store
│   ├── preload/                       context isolation and the IPC allowlist
│   └── renderer/                      React 19 front end
│       └── src/
│           ├── services/Brutus-voice-ai.ts   both voice engines (edge + cloud)
│           ├── components/BrutusEyes/         the animated face
│           ├── components/EdgeStatusChip.tsx  the live status pill
│           └── views/                          Dashboard, Settings, Notes, Phone
├── assets/                            images, icons, Arduino firmware
└── package.json

Ai-Qualcom-backend   the Snapdragon Brain Node (Qwen3 4B, Whisper, Kokoro)
Brutus-app           the Flutter mobile app and the robot firmware
```

---

## Notes

* **The reflex brain is about trust, not raw power.** A half billion parameter model will not out think Qwen3 4B, and it is not meant to. It is a cheap, always on grounding and failover layer, and its whole value is that it is small enough to call freely and local enough to never disappear.
* **Graceful degradation everywhere.** If the Snapdragon node loses a model, it reports `degraded` and keeps serving the rest. If a web API times out, the reflex brain answers. If the network is gone, the edge loop carries on.
* **One contract, many brains.** Every brain emits the same event shapes and the same `[EMOTION:xxx]` tag, so the face, the tools, and the robot never care which brain is running. That is what lets the Uno Q or a phone model stand in for a cloud model with no code change.
* **The port forward is not permanent.** Re run `adb forward tcp:8081 tcp:8081` after any replug, or drop it in a startup batch file. If the board shows a USB network IP, use that instead.
* **Security.** Keys live in the OS secure storage behind a PIN vault. Nothing phones home. The only path off the device is the optional cloud fallback, and it is clearly labelled.

---

## References

* Qwen3 4B: <https://huggingface.co/Qwen/Qwen3-4B>
* Qwen2.5 0.5B Instruct: <https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct>
* Gemma: <https://ai.google.dev/gemma>
* llama.cpp: <https://github.com/ggml-org/llama.cpp>
* Qualcomm AI Hub: <https://aihub.qualcomm.com>
* GenieX CLI: <https://geniex.aihub.qualcomm.com/en/run/cli/install>
* ONNX Runtime QNN execution provider: <https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html>
* OpenAI Whisper: <https://github.com/openai/whisper>
* Kokoro ONNX: <https://github.com/thewh1teagle/kokoro-onnx>
* Gemini API: <https://ai.google.dev>
* Groq: <https://groq.com>
* Sarvam AI: <https://www.sarvam.ai>
* Arduino Uno Q and App Lab: <https://www.arduino.cc>
* Electron: <https://www.electronjs.org>  ·  React: <https://react.dev>

A note on the code itself: the source is documented where it matters. The provider that routes and falls back between brains, the voice engine that runs both the cloud and edge loops, and the Brain Node boot sequence all carry comments that explain the why, not just the what.

---

## License

MIT. See [LICENSE](LICENSE). Chosen with help from <https://choosealicense.com>, because it is permissive, short, and lets anyone download, run, and build on Brutus.

<div align="center">
<br/>
<b>Brutus. Your voice, your machine, your models. From a Snapdragon NPU down to an Arduino, nothing has to leave the room.</b>
</div>
