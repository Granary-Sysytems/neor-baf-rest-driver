# NEOR NW 500 REST driver (BAF)

Локальний Node.js REST-сервіс для документ-камери **NEOR NW 500** на macOS через **UVC + FFmpeg (AVFoundation)**. Публічного vendor SDK немає — драйвер працює як стандартна USB-відеокамера.

Local Node.js REST service for the **NEOR NW 500** document camera on macOS via **UVC + FFmpeg (AVFoundation)**.

## Requirements

- macOS with Camera permission for Terminal / Node
- Node.js 20+
- [FFmpeg](https://ffmpeg.org/) with AVFoundation (`brew install ffmpeg`)
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

Copy `.env.example` for reference (process env is read directly; no dotenv required).

> **Note:** On the tested unit the **label** serial is `DK50P30000422`, while USB reports `SN0001` and AVFoundation shows `USB-камера` (index `1`). The API exposes the label serial and maps the USB/UVC device to it.

## Run

```bash
npm install
npm run build
npm start
# or: npm run dev
```

Service listens on `http://127.0.0.1:8787`.

### macOS Camera permission

System Settings → Privacy & Security → Camera → allow **Terminal** (or the app that launches Node). Without this, `ffmpeg` / capture may hang until timeout.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness |
| `GET` | `/api/v1/devices` | List UVC / AVFoundation cameras |
| `GET` | `/api/v1/devices/{serial}` | One device |
| `POST` | `/api/v1/devices/{serial}/capture` | Still frame (`format=jpeg\|png`, optional `width`/`height`) |
| `GET` | `/openapi.json` | OpenAPI 3 |

Errors always look like:

```json
{ "error": { "code": "DEVICE_NOT_FOUND", "message": "..." } }
```

### curl examples

```bash
curl -s http://127.0.0.1:8787/health | jq

curl -s http://127.0.0.1:8787/api/v1/devices | jq

curl -s http://127.0.0.1:8787/api/v1/devices/DK50P30000422 | jq

# JPEG bytes
curl -s -X POST http://127.0.0.1:8787/api/v1/devices/DK50P30000422/capture \
  -H 'Content-Type: application/json' \
  -d '{"format":"jpeg"}' \
  -o capture.jpg

# JSON + base64
curl -s -X POST http://127.0.0.1:8787/api/v1/devices/DK50P30000422/capture \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{"format":"png","width":1920,"height":1080}' | jq '.width,.height,.format'
```

## Observed modes (this NW 500)

`3264x2448` is **not** advertised by AVFoundation. The device lists up to **2592×1944@10fps**, but that mode hangs in practice; reliable capture tops out at **2560×1440@10fps**, then 1920×1080, 1280×720, 640×480.

USB `iSerial` on the tested unit is `SN0001` (not the label `DK50P30000422`). The API uses the label serial and maps via `DEVICE_USB_SERIAL` / name / vendor id.
