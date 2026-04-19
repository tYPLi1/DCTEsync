#!/usr/bin/env bash
set -e

BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

# Git-Credential-Prompts deaktivieren – schlägt still fehl statt zu blocken
export GIT_TERMINAL_PROMPT=0

ask() {
  local prompt="$1"
  local default="$2"
  local secret="$3"
  local value=""

  # Prompts MUST go to stderr — this function is called inside $(...) so
  # stdout is captured by the caller. Without >&2 the user sees nothing
  # and types blindly.
  if [ -n "$default" ]; then
    printf '%b%s%b [%s]: ' "$CYAN" "$prompt" "$RESET" "$default" >&2
  else
    printf '%b%s%b: ' "$CYAN" "$prompt" "$RESET" >&2
  fi

  if [ "$secret" = "true" ]; then
    read -rs value </dev/tty
    echo >&2
  else
    read -r value </dev/tty
  fi

  if [ -z "$value" ] && [ -n "$default" ]; then
    value="$default"
  fi

  echo "$value"
}

ask_optional() {
  local prompt="$1"
  printf '%b%s%b %b(optional, Enter to skip)%b: ' \
    "$CYAN" "$prompt" "$RESET" "$YELLOW" "$RESET" >&2
  local value=""
  read -rs value </dev/tty
  echo >&2
  echo "$value"
}

confirm() {
  printf '%b%s%b [y/N]: ' "$CYAN" "$1" "$RESET" >&2
  local ans
  read -r ans </dev/tty
  [[ "$ans" =~ ^[Yy]$ ]]
}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Telegram ↔ Discord Bridge  –  Setup   ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Muss im Repo ausgeführt werden ───────────────────────────────────────────

if [[ ! -d .git ]]; then
  echo -e "${RED}✗ Kein git-Repository gefunden.${RESET}"
  echo -e "  Bitte dieses Skript im Bridge-Verzeichnis ausführen."
  exit 1
fi

# ── GitHub-Authentifizierung einrichten (nur wenn nötig) ─────────────────────

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"

