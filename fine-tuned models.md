# Multilingual Bridge — Real-Time Multilingual Communication Platform

> AI-powered real-time translation between 200+ languages including underrepresented ones, with **cultural context intelligence**, **code-switching detection**, and **fine-tuned models**.

---

## Architecture

```
                         MULTILINGUAL BRIDGE
    ┌─────────────────────────────────────────────────────────┐
    │                    React Frontend                        │
    │   [Text Channel]  [Voice Channel]  [Cultural Context]   │
    │        ↕ REST API / WebSocket (real-time)                │
    ├─────────────────────────────────────────────────────────┤
    │                  FastAPI Backend                          │
    │                                                          │
    │  ┌──────────┐  ┌───────────┐  ┌──────────┐             │
    │  │ Whisper   │  │  NLLB-200 │  │ MMS-TTS  │             │
    │  │ ASR       │→ │ Translate │→ │ Speech   │             │
    │  │ (LoRA)   │  │ (LoRA)    │  │ (1100+)  │             │
    │  └──────────┘  └───────────┘  └──────────┘             │
    │       ↓              ↓                                   │
    │  ┌──────────────────────────────────────┐               │
    │  │     Code-Switching Detector          │               │
    │  │  (Script + Token + langdetect)       │               │
    │  └──────────────────────────────────────┘               │
    │       ↓                                                  │
    │  ┌──────────────────────────────────────┐               │
    │  │  Cultural Context Engine (BLOOMZ)    │               │
    │  │  - Formality detection               │               │
    │  │  - Idiom/proverb identification      │               │
    │  │  - Cultural misunderstanding flags    │               │
    │  └──────────────────────────────────────┘               │
    └─────────────────────────────────────────────────────────┘
```

## What Makes This Different

| Feature | Typical Projects | **Our Project** |
|---------|-----------------|-----------------|
| Translation | Call Google API | **Fine-tuned NLLB-200 with LoRA** on low-resource pairs |
| Speech | Use cloud STT | **Fine-tuned Whisper** for accented/dialectal speech |
| Languages | 10-20 major | **200 translation + 1100 TTS** including Bhojpuri, Yoruba, Maithili |
| Code-switching | Not handled | **Detects & translates mixed-language input** (Hinglish, Spanglish) |
| Cultural context | None | **Fine-tuned BLOOMZ** provides idiom detection, formality, cultural notes |
| Models | API calls only | **3 locally fine-tuned models** with before/after metrics |

## Models Used

| Component | Model | Size | Languages | Fine-tuned? |
|-----------|-------|------|-----------|-------------|
| Translation | `facebook/nllb-200-distilled-600M` | 600MB | 200 | Yes (LoRA) |
| ASR | `openai/whisper-small` | 244MB | 99 | Yes (LoRA) |
| TTS | `facebook/mms-tts-*` | ~30MB each | 1100+ | No (already great) |
| Cultural LLM | `bigscience/bloomz-560m` | 560MB | 46 | Yes (LoRA) |

## Datasets

| Dataset | Use | Languages |
|---------|-----|-----------|
| `facebook/flores` (FLORES-200) | Translation eval & training | 200 |
| `mozilla-foundation/common_voice_16_0` | ASR fine-tuning | 100+ |
| Custom cultural dataset | Cultural context training | 15+ |

## Quick Start

### 1. Install Python Dependencies
```bash
cd ml
pip install -r requirements.txt
```

### 2. Start the Backend Server
```bash
python server.py
# Server runs on http://localhost:8642
```

### 3. Start the Frontend
```bash
cd frontend
npm install
npm run dev
# Frontend runs on http://localhost:3100
```

### 4. Fine-Tune Models (on Google Colab)

