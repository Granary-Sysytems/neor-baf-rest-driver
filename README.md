# NEOR NW 500 REST driver (BAF)

Локальний Node.js REST-сервіс для документ-камери **NEOR NW 500** на macOS через **UVC + FFmpeg (AVFoundation)**. Опційна обрізка/вирівнювання документа — через **OpenCV (Python)**. Vendor Windows SDK (DLL/OCX) на Mac не підключається.

Local Node.js REST service for the **NEOR NW 500** on macOS via **UVC + FFmpeg**, with optional **OpenCV** document auto-crop / perspective deskew.

## Requirements

- macOS with Camera permission for Terminal / Node
- Node.js 20+
- [FFmpeg](https://ffmpeg.org/) (`brew install ffmpeg`)
- Python 3 venv with OpenCV (for `autoCrop` / `deskew` only):
  ```bash
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  ```
- NEOR NW 500 connected over USB (USB-C adapter OK)

## Config

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | HTTP port |
| `DEVICE_SERIAL` | `DK50P30000422` | Canonical serial used by API clients |
| `DEVICE_USB_SERIAL` | `SN0001` | USB `iSerial` if it differs from the label |
| `DEVICE_NAME_MATCH` | `USB` | Substring match on AVFoundation name |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg |
| `CAPTURE_DEFAULT_WIDTH` | `2560` | Preferred width (practical max that captures reliably) |
| `CAPTURE_DEFAULT_HEIGHT` | `1440` | Preferred height |
| `CAPTURE_FRAMERATE` | `10` | Capture fps |
| `CAPTURE_TIMEOUT_MS` | `30000` | Kill hung ffmpeg (often Camera TCC) |
| `CAPTURE_WARMUP_MS` | `1800` | Discard frames so UVC auto-exposure can converge before keeping one |
| `DOC_CROP_PYTHON` | `.venv/bin/python` | Python with OpenCV for post-process |
| `DOC_CROP_SCRIPT` | `scripts/doc_crop.py` | Crop/deskew script |

> **Note:** Label serial `DK50P30000422` vs USB `SN0001` / AVFoundation `USB-камера` — API uses the label and maps via config.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm install
npm run build
npm start
```

Service listens on `http://127.0.0.1:8787`.

### macOS Camera permission

System Settings → Privacy & Security → Camera → allow **Terminal** (or the app that launches Node).

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Local test UI (browser) |
| `GET` | `/health` | Liveness |
| `GET` | `/api/v1/devices` | List UVC / AVFoundation cameras |
| `GET` | `/api/v1/devices/{serial}` | One device |
| `POST` | `/api/v1/devices/{serial}/capture` | Still frame; optional `warmupMs`, `autoCrop` / `deskew` / `autoLevel` (crop defaults **false**; low-confidence crop falls back to original) |
| `POST` | `/api/v1/devices/{serial}/light` | LED/lamp — on macOS returns **501** `LIGHT_UNSUPPORTED` |
| `GET` | `/openapi.json` | OpenAPI 3 |

Errors:

```json
{ "error": { "code": "DEVICE_NOT_FOUND", "message": "..." } }
```

Open the test page: [http://127.0.0.1:8787/](http://127.0.0.1:8787/)

### curl examples

```bash
curl -s http://127.0.0.1:8787/health | jq
curl -s http://127.0.0.1:8787/api/v1/devices | jq

# plain capture (default ~1.8s AE warmup)
curl -s -X POST http://127.0.0.1:8787/api/v1/devices/DK50P30000422/capture \
  -H 'Content-Type: application/json' \
  -d '{"format":"jpeg"}' \
  -o capture.jpg

# first-frame vs warmed (set warmupMs:0 vs 1800) — room LED/lamp helps; AE still needs settle
# auto-crop + perspective deskew (OpenCV; may return applied=false + reason)
curl -s -X POST http://127.0.0.1:8787/api/v1/devices/DK50P30000422/capture \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{"format":"jpeg","autoCrop":true,"deskew":true}' | jq '.width,.height,.capture,.postprocess'

# light (macOS → 501)
curl -s -X POST http://127.0.0.1:8787/api/v1/devices/DK50P30000422/light \
  -H 'Content-Type: application/json' \
  -d '{"on":true}' | jq
```

## Camera light

**Not controllable on macOS UVC** for this unit (no LED/torch/XU control found via ffmpeg / IOKit / SPCamera). Vendor `Set_Light_A` / `Set_Light_B` exist only in Windows OCX (`Cam_OcxTwo`). Endpoint returns `501` / `LIGHT_UNSUPPORTED` so clients fail clearly.

## Observed modes (this NW 500)

`3264x2448` not supported; `2592x1944` hangs; practical max **2560×1440@10fps**.
