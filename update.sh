#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Telegram ↔ Discord Bridge – Update-Skript
# Ausführen im Bridge-Verzeichnis:  bash update.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

SERVICE_NAME="tg-bridge"

# Git-Credential-Prompts deaktivieren – schlägt still fehl statt zu blocken
export GIT_TERMINAL_PROMPT=0

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Telegram ↔ Discord Bridge  –  Update  ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Muss im Repo ausgeführt werden ───────────────────────────────────────────

if [[ ! -d .git ]]; then
  echo -e "${RED}✗ Kein git-Repository gefunden.${RESET}"
  echo -e "  Bitte dieses Skript im Bridge-Verzeichnis ausführen."
  exit 1
fi

# ── .env prüfen ───────────────────────────────────────────────────────────────

if [[ ! -f .env ]]; then
  echo -e "${RED}✗ .env nicht gefunden.${RESET}"
  echo -e "  Bitte zuerst ${CYAN}bash setup.sh${RESET} ausführen."
  exit 1
fi

# ── Einmalige GitHub-Authentifizierung einrichten (nur wenn nötig) ───────────

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
      echo -e "  Dann Update erneut starten."
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

      # Einmalig authentifizieren → schreibt in ~/.git-credentials
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
      else
        echo -e "  ${RED}✗ Authentifizierung fehlgeschlagen.${RESET}"
        echo -e "  Benutzername oder Token falsch — bitte prüfen."
        exit 1
      fi
    fi
  fi
fi

# ── Standard-Branch ermitteln (ohne Netzwerk-Call) ───────────────────────────

DEFAULT_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')"
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH="main"
fi

# ── Argumente parsen ──────────────────────────────────────────────────────────
# Unterstützt:
#   ./update.sh                         → interaktiver Prompt (Enter = Standard)
#   ./update.sh <branch>                → positionales Argument
#   ./update.sh --branch <branch>       → benanntes Flag
#   ./update.sh -b <branch>             → Kurzform
TARGET_BRANCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch|-b)
      shift
      TARGET_BRANCH="$1"
      ;;
    --branch=*)
      TARGET_BRANCH="${1#--branch=}"
      ;;
    -*)
      echo -e "${RED}✗ Unbekanntes Flag: $1${RESET}"
      echo -e "  Verwendung: ./update.sh [--branch <name>] [<branch>]"
      exit 1
      ;;
    *)
      TARGET_BRANCH="$1"
      ;;
  esac
  shift
done

# ── Interaktiver Branch-Prompt wenn kein Branch angegeben ────────────────────
if [[ -z "$TARGET_BRANCH" ]]; then
  REMOTE_BRANCHES="$(git ls-remote --heads origin 2>/dev/null | awk '{sub("refs/heads/",""); print $2}')"
  if [[ -n "$REMOTE_BRANCHES" ]]; then
    echo -e "${BOLD}Verfügbare Branches:${RESET}"
    echo "$REMOTE_BRANCHES" | while IFS= read -r b; do
      echo -e "  ${CYAN}${b}${RESET}"
    done
    echo ""
  fi
  printf "Branch zum Update [%s]: " "${DEFAULT_BRANCH}"
  read -r USER_BRANCH
  TARGET_BRANCH="${USER_BRANCH:-$DEFAULT_BRANCH}"
fi

# ── Aktuellen Branch merken ───────────────────────────────────────────────────
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo -e "  Aktueller Branch: ${CYAN}${CURRENT_BRANCH}${RESET}"
echo -e "  Ziel-Branch:      ${CYAN}${TARGET_BRANCH}${RESET}"
echo ""

# ── Lokale Änderungen stashen ─────────────────────────────────────────────────
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo -e "${YELLOW}⚠ Lokale Änderungen gefunden — werden temporär gestasht.${RESET}"
  git stash push -u -m "update.sh auto-stash $(date +%s)" > /dev/null
  STASHED=1
fi

