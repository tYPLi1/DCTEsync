# Telegram ↔ Discord Bridge

A self-hosted bridge bot that syncs messages between Telegram groups and Discord channels — in both directions, in real time, with full media support and optional AI-powered translation.

---

## Features

- **Multi-pair sync** — link as many Telegram groups ↔ Discord channels as you want, each pair is independent
- **Telegram → Discord** — messages appear with the sender's Telegram name and profile picture (via Discord webhook), looks completely native
- **Discord → Telegram** — messages are forwarded as `[Username]: text` or `[Username]:` + media
- **Full media support** — photos, videos, audio, voice, documents, stickers, GIFs, video notes, locations, polls
- **Per-type media toggles** — enable/disable each media type independently per pair and per direction in the dashboard
- **Loop prevention** — webhook and bot messages are automatically ignored on both sides
- **Web dashboard** — manage all pairs, translation and media settings at `http://your-host:PORT`
- **AI translation** — 7 providers, per pair, per direction, disabled by default
- **Docker + LXC ready** — works in Docker, docker-compose, or directly in a Proxmox LXC container

---

## Media Support

### Telegram → Discord

| Type | Forwarded as |
|---|---|
| Photos | Image attachment |
| Videos | Video attachment |
| Audio files | Audio attachment |
| Voice messages | Audio attachment (OGG) |
| Documents / files | File attachment |
| Stickers (static WebP) | Image attachment |
| Stickers (video WebM) | Video attachment |
| Stickers (animated TGS) | Text: `[Sticker 😄]` |
| Animations / GIFs | Video attachment |
| Video notes (round) | Video attachment |
| Locations | Text: 📍 Google Maps link |
| Polls | Formatted text with options |

### Discord → Telegram

| Attachment type | Forwarded as |
|---|---|
| Images (jpg, png, webp…) | Telegram photo |
| GIFs | Telegram animation |
| Videos (mp4, webm…) | Telegram video |
| Voice (ogg/oga) | Telegram voice message |
| Other audio | Telegram audio |
| Documents / other files | Telegram document |

> Files larger than **25 MB** cannot be uploaded to Discord webhooks.
> Files larger than **20 MB** cannot be downloaded via the Telegram Bot API.
> Oversized files are replaced with a text notice.

Each type can be toggled on/off **per pair** and **per direction** in the dashboard — no restart needed.

---

## Translation Providers

Translation is **disabled by default**. You can enable it per pair and per direction (TG→DC and DC→TG independently) in the dashboard.

| Provider | Type | Needs Key | Self-hosted |
|---|---|---|---|
| Anthropic (Claude Haiku) | AI model | `ANTHROPIC_API_KEY` | No |
| OpenAI (GPT-4o-mini) | AI model | `OPENAI_API_KEY` | No |
| Ollama | Local AI model | — | **Yes** |
| Google Translate | Translation API | `GOOGLE_TRANSLATE_API_KEY` | No |
| DeepL | Translation API | `DEEPL_API_KEY` (free tier available) | No |
| LibreTranslate | Translation API | — (optional) | **Yes** |
| Microsoft Translator | Translation API | `MICROSOFT_TRANSLATOR_KEY` | No |

---

## Quick Start

### Option A — Docker Compose

```bash
git clone https://github.com/typli1/dctesync
cd dctesync
cp .env.example .env
nano .env          # fill in TELEGRAM_TOKEN and DISCORD_TOKEN
docker compose up -d
```

Dashboard: `http://localhost:3000`

---

### Option B — Proxmox LXC (recommended for self-hosting)

**1. Create the CT**

In Proxmox: create a Debian 12 or Ubuntu 24.04 LXC container. 512 MB RAM is enough.

**2. Install Node.js & clone**

```bash
apt update && apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

git clone https://github.com/typli1/dctesync /opt/bridge
cd /opt/bridge
```

**3. Run the interactive setup**

```bash
bash setup.sh
```

The script will ask for:

| Prompt | Required |
|---|---|
| Telegram Bot Token | Yes |
| Discord Bot Token | Yes |
| Dashboard port | No (default: 3000) |
| Anthropic / OpenAI / Ollama | No |
| Google / DeepL / LibreTranslate / Microsoft | No |
| Config file path | No (default: `./data/config.json`) |

It then optionally installs dependencies and sets up a **systemd auto-start service**.

---

## Getting Your Tokens

### Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token → `TELEGRAM_TOKEN`
3. Add the bot to your group and make it an **admin** (so it can read messages)
4. Get the group's chat ID: add the bot, send a message, then call:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Look for `"chat":{"id": -100xxxxxxxxx}` — that's your `telegramChatId`

### Discord Bot

1. Go to [discord.com/developers](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy → `DISCORD_TOKEN`
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 → URL Generator → select `bot` + permissions: `Read Messages`, `Send Messages`
5. Invite the bot to your server via the generated URL

### Discord Webhook

1. Open the Discord channel you want to bridge
2. Channel Settings → Integrations → Webhooks → New Webhook
3. Copy the webhook URL → use it in the dashboard when adding a pair

---

## Dashboard

Open `http://your-host:PORT` after starting the bridge.

**Add a pair:**
- Enter a label (optional), Telegram Chat ID, Discord Channel ID and Discord Webhook URL
- Click **Add Pair**

**Configure media sync per pair** (click **Media** button):
- **TG → Discord**: toggle each Telegram type individually — photos, videos, audio, voice, documents, stickers, animations, video notes, locations, polls
- **DC → Telegram**: toggle by category — images, videos, audio, documents
- All changes save instantly, no restart needed

**Configure translation per pair** (click **Translation** button):
- Toggle the master switch to enable translation for this pair
- Enable each direction independently (`Telegram → Discord` and `Discord → Telegram`)
- Select the target language for each direction
- Choose the AI provider from the dropdown
- All changes save instantly, no restart needed

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_TOKEN` | Yes | — | BotFather token |
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `PORT` | No | `3000` | Dashboard port |
| `DATA_FILE` | No | `./data/config.json` | Path to config storage |
| `ANTHROPIC_API_KEY` | No | — | Claude translation |
| `OPENAI_API_KEY` | No | — | OpenAI translation |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | No | `llama3` | Ollama model name |
| `GOOGLE_TRANSLATE_API_KEY` | No | — | Google Cloud Translation |
| `DEEPL_API_KEY` | No | — | DeepL (append `:fx` for free tier) |
| `LIBRETRANSLATE_URL` | No | `http://localhost:5000` | LibreTranslate server |
| `LIBRETRANSLATE_API_KEY` | No | — | LibreTranslate API key (if required) |
| `MICROSOFT_TRANSLATOR_KEY` | No | — | Azure Translator key |
| `MICROSOFT_TRANSLATOR_REGION` | No | `global` | Azure region |

---

## Self-hosted Translation (no external APIs)

**Ollama** (local AI):
```bash
# Install: https://ollama.com
ollama pull llama3
# Set in .env:
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3
```

**LibreTranslate** (open-source translation API):
```bash
docker run -d -p 5000:5000 libretranslate/libretranslate
# Set in .env:
LIBRETRANSLATE_URL=http://localhost:5000
```

---

## Useful Commands (LXC / systemd)

```bash
sudo systemctl status tg-bridge     # check status
sudo journalctl -u tg-bridge -f     # live logs
sudo systemctl restart tg-bridge    # restart
sudo systemctl stop tg-bridge       # stop
```

---

## Project Structure

```
├── src/
│   ├── bridge.js        # Entry point — wires everything together
│   ├── telegram.js      # Telegraf bot (receive + send all media types)
│   ├── discord.js       # Discord.js bot + webhook sender (with file upload)
│   ├── media.js         # Download helpers, MIME classification
│   ├── translation.js   # 7-provider translation module
│   ├── store.js         # JSON config read/write
│   └── web.js           # Express dashboard + REST API
├── public/
│   └── index.html       # Dashboard UI (single file, no framework)
├── data/
│   └── config.json      # Auto-generated, stores all pairs
├── setup.sh             # Interactive first-run setup
├── .env.example         # All available env vars
├── Dockerfile
└── docker-compose.yml
```

---

## Known Limitations

- **Discord → Telegram identity**: Telegram does not allow bots to impersonate users. Messages always arrive as the bot with a `[Username]:` prefix. A Telegram userbot would be required to bypass this.
- **Animated stickers (TGS/Lottie)**: Cannot be rendered by Discord. Forwarded as `[Sticker 😄]` text instead.
- **File size limits**: 20 MB (Telegram Bot API download) and 25 MB (Discord webhook upload). Larger files are skipped with a notice.
- **Media groups / albums**: Each photo in a Telegram album is forwarded as a separate message.
- **Discord embeds**: Tenor GIFs, YouTube previews and other link embeds are not forwarded (no attachment data available).
