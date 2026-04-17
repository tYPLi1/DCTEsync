# Telegram ↔ Discord Bridge

A self-hosted bridge bot that syncs messages between Telegram groups and Discord channels — in both directions, in real time, with full media support and optional AI-powered translation.

---

## Features

- **Multi-pair sync** — link as many Telegram groups ↔ Discord channels as you want, each pair is independent
- **Telegram → Discord** — messages appear with the sender's Telegram name and profile picture (via Discord webhook), looks completely native
- **Discord → Telegram** — messages are forwarded as `[Username]: text` or `[Username]:` + media
- **Reply threading** — replies in Telegram become native Discord replies (with the correct sender name), and vice versa
- **Full media support** — photos, videos, audio, voice, documents, stickers, GIFs, video notes, locations, polls
- **Per-type media toggles** — enable/disable each media type independently per pair and per direction in the dashboard
- **Loop prevention** — the bridge's own webhook messages are always blocked; other bot messages can be allowed selectively via the bot whitelist
- **Bot message sync** — control whether bot messages are bridged, per direction (TG→DC and DC→TG separately), per pair; optionally use a global bot whitelist
- **Global + per-pair bot whitelist** — define which bots are allowed to be synced; global list or per-pair custom list
- **Web dashboard** — manage all pairs, translation, media and bot settings at `http://your-host:PORT`
- **AI translation** — 7 providers, per pair, per direction, disabled by default
- **Translation fallback chain** — if the primary provider fails or is exhausted, the next provider in the chain is tried automatically
- **Translation timeout** — if a provider takes too long, it times out and the fallback chain takes over; original text is forwarded if all providers fail
- **Two-tier translation** — Premium and Standard tiers with separate providers/chains; assign Discord roles or Telegram user IDs to Premium
- **LibreTranslate request counter** — tracks API calls made to LibreTranslate with a visual progress bar in the dashboard
- **Telegram Chat Auto-Detect** — scan recent Telegram chats the bot is in and auto-fill the Chat ID in the add-pair form
- **Pair validation** — the dashboard verifies bot access to the Telegram group when adding a pair and shows a clear error if something is misconfigured
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