Upload these to Colab and run:
- `finetune/finetune_nllb_lora.py` — Fine-tune NLLB translation (Bhojpuri/Yoruba/Swahili)
- `finetune/finetune_whisper_lora.py` — Fine-tune Whisper ASR
- `finetune/finetune_cultural_llm.py` — Fine-tune cultural context engine
- `notebooks/finetune_nllb_lora.ipynb` — Jupyter notebook version with step-by-step cells

### 5. Evaluate
```bash
python evaluate_models.py --task all
python evaluate_models.py --task translation --pair bhojpuri_english
python evaluate_models.py --task code_switching
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/translate` | POST | Translate text with cultural annotations |
| `/api/transcribe` | POST | Speech-to-text (audio file) |
| `/api/synthesize` | POST | Text-to-speech (returns WAV) |
| `/api/code-switch/analyze` | POST | Detect code-switching in text |
| `/api/cultural/annotate` | POST | Get cultural annotations |
| `/api/pipeline/text-to-text` | POST | Full pipeline: text → translate → cultural |
| `/api/pipeline/speech-to-text` | POST | Audio → ASR → translate → cultural |
| `/api/pipeline/speech-to-speech` | POST | Audio → ASR → translate → cultural → TTS |
| `/ws/realtime` | WebSocket | Real-time streaming translation |
| `/api/languages` | GET | List all supported languages |

## Project Structure

```
ml/
├── config.py                  # Central configuration (models, languages, settings)
├── server.py                  # FastAPI backend server
├── evaluate_models.py         # Evaluation suite (BLEU, WER, accuracy)
├── requirements.txt           # Python dependencies
├── services/
│   ├── translator.py          # NLLB-200 translation service
│   ├── speech_recognition.py  # Whisper ASR service
│   ├── text_to_speech.py      # MMS-TTS service (1100+ languages)
│   ├── cultural_context.py    # Cultural annotation engine
│   ├── code_switching.py      # Code-switching detection
│   └── pipeline.py            # End-to-end orchestrator
├── finetune/
│   ├── finetune_nllb_lora.py       # NLLB LoRA fine-tuning script
│   ├── finetune_whisper_lora.py    # Whisper LoRA fine-tuning script
│   └── finetune_cultural_llm.py    # Cultural LLM fine-tuning script
├── notebooks/
│   └── finetune_nllb_lora.ipynb    # Jupyter notebook for NLLB fine-tuning
└── frontend/
    ├── src/App.jsx            # React UI with text/voice channels
    └── ...                    # Vite + React + TailwindCSS
```

## Innovation Highlights

### 1. Code-Switching Detection
Most real speakers **mix languages**. Our system detects and properly handles:
- **Hinglish**: "Yaar, mujhe actually bahut tension ho rahi hai"
- **Script-mixing**: "मैं tomorrow school जाऊंगा"
- Segments text by language, translates each part correctly

### 2. Cultural Context Engine
Goes beyond literal translation to provide:
- **Formality detection**: Hindi आप/तुम/तू distinction → English loses this
- **Idiom identification**: "दाल में काला" ≠ "black in lentils" → "something fishy"
- **Cultural misunderstanding flags**: Greeting customs, honorific systems
- **Proverb equivalents**: Yoruba/Swahili proverbs → English cultural equivalents

### 3. Fine-Tuned on Underrepresented Languages
Not just API calls — actual model-level improvements:
- LoRA adapters trained on Bhojpuri, Yoruba, Swahili pairs
- Before/after BLEU score comparison proves improvement
- Adapters are tiny (~2MB) and can be shared on HuggingFace Hub

## Tech Stack
- **Backend**: Python, FastAPI, PyTorch, HuggingFace Transformers
- **Fine-tuning**: PEFT/LoRA, bitsandbytes (4-bit quantization)
- **Frontend**: React 18, Vite, TailwindCSS, Lucide Icons
- **Evaluation**: SacreBLEU, JiWER, HuggingFace Evaluate
- **Models**: NLLB-200, Whisper, MMS-TTS, BLOOMZ (all open-source, HuggingFace)
