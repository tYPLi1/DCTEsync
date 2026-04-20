# Telegram ↔ Discord Bridge

A self-hosted bridge bot that syncs Telegram groups/channels with Discord channels in both directions, with media forwarding, replies, reactions, optional translation, and a web dashboard.

---

## Features

- **Bidirectional sync** (Telegram ↔ Discord)
- **Multiple independent pairs** (many TG chats to many Discord channels)
- **Telegram groups, supergroups, channels, and forum topics**
- **Reply sync** in both directions (via persistent message mapping)
- **Forwarded message sync** from Telegram → Discord (original sender preserved)
- **Reaction sync** (Unicode emoji) in both directions
- **Deletion sync** from Discord → Telegram
- **Per-pair media toggles** per direction
- **Per-pair bot-message sync** per direction + global/per-pair whitelist
- **Translation per pair + per direction** (optional, off by default)
- **Translation fallback chain** with timeout + exhausted-provider tracking
- **Premium/Standard translation tiers** (global + per-pair overrides)
- **DeepL multi-key support** (up to 20 keys) with exhaustion handling
- **Usage tracking in dashboard** for Microsoft, LibreTranslate, DeepL
- **Auto-detect recent Telegram chats** for quick pair setup
- **Role display tags** from Discord in Telegram output (optional)
- **Persistent logs** with dashboard log viewer/clear endpoint
- **Docker / docker-compose / LXC(systemd) friendly**

---

## Media Support

### Telegram → Discord

Supported: text, photo, video, audio, voice, document, sticker (static/video), animation/GIF, video note, location, poll.

- Animated Telegram stickers (TGS) are forwarded as text (`[Sticker 😄]`)
- File ceiling for this direction is effectively **20 MB** (`Telegram getFile` limit)

### Discord → Telegram

Supported: text + attachments (image/video/audio/document categories).

- Category mapping is MIME-based
- File download ceiling for this direction is **25 MB** (Discord-side limit in the bridge)

All media types can be toggled per pair and per direction in the dashboard.

---

## Translation

Translation is optional and disabled by default per pair.

### Providers

- `anthropic` (Claude Haiku)
- `openai` (GPT-4o-mini)
- `ollama` (self-hosted)
- `google` (Google Translate API)
- `deepl`
- `libretranslate` (self-hosted/public)
- `microsoft` (Azure Translator)

### Fallback chain

- Primary provider comes from pair config
- Global fallback chain is applied after primary
- Supports special entry `none` (= stop and forward original text)
- Provider calls are timeout-protected (`TRANSLATION_TIMEOUT_MS`, default `15000`)
- Quota/exhaustion is tracked and exhausted providers are skipped until reset

### Premium/Standard tiers

- Global tier config (provider + fallback chain per tier)
- Global premium access lists (Discord role IDs, Telegram user IDs)
- Per-pair overrides for both tier config and premium access

### Usage tracking

- **Microsoft**: local character tracking with monthly UTC reset (2,000,000 default limit)
- **LibreTranslate**: local chars + request counters
- **DeepL**: live `/v2/usage` per key + key exhaustion state

---

## Quick Start

### Option A: Docker Compose

```bash
git clone https://github.com/tYPLi1/DCTEsync.git
cd DCTEsync
cp .env.example .env
# edit .env (at least TELEGRAM_TOKEN + DISCORD_TOKEN)
docker compose up -d
```

Dashboard: `http://localhost:3000` (or your configured `PORT`).

### Option B: Local/LXC setup script

```bash
bash setup.sh
```

`setup.sh` will:

- ask for required bot tokens
- suggest a free dashboard port
- ask optional translation provider settings
- ask config storage path
- optionally install npm dependencies
- optionally install + enable `tg-bridge.service` (systemd)

---

## Updating

### LXC / local systemd

```bash
bash update.sh
```

`update.sh` handles:

1. optional auth flow (if required)
2. stash local changes
3. fetch/pull target branch
4. `npm install --omit=dev`
5. `npm update --omit=dev`
6. refresh systemd unit (`tg-bridge.service`) if present
7. ensure service autostart is enabled
8. restart service
9. restore stashed changes

### Docker

```bash
git pull
docker compose up -d --build
```

---

## Dashboard capabilities

- Pair CRUD (`/api/pairs`)
- Pair translation settings (`/api/pairs/:id/translation`)
- Pair media sync settings (`/api/pairs/:id/media-sync`)
- Pair bot sync settings (`/api/pairs/:id/bot-sync`)
- Pair message-map limit (`/api/pairs/:id/msg-map-limit`, 10–200)
- Pair display roles (`/api/pairs/:id/display-roles`)
- Global bot whitelist (`/api/bot-whitelist`)
- Translation chain + exhausted reset (`/api/translation-chain*`)
- Translation tiers + premium access (`/api/translation-tiers`, `/api/premium-access`)
- Pair-level tier/premium overrides
- DeepL key management + usage endpoints
- Microsoft/Libre usage endpoints
- Telegram chat auto-detect endpoint (`/api/telegram-chats`)
- Log read/clear endpoints (`/api/logs`)
- Runtime `.env` update endpoint (`/api/config`)

---

## Environment Variables

See `.env.example` for full list.

### Required

- `TELEGRAM_TOKEN`
- `DISCORD_TOKEN`

### Common

- `PORT` (default `3000`)
- `DATA_FILE` (default runtime: `./data/config.json`; docker example uses `/app/data/config.json`)
- `LOG_DIR` (default `./data`)
- `TRANSLATION_TIMEOUT_MS` (default `15000`)

### Translation provider variables

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `GOOGLE_TRANSLATE_API_KEY`
- `DEEPL_API_KEY`
- `LIBRETRANSLATE_URL`
- `LIBRETRANSLATE_API_KEY`
- `MICROSOFT_TRANSLATOR_KEY`
- `MICROSOFT_TRANSLATOR_REGION`

---

## Systemd service

Setup/update scripts use service name:

- `tg-bridge.service`

Useful commands:

```bash
sudo systemctl status tg-bridge
sudo journalctl -u tg-bridge -f
sudo systemctl restart tg-bridge
sudo systemctl stop tg-bridge
```

---

## Project Structure

```text
.
├── src/
│   ├── bridge.js
│   ├── telegram.js
│   ├── discord.js
│   ├── media.js
│   ├── translation.js
│   ├── store.js
│   ├── messageMap.js
│   ├── web.js
│   └── logger.js
├── public/
│   └── index.html
├── setup.sh
├── update.sh
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Known limitations

- Telegram cannot impersonate Discord users (messages are sent by bot as `[Username]: ...`)
- Telegram animated stickers (TGS) are not renderable on Discord (text fallback)
- Discord custom guild emoji reactions are not mirrored to Telegram
- Telegram custom/animated reactions are ignored (Unicode emoji only)
- Telegram does not provide bot-side delete events, so **TG → DC delete sync is not possible**
- **Discord → Telegram forwarded messages**: Discord has no native "forward" feature; messages can only be copied/reposted without preserving original sender metadata