# ── Branch wechseln + pullen ──────────────────────────────────────────────────
echo -e "${BOLD}── Neueste Version laden ────────────────────${RESET}"
git fetch origin "$TARGET_BRANCH"

if [[ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]]; then
  git checkout "$TARGET_BRANCH"
fi

git pull --ff-only origin "$TARGET_BRANCH"
echo -e "${GREEN}✓ Code aktualisiert${RESET}"

# ── Gestashte Änderungen wiederherstellen ─────────────────────────────────────
if [[ "$STASHED" = "1" ]]; then
  echo ""
  echo -e "${YELLOW}⚠ Lokale Änderungen werden wiederhergestellt…${RESET}"
  if ! git stash pop; then
    echo -e "${RED}⚠ Merge-Konflikt beim Wiederherstellen.${RESET}"
    echo -e "  Konflikte manuell lösen, dann ausführen:"
    echo -e "    ${CYAN}git stash drop${RESET}"
    exit 1
  fi
fi

# ── Abhängigkeiten installieren & aktualisieren ───────────────────────────────
echo ""
echo -e "${BOLD}── Abhängigkeiten installieren ──────────────${RESET}"
if command -v npm &>/dev/null; then
  npm install --omit=dev
  echo -e "${GREEN}✓ Abhängigkeiten installiert${RESET}"

  echo ""
  echo -e "${BOLD}── Abhängigkeiten auf neueste kompatible Versionen aktualisieren ──${RESET}"
  npm update --omit=dev
  echo -e "${GREEN}✓ Abhängigkeiten aktualisiert (innerhalb semver-Bereiche)${RESET}"

  # Neuere MAJOR-Versionen anzeigen (nicht fatal, nur Info)
  if npm outdated --omit=dev > /tmp/npm_outdated.$$ 2>/dev/null; then
    :
  fi
  if [[ -s /tmp/npm_outdated.$$ ]]; then
    echo ""
    echo -e "${YELLOW}ℹ Einige Pakete haben neuere MAJOR-Versionen verfügbar${RESET}"
    echo -e "  (nicht automatisch aktualisiert, um Breaking Changes zu vermeiden):"
    cat /tmp/npm_outdated.$$
    echo -e "  Manuell aktualisieren: ${CYAN}npm install <paket>@latest${RESET}"
  fi
  rm -f /tmp/npm_outdated.$$
else
  echo -e "${YELLOW}⚠ npm nicht gefunden — Abhängigkeiten-Update übersprungen.${RESET}"
fi

# ── Service neu starten ───────────────────────────────────────────────────────
# sudo nur wenn nicht bereits root
if [[ "$(id -u)" = "0" ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

SERVICE_FILE="/etc/systemd/system/tg-bridge.service"

if [ -f "$SERVICE_FILE" ]; then
  echo ""
  echo -e "${BOLD}── Updating systemd service config ──────────${RESET}"

  WORKDIR="$(pwd)"
  NODE_BIN="$(which node)"

  # Write the current canonical service config
  $SUDO tee "$SERVICE_FILE" > /dev/null << SVCEOF
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
SVCEOF

  $SUDO systemctl daemon-reload
  echo -e "${GREEN}✓ Service config updated${RESET}"
fi

# ── Restart service if systemd is set up ─────────────────────────────────────
echo ""
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
  echo -e "${BOLD}── Service neu starten ──────────────────────${RESET}"
  if $SUDO systemctl restart "${SERVICE_NAME}"; then
    echo -e "${GREEN}✓ Service neu gestartet${RESET}"
    sleep 1
    $SUDO systemctl status "${SERVICE_NAME}" --no-pager -l | head -n 10
  else
    echo -e "${RED}✗ Service-Neustart fehlgeschlagen.${RESET}"
  fi
else
  echo -e "${YELLOW}ℹ Kein systemd-Service gefunden — Bridge bei Bedarf manuell neu starten.${RESET}"
  echo -e "  Docker-Nutzer: ${CYAN}docker compose up -d --build${RESET}"
fi

# ── Fertig ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║          Update abgeschlossen!           ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
