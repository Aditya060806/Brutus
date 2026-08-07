# Bundled models

This directory is **build output**, not source. It is empty in git and filled by:

```bash
npm run fetch:models
```

`electron-builder.yml` copies it to `resources/models` inside the installed app,
where `bundledModelsDir()` in `src/main/services/voice/model-store.ts` reads it.

## Why these ship inside the installer

On-device voice is a privacy feature. If the speech models were downloaded on
first use, the feature would need a working internet connection once before it
could ever be used offline — which is a strange thing to ask of something whose
entire promise is that it does not need the network.

So the two speech models (~200 MB total) are bundled and work from first launch.

## Why the language model does *not* ship here

It is roughly 1 GB, and most people will never turn it on. It downloads on
demand into `userData/models` instead, with a progress bar and a resumable
transfer. Bundling it would make every user pay 1 GB for an optional feature.

## Contents after `npm run fetch:models`

| Directory | What | Size |
| --- | --- | --- |
| `Xenova/whisper-base.en` | Speech recognition (ONNX, quantised) | ~145 MB |
| *(TTS model — see Phase 3)* | Speech synthesis | ~90 MB |

Everything here is gitignored except this README.