> **File size limit: 20 MB** — the Telegram Bot API can only download files up to 20 MB via `getFile`.
> This is the effective ceiling for both directions (lower than Discord's 25 MB webhook limit).
> Oversized files are replaced with a text notice.

Each type can be toggled on/off **per pair** and **per direction** in the dashboard — no restart needed.

---

## Bot Message Sync

By default only human messages are bridged. You can selectively allow specific bots to have their messages forwarded.

### How it works

Each pair has independent toggles for `TG → Discord` and `Discord → TG`:

- **Enable** — allows bot messages to be forwarded in that direction
- **Global Whitelist** (default) — only bots listed in the global whitelist are forwarded
- **Custom Whitelist** — use a per-pair list instead; enter one entry per line (bot ID or username with/without `@`)

> The bridge's own webhook messages are **always blocked** regardless of these settings, so you can never create a loop.

### Global Whitelist

Configure the global lists under **⚙ Settings → Globale Bot-Whitelist**:
- **TG → DC**: Bot IDs or usernames of Telegram bots allowed to sync to Discord
- **DC → TG**: Bot IDs or usernames of Discord bots allowed to sync to Telegram

Entries are matched by numeric ID or by username (case-insensitive, `@` prefix optional).

---

## Translation

Translation is **disabled by default**. You can enable it per pair and per direction (TG→DC and DC→TG independently) in the dashboard.

### Providers

| Provider | Type | Needs Key | Self-hosted | Notes |
|---|---|---|---|---|
| Anthropic (Claude Haiku) | AI model | `ANTHROPIC_API_KEY` | No | Prompt caching for cost reduction |
| OpenAI (GPT-4o-mini) | AI model | `OPENAI_API_KEY` | No | — |
| Ollama | Local AI model | — | **Yes** | No external API needed |
| Google Translate | Translation API | `GOOGLE_TRANSLATE_API_KEY` | No | — |
| DeepL | Translation API | `DEEPL_API_KEY` (free tier available) | No | Character usage tracked in dashboard |
| LibreTranslate | Translation API | — (optional) | **Yes** | No external API needed; request count tracked in dashboard |
| Microsoft Translator | Translation API | `MICROSOFT_TRANSLATOR_KEY` | No | 2M chars/month free tier, usage tracked & adjustable |

The Anthropic provider uses **prompt caching** — the translation instruction is cached across calls, reducing latency and token costs for repeated translations.

### Translation Chain & Fallback

When a pair has translation enabled, the system tries providers in this order:
1. **Primary provider** (selected in the pair's translation settings)
2. **Fallback chain** (global list configured in Settings → Translation Chain)

When a provider **hits its quota** (e.g., DeepL's character limit or Microsoft's 2M/month), it is automatically marked as exhausted and the next provider in the chain is tried. You can manually reset exhausted providers in the dashboard.

When a provider **times out** (default: 15 seconds, configurable via `TRANSLATION_TIMEOUT_MS`), it is skipped and the fallback chain takes over. If the entire chain fails, the original text is forwarded unchanged.

The special value `none` in the chain means "stop and return original text" — useful if you want translation to be optional.

**Example**: if your pair uses `deepl` and the chain is `[deepl, microsoft, none]`:
- DeepL runs first
- If DeepL hits its quota → Microsoft Translator takes over
- If Microsoft also exhausted → text forwarded without translation

### Two-Tier Translation (Premium / Standard)

You can configure separate translation providers and chains for Premium vs. Standard users:

- **Premium tier** — used for Discord users with specific roles or Telegram users with specific IDs
- **Standard tier** — used for everyone else

Configure the tiers and Premium access lists in **⚙ Settings → Übersetzungs-Tiers**. Each pair can override the global tier config independently.

---

## Microsoft Translator (Azure) — Free Tier Tracking

Microsoft's free tier allows **2,000,000 characters per month** (UTC calendar month, auto-resets on the 1st). The bridge tracks this locally and:

- **Counts characters** automatically before each API call
- **Persists the counter** in `data/config.json`
- **Auto-resets** on the first day of each calendar month (UTC)
- **Shows usage in the dashboard** with a visual progress bar (yellow warning at 70%, red danger at 90%)
- **Detects quota errors** (Azure error code `403001`) and automatically switches to the next provider in the fallback chain

You can **manually adjust the counter** in Settings → Microsoft Translator Key section if the local count drifts (e.g., after a service restart). Enter a value and click "Setzen" or "Zurücksetzen" to reset to 0.

---

## Quick Start

### Option A — Docker Compose

```bash
git clone https://github.com/typli1/dctesync
cd DCTEsync
cp .env.example .env
nano .env          # fill in TELEGRAM_TOKEN and DISCORD_TOKEN
docker compose up -d
```

Dashboard: `http://localhost:3000`

To use a different port, set `PORT=8080` (or any value) in your `.env` — both the app and the container port mapping update automatically.

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
# (always clones the latest version automatically)
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
| Dashboard port | No (auto-suggested) |
| Anthropic / OpenAI / Ollama | No |
| Google / DeepL / LibreTranslate / Microsoft | No |
| Config file path | No (default: `./data/config.json`) |

For the dashboard port the script scans a list of common ports (3000, 3001, 4000, 5000, 8080, 8443, 9000), shows which are free or already in use, and pre-selects the first free one as the default. You can accept the suggestion or enter any port from 1–65535. If you pick an occupied port you will be asked to confirm.

It then optionally installs dependencies and sets up a **systemd auto-start service**.

---

## Getting Your Tokens

### Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token → `TELEGRAM_TOKEN`
3. Add the bot to your group
4. **Allow the bot to read all messages** — choose one of:
   - **(Recommended) Make the bot an administrator** of the group (no special admin permissions needed, just the admin role)
   - **Or** disable privacy mode globally: [@BotFather](https://t.me/BotFather) → `/mybots` → your bot → **Bot Settings → Group Privacy → Turn off**

   > **Why?** Telegram bots run in *privacy mode* by default — they only receive `/commands`,
   > not regular messages. Without one of these two fixes the bridge receives nothing and
   > appears silently broken. The dashboard will show an error if neither condition is met
   > when you try to add the pair.

5. Get the group's chat ID: after adding the bot, send a message, then call:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Look for `"chat":{"id": -100xxxxxxxxx}` — that's your `telegramChatId`.
   Supergroup IDs start with `-100`.

   Or use the **🔍 Auto-Detect** button in the dashboard to scan recent chats automatically.

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
- Use the **🔍** button next to the Chat ID field to auto-detect recent Telegram chats
- Click **Add Pair**
- The dashboard calls the Telegram API to confirm the bot can read messages in that group.
  If the bot is not an admin and privacy mode is on, you will see a clear error explaining how to fix it.

**Configure media sync per pair** (click **Media** button):
- **TG → Discord**: toggle each Telegram type individually — photos, videos, audio, voice, documents, stickers, animations, video notes, locations, polls
- **DC → Telegram**: toggle by category — images, videos, audio, documents
- All changes save instantly, no restart needed

**Configure bot message sync per pair** (click **Media** button → Bot-Nachrichten section):
- Enable TG→DC bot sync and/or DC→TG bot sync independently
- Choose between global whitelist or a custom per-pair whitelist
- Enter bot IDs or usernames (one per line) for the custom list

**Configure translation per pair** (click **Translation** button):
- Toggle the master switch to enable translation for this pair
- Enable each direction independently (`Telegram → Discord` and `Discord → Telegram`)
- Select the target language for each direction
- Choose the primary AI provider from the dropdown
- All changes save instantly, no restart needed
- If the primary provider hits its quota or times out, the fallback chain takes over automatically

**Change API keys or tokens** (click **⚙ Settings** in the top-right):
- Update any token or API key without re-running `setup.sh`
- Sensitive fields show the current masked value as a placeholder — leave blank to keep it, or type a new value to replace it
- Changes are written to `.env` immediately and take effect without a service restart
- **Microsoft Translator**: shows character count and monthly quota. You can manually adjust the counter with the input field and buttons ("Setzen" / "Zurücksetzen") if needed.
- **DeepL**: shows character usage from DeepL's API
- **LibreTranslate**: shows request count with a progress bar
- **Translation Chain**: configure the fallback order (e.g., `[deepl, microsoft, none]`) — when the primary provider on a pair exhausts its quota, the next in the chain is tried
- **Übersetzungs-Tiers**: configure Premium/Standard providers and chains; set which Discord roles or Telegram user IDs get Premium tier
- **Globale Bot-Whitelist**: manage the global list of allowed bots for TG→DC and DC→TG

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_TOKEN` | Yes | — | BotFather token |
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `PORT` | No | `3000` | Dashboard port (also controls Docker port mapping) |
| `DATA_FILE` | No | `./data/config.json` | Path to config storage |
| `TRANSLATION_TIMEOUT_MS` | No | `15000` | Per-provider translation timeout in milliseconds |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku translation (with prompt caching) |
| `OPENAI_API_KEY` | No | — | OpenAI GPT-4o-mini translation |
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

## Updating

### LXC / systemd

Run this from the directory where you cloned the bridge:

```bash
bash update.sh
```

The script does everything automatically:

1. Stashes any local modifications (`.env` and `data/config.json` stay safe)
2. Pulls the latest code from the repository
3. `npm install` — installs any newly added dependencies
4. `npm update` — upgrades all packages to their latest compatible version (patch + minor only, no breaking major bumps)
5. Lists packages with new **major** versions available as an info hint
6. Restarts `tg-bridge` via systemd
7. Restores your local changes

### Docker

```bash
git pull
docker compose up -d --build
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
│   ├── media.js         # Download helpers, MIME classification, size limits
│   ├── translation.js   # 7-provider translation module with Anthropic prompt caching
│   ├── store.js         # JSON config read/write (pairs, bot whitelist, tiers)
│   └── web.js           # Express dashboard + REST API
├── public/
│   └── index.html       # Dashboard UI (single file, no framework)
├── data/
│   └── config.json      # Auto-generated, stores all pairs and settings
├── setup.sh             # Interactive first-run setup
├── update.sh            # One-command updater (pull + deps + service restart)
├── .env.example         # All available env vars
├── Dockerfile
└── docker-compose.yml
```

---

## Known Limitations

- **Discord → Telegram identity**: Telegram does not allow bots to impersonate users. Messages always arrive as the bot with a `[Username]:` prefix. A Telegram userbot would be required to bypass this.
- **Animated stickers (TGS/Lottie)**: Cannot be rendered by Discord. Forwarded as `[Sticker 😄]` text instead.
- **File size limit**: 20 MB — the Telegram Bot API `getFile` endpoint caps at 20 MB. Files over this limit are replaced with a text notice in both directions.
- **Media groups / albums**: Each photo in a Telegram album is forwarded as a separate message.
- **Discord embeds**: Tenor GIFs, YouTube previews and other link embeds are not forwarded (no attachment data available).
- **Anonymous group admins**: Messages posted anonymously via a linked channel are treated as bot messages and subject to the bot whitelist rules.
- **Microsoft Translator quota**: Tracked locally (no official Azure quota API). If the counter drifts after a restart, you can manually adjust it in the dashboard. The free tier resets automatically on the 1st of each month (UTC).