if [[ "$REMOTE_URL" == https://* ]]; then
  if ! git ls-remote origin HEAD &>/dev/null; then
    echo -e "${YELLOW}⚠ GitHub-Authentifizierung fehlt oder Token abgelaufen.${RESET}"
    echo ""
    echo -e "  ${BOLD}Einmalig einrichten — danach nie wieder eingeben:${RESET}"
    echo ""
    echo -e "  ${CYAN}1${RESET}) GitHub Personal Access Token (einfach, empfohlen)"
    echo -e "  ${CYAN}2${RESET}) SSH-Key (sicherer, einmalige Einrichtung)"
    echo ""
    printf "  Wahl [1]: "
    read -r AUTH_CHOICE
    AUTH_CHOICE="${AUTH_CHOICE:-1}"

    if [[ "$AUTH_CHOICE" == "2" ]]; then
      echo ""
      echo -e "  ${BOLD}SSH-Key einrichten (einmalig):${RESET}"
      echo -e "  ${CYAN}1.${RESET} Key erstellen:   ${CYAN}ssh-keygen -t ed25519${RESET}"
      echo -e "  ${CYAN}2.${RESET} Key anzeigen:    ${CYAN}cat ~/.ssh/id_ed25519.pub${RESET}"
      echo -e "  ${CYAN}3.${RESET} Key zu GitHub hinzufügen:  github.com → Settings → SSH Keys"
      echo -e "  ${CYAN}4.${RESET} Remote umstellen: ${CYAN}git remote set-url origin git@github.com:tYPLi1/DCTEsync.git${RESET}"
      echo ""
      echo -e "  Dann Setup erneut starten."
      exit 0
    else
      echo ""
      echo -e "  Personal Access Token erstellen:"
      echo -e "  github.com → Settings → Developer settings → Personal access tokens → Fine-grained"
      echo -e "  Berechtigung: ${CYAN}Contents: Read-only${RESET}"
      echo ""
      printf "  GitHub-Benutzername: "
      read -r GH_USER
      printf "  GitHub-Token (wird nicht angezeigt): "
      read -rs GH_TOKEN
      echo ""

      # Credential-Helper auf dauerhafte Speicherung setzen
      git config credential.helper store

      AUTH_URL="https://${GH_USER}:${GH_TOKEN}@${REMOTE_URL#https://}"
      if git ls-remote "$AUTH_URL" HEAD &>/dev/null; then
        # Vorhandenen Eintrag für diesen Host ersetzen oder neu hinzufügen
        CRED_HOST="$(echo "$REMOTE_URL" | grep -oP '(?<=https://)([^/]+)')"
        CRED_LINE="https://${GH_USER}:${GH_TOKEN}@${CRED_HOST}"
        touch ~/.git-credentials && chmod 600 ~/.git-credentials
        grep -v "^https://.*@${CRED_HOST}" ~/.git-credentials > /tmp/.git-creds-tmp 2>/dev/null || true
        echo "$CRED_LINE" >> /tmp/.git-creds-tmp
        mv /tmp/.git-creds-tmp ~/.git-credentials
        echo -e "  ${GREEN}✓ Credentials gespeichert in ~/.git-credentials${RESET}"
        echo -e "  ${GREEN}✓ Ab jetzt kein Login mehr nötig.${RESET}"
        echo ""
      else
        echo -e "  ${RED}✗ Authentifizierung fehlgeschlagen.${RESET}"
        echo -e "  Benutzername oder Token falsch — bitte prüfen."
        exit 1
      fi
    fi
  fi
fi

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

# ── Confirmation summary ──────────────────────────────────────────────────────
# Show a masked preview so the user can confirm keys were captured correctly.
# mask() keeps the first 6 chars and replaces the rest with ****
mask() {
  local v="$1"
  if [ ${#v} -le 6 ]; then
    echo "****"
  else
    echo "${v:0:6}****"
  fi
}

echo -e "${GREEN}✓ .env written${RESET}"
echo ""
echo -e "${BOLD}── Saved configuration ──────────────────────${RESET}"
echo -e "  TELEGRAM_TOKEN          $(mask "$TG_TOKEN")"
echo -e "  DISCORD_TOKEN           $(mask "$DC_TOKEN")"
echo -e "  PORT                    ${PORT}"
echo -e "  DATA_FILE               ${DATA_FILE}"
[ -n "$ANTHROPIC_KEY" ] && echo -e "  ANTHROPIC_API_KEY       $(mask "$ANTHROPIC_KEY")"
[ -n "$OPENAI_KEY"    ] && echo -e "  OPENAI_API_KEY          $(mask "$OPENAI_KEY")"
[ -n "$OLLAMA_URL"    ] && echo -e "  OLLAMA_BASE_URL         ${OLLAMA_URL}"
[ -n "$GOOGLE_KEY"    ] && echo -e "  GOOGLE_TRANSLATE_KEY    $(mask "$GOOGLE_KEY")"
[ -n "$DEEPL_KEY"     ] && echo -e "  DEEPL_API_KEY           $(mask "$DEEPL_KEY")"
[ -n "$LIBRE_URL"     ] && echo -e "  LIBRETRANSLATE_URL      ${LIBRE_URL}"
[ -n "$LIBRE_KEY"     ] && echo -e "  LIBRETRANSLATE_KEY      $(mask "$LIBRE_KEY")"
[ -n "$MS_KEY"        ] && echo -e "  MICROSOFT_TRANSLATOR    $(mask "$MS_KEY")  (region: ${MS_REGION:-global})"
echo ""
echo -e "  ${YELLOW}To change any value later, edit ${CYAN}.env${YELLOW} directly:${RESET}"
echo -e "    ${CYAN}nano $(pwd)/.env${RESET}"
echo -e "  Then restart the bridge:"
echo -e "    ${CYAN}systemctl restart tg-bridge${RESET}"

# ── Install dependencies ──────────────────────────────────────────────────────

echo ""
if confirm "Install npm dependencies now?"; then
  echo ""
  npm install --omit=dev
  echo -e "${GREEN}✓ Dependencies installed${RESET}"
fi

# ── systemd service ───────────────────────────────────────────────────────────

# Use 'sudo' only when not already root
if [ "$(id -u)" = "0" ]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo ""
if confirm "Set up systemd auto-start service? (requires root)"; then
  WORKDIR="$(pwd)"
  NODE_BIN="$(which node)"

  $SUDO tee /etc/systemd/system/tg-bridge.service > /dev/null << EOF
[Unit]
Description=Telegram Discord Bridge
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${WORKDIR}
ExecStart=${NODE_BIN} src/bridge.js
Restart=always
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=10
TimeoutStopSec=10
EnvironmentFile=${WORKDIR}/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable tg-bridge

  echo ""
  if confirm "Start the bridge now?"; then
    $SUDO systemctl start tg-bridge
    sleep 2
    $SUDO systemctl status tg-bridge --no-pager -l
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
echo -e "    ${YELLOW}systemctl status tg-bridge${RESET}   – check status"
echo -e "    ${YELLOW}journalctl -u tg-bridge -f${RESET}   – live logs"
echo -e "    ${YELLOW}systemctl restart tg-bridge${RESET}  – restart"
echo ""
