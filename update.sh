#!/usr/bin/env bash
set -e

BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Telegram ↔ Discord Bridge  –  Update  ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Must be run inside the repo ──────────────────────────────────────────────
if [ ! -d .git ]; then
  echo -e "${RED}✗ This is not a git repository.${RESET}"
  echo -e "  Run this script from the directory where you cloned the bridge."
  exit 1
fi

# ── Determine default branch (remote HEAD) ───────────────────────────────────
DEFAULT_BRANCH="$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')"
if [ -z "$DEFAULT_BRANCH" ] || [ "$DEFAULT_BRANCH" = "(unknown)" ]; then
  DEFAULT_BRANCH="claude/telegram-discord-bridge-bUm5a"
fi

# ── Parse arguments ───────────────────────────────────────────────────────────
# Supports:
#   ./update.sh                         → interactive prompt (Enter = default)
#   ./update.sh <branch>                → positional argument
#   ./update.sh --branch <branch>       → named flag
#   ./update.sh -b <branch>             → short flag
TARGET_BRANCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch|-b)
      shift
      TARGET_BRANCH="$1"
      ;;
    --branch=*)
      TARGET_BRANCH="${1#--branch=}"
      ;;
    -*)
      echo -e "${RED}✗ Unknown flag: $1${RESET}"
      echo -e "  Usage: ./update.sh [--branch <name>] [<branch>]"
      exit 1
      ;;
    *)
      TARGET_BRANCH="$1"
      ;;
  esac
  shift
done

# ── Interactive prompt when no branch was specified ───────────────────────────
if [ -z "$TARGET_BRANCH" ]; then
  REMOTE_BRANCHES="$(git ls-remote --heads origin 2>/dev/null | awk '{sub("refs/heads/",""); print $2}')"
  if [ -n "$REMOTE_BRANCHES" ]; then
    echo -e "${BOLD}Available branches:${RESET}"
    echo "$REMOTE_BRANCHES" | while IFS= read -r b; do
      echo -e "  ${CYAN}${b}${RESET}"
    done
    echo ""
  fi
  printf "Branch to update to [%s]: " "${DEFAULT_BRANCH}"
  read -r USER_BRANCH
  TARGET_BRANCH="${USER_BRANCH:-$DEFAULT_BRANCH}"
fi

# ── Remember current branch ───────────────────────────────────────────────────
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo -e "  Current branch: ${CYAN}${CURRENT_BRANCH}${RESET}"
echo -e "  Target branch:  ${CYAN}${TARGET_BRANCH}${RESET}"
echo ""

# ── Stash local changes if any ───────────────────────────────────────────────
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo -e "${YELLOW}⚠ You have local changes — stashing them temporarily.${RESET}"
  git stash push -u -m "update.sh auto-stash $(date +%s)" > /dev/null
  STASHED=1
fi

# ── Switch to target branch + pull ───────────────────────────────────────────
echo -e "${BOLD}── Fetching latest version ──────────────────${RESET}"
git fetch origin "$TARGET_BRANCH"

if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then
  git checkout "$TARGET_BRANCH"
fi

git pull --ff-only origin "$TARGET_BRANCH"
echo -e "${GREEN}✓ Code updated${RESET}"

# ── Restore stashed changes ──────────────────────────────────────────────────
if [ "$STASHED" = "1" ]; then
  echo ""
  echo -e "${YELLOW}⚠ Restoring your local changes…${RESET}"
  if ! git stash pop; then
    echo -e "${RED}⚠ Merge conflict while restoring local changes.${RESET}"
    echo -e "  Resolve conflicts manually, then run:"
    echo -e "    ${CYAN}git stash drop${RESET}"
    exit 1
  fi
fi

# ── Install & update dependencies ────────────────────────────────────────────
# Two-step strategy:
#   1) npm install     → add any NEW deps from package.json, honour the lockfile
#   2) npm update      → pull the latest patch / minor releases within the
#                        semver ranges in package.json (safe, no breaking majors)
echo ""
echo -e "${BOLD}── Installing dependencies ──────────────────${RESET}"
if command -v npm &>/dev/null; then
  npm install --omit=dev
  echo -e "${GREEN}✓ Dependencies installed${RESET}"

  echo ""
  echo -e "${BOLD}── Updating dependencies to latest compatible versions ──${RESET}"
  npm update --omit=dev
  echo -e "${GREEN}✓ Dependencies updated (within semver ranges)${RESET}"

  # Optionally show outdated majors (non-fatal, info only)
  if npm outdated --omit=dev > /tmp/npm_outdated.$$ 2>/dev/null; then
    :
  fi
  if [ -s /tmp/npm_outdated.$$ ]; then
    echo ""
    echo -e "${YELLOW}ℹ Some packages have newer MAJOR versions available${RESET}"
    echo -e "  (not auto-updated to avoid breaking changes):"
    cat /tmp/npm_outdated.$$
    echo -e "  To upgrade manually: ${CYAN}npm install <package>@latest${RESET}"
  fi
  rm -f /tmp/npm_outdated.$$
else
  echo -e "${YELLOW}⚠ npm not found, skipping dependency install.${RESET}"
fi

# ── Restart service if systemd is set up ─────────────────────────────────────
# Use 'sudo' only when not already root
if [ "$(id -u)" = "0" ]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo ""
if systemctl list-unit-files 2>/dev/null | grep -q '^tg-bridge\.service'; then
  echo -e "${BOLD}── Restarting service ───────────────────────${RESET}"
  if $SUDO systemctl restart tg-bridge; then
    echo -e "${GREEN}✓ Service restarted${RESET}"
    sleep 1
    $SUDO systemctl status tg-bridge --no-pager -l | head -n 10
  else
    echo -e "${RED}✗ Failed to restart tg-bridge.${RESET}"
  fi
else
  echo -e "${YELLOW}ℹ No systemd service found — restart your bridge manually if needed.${RESET}"
  echo -e "  If you run it via docker compose, use: ${CYAN}docker compose up -d --build${RESET}"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║            Update complete!              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
