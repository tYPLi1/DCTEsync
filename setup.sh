#!/usr/bin/env bash
set -e

BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

ask() {
  local prompt="$1"
  local default="$2"
  local secret="$3"
  local value=""

  if [ -n "$default" ]; then
    echo -ne "${CYAN}${prompt}${RESET} [${default}]: "
  else
    echo -ne "${CYAN}${prompt}${RESET}: "
  fi

  if [ "$secret" = "true" ]; then
    read -rs value
    echo
  else
    read -r value
  fi

  if [ -z "$value" ] && [ -n "$default" ]; then
    value="$default"
  fi

  echo "$value"
}

ask_optional() {
  local prompt="$1"
  echo -ne "${CYAN}${prompt}${RESET} ${YELLOW}(optional, Enter to skip)${RESET}: "
  local value=""
  read -rs value
  echo
  echo "$value"
}

confirm() {
  echo -ne "${CYAN}$1${RESET} [y/N]: "
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Telegram ↔ Discord Bridge  –  Setup   ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Tokens ───────────────────────────────────────────────────────────────────

echo -e "${BOLD}── Bot Tokens ───────────────────────────────${RESET}"
echo -e "  Get your Telegram token from ${CYAN}@BotFather${RESET}"
echo -e "  Get your Discord token from ${CYAN}discord.com/developers${RESET}"
echo ""

TG_TOKEN=$(ask "Telegram Bot Token" "" true)
while [ -z "$TG_TOKEN" ]; do
  echo -e "${RED}Telegram token is required.${RESET}"
  TG_TOKEN=$(ask "Telegram Bot Token" "" true)
done

DC_TOKEN=$(ask "Discord Bot Token" "" true)
while [ -z "$DC_TOKEN" ]; do
  echo -e "${RED}Discord token is required.${RESET}"
  DC_TOKEN=$(ask "Discord Bot Token" "" true)
done

# ── Port ─────────────────────────────────────────────────────────────────────

# Returns 0 (true) if the given port is already in use on this machine.
port_in_use() {
  local p="$1"
  # Primary: read kernel TCP tables — works on every Linux without extra tools
  local hex
  hex=$(printf '%04X' "$p")
  if grep -q ":${hex} " /proc/net/tcp 2>/dev/null || \
     grep -q ":${hex} " /proc/net/tcp6 2>/dev/null; then
    return 0
  fi
  # Fallback: ss (iproute2)
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -qE ":${p}[^0-9]"
    return $?
  fi
  # Fallback: netstat
  if command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep -qE ":${p}[^0-9]"
    return $?
  fi
  return 1  # can't detect — assume free
}

echo ""
echo -e "${BOLD}── Web Dashboard ────────────────────────────${RESET}"
echo ""

CANDIDATES=(3000 3001 4000 5000 8080 8443 9000)
FIRST_FREE=""

echo -e "  Port availability:"
for p in "${CANDIDATES[@]}"; do
  if port_in_use "$p"; then
    echo -e "    ${RED}✗${RESET}  $p  ${RED}(already in use)${RESET}"
  else
    echo -e "    ${GREEN}✓${RESET}  $p  ${GREEN}(free)${RESET}"
    [ -z "$FIRST_FREE" ] && FIRST_FREE="$p"
  fi
done
echo ""

DEFAULT_PORT="${FIRST_FREE:-3000}"
PORT=$(ask "Dashboard port" "$DEFAULT_PORT")

# Validate: must be a number between 1–65535
while true; do
  if [[ ! "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo -e "${RED}  ✗ Invalid port. Please enter a number between 1 and 65535.${RESET}"
    PORT=$(ask "Dashboard port" "$DEFAULT_PORT")
  elif port_in_use "$PORT"; then
    echo -e "${YELLOW}  ⚠ Port $PORT is already in use on this machine.${RESET}"
    if confirm "  Use port $PORT anyway?"; then
      break
    fi
    PORT=$(ask "Dashboard port" "$DEFAULT_PORT")
  else
    echo -e "${GREEN}  ✓ Port $PORT is free.${RESET}"
    break
  fi
done

# ── Translation (optional) ────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Translation Providers (all optional) ─────${RESET}"
echo -e "  You can configure any combination. Providers"
echo -e "  without a key are grayed out in the dashboard."
echo ""
echo -e "  ${YELLOW}AI Models:${RESET}"
ANTHROPIC_KEY=$(ask_optional "  Anthropic API Key (Claude Haiku)")
OPENAI_KEY=$(ask_optional    "  OpenAI API Key    (GPT-4o-mini)")
echo -ne "  ${CYAN}  Ollama base URL${RESET} ${YELLOW}(optional, Enter to skip)${RESET}: "
read -r OLLAMA_URL
echo -ne "  ${CYAN}  Ollama model${RESET} [llama3]: "
read -r OLLAMA_MODEL
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3}"

echo ""
echo -e "  ${YELLOW}Dedicated Translation APIs:${RESET}"
GOOGLE_KEY=$(ask_optional    "  Google Translate API Key")
DEEPL_KEY=$(ask_optional     "  DeepL API Key")
echo -ne "  ${CYAN}  LibreTranslate URL${RESET} ${YELLOW}(optional, Enter to skip)${RESET}: "
read -r LIBRE_URL
LIBRE_KEY=$(ask_optional     "  LibreTranslate API Key")
MS_KEY=$(ask_optional        "  Microsoft Translator Key")
if [ -n "$MS_KEY" ]; then
  MS_REGION=$(ask "  Microsoft Translator Region" "global")
fi

# ── Data path ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Storage ──────────────────────────────────${RESET}"
DATA_FILE=$(ask "Path to config.json" "./data/config.json")

# ── Write .env ────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Writing .env ─────────────────────────────${RESET}"

cat > .env << EOF
# Generated by setup.sh

# ── Required ──────────────────────────────────────────────────────────────────
TELEGRAM_TOKEN=${TG_TOKEN}
DISCORD_TOKEN=${DC_TOKEN}

# ── Server ────────────────────────────────────────────────────────────────────
PORT=${PORT}

# ── Storage ───────────────────────────────────────────────────────────────────
DATA_FILE=${DATA_FILE}
EOF

# Write translation section
echo "" >> .env
echo "# ── Translation Providers ────────────────────────────────────────────────────" >> .env

[ -n "$ANTHROPIC_KEY" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_KEY}" >> .env
[ -n "$OPENAI_KEY"    ] && echo "OPENAI_API_KEY=${OPENAI_KEY}"       >> .env
[ -n "$OLLAMA_URL"    ] && echo "OLLAMA_BASE_URL=${OLLAMA_URL}"      >> .env
echo "OLLAMA_MODEL=${OLLAMA_MODEL}"                                   >> .env
[ -n "$GOOGLE_KEY"    ] && echo "GOOGLE_TRANSLATE_API_KEY=${GOOGLE_KEY}" >> .env
[ -n "$DEEPL_KEY"     ] && echo "DEEPL_API_KEY=${DEEPL_KEY}"         >> .env
[ -n "$LIBRE_URL"     ] && echo "LIBRETRANSLATE_URL=${LIBRE_URL}"    >> .env
[ -n "$LIBRE_KEY"     ] && echo "LIBRETRANSLATE_API_KEY=${LIBRE_KEY}" >> .env
[ -n "$MS_KEY"        ] && echo "MICROSOFT_TRANSLATOR_KEY=${MS_KEY}" >> .env
[ -n "$MS_KEY"        ] && echo "MICROSOFT_TRANSLATOR_REGION=${MS_REGION:-global}" >> .env

echo -e "${GREEN}✓ .env written${RESET}"

# ── Install dependencies ──────────────────────────────────────────────────────

echo ""
if confirm "Install npm dependencies now?"; then
  echo ""
  npm install --omit=dev
  echo -e "${GREEN}✓ Dependencies installed${RESET}"
fi

# ── systemd service ───────────────────────────────────────────────────────────

echo ""
if confirm "Set up systemd auto-start service? (requires root)"; then
  WORKDIR="$(pwd)"
  NODE_BIN="$(which node)"

  sudo tee /etc/systemd/system/tg-bridge.service > /dev/null << EOF
[Unit]
Description=Telegram Discord Bridge
After=network.target

[Service]
WorkingDirectory=${WORKDIR}
ExecStart=${NODE_BIN} src/bridge.js
Restart=always
RestartSec=5
EnvironmentFile=${WORKDIR}/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable tg-bridge

  echo ""
  if confirm "Start the bridge now?"; then
    sudo systemctl start tg-bridge
    sleep 2
    sudo systemctl status tg-bridge --no-pager -l
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║              Setup complete!             ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Dashboard: ${CYAN}http://$(hostname -I | awk '{print $1}'):${PORT}${RESET}"
echo ""
echo -e "  Useful commands:"
echo -e "    ${YELLOW}sudo systemctl status tg-bridge${RESET}   – check status"
echo -e "    ${YELLOW}sudo journalctl -u tg-bridge -f${RESET}   – live logs"
echo -e "    ${YELLOW}sudo systemctl restart tg-bridge${RESET}  – restart"
echo ""
