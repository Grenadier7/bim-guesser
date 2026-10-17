#!/usr/bin/env bash
# Öffi-Guesser auf Ditto aktuell halten (läuft per cron alle 2 min als Benutzer mew):
#  1. neues Image :latest von ghcr.io holen – nichts Neues → fertig
#  2. warten, bis kein Spiel läuft (max. 15 min; "--now" überspringt das)
#  3. Container neu starten und per /api/health prüfen
#  4. startet die neue Version nicht → zurück auf die vorige, die kaputte wird gemerkt und übersprungen
set -uo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$HOME/docker}"
SERVICE=oeffi-guesser
IMAGE=ghcr.io/grenadier7/bim-guesser
MAX_WAIT_MIN=15
STATE="$HOME/.oeffi-update"
FORCE="${1:-}"

exec 9>/tmp/oeffi-update.lock
flock -n 9 || exit 0 # läuft schon

log() { echo "$(date '+%F %T') $*"; }
health() {
  docker exec "$SERVICE" node -e \
    "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))" 2>/dev/null
}

cd "$COMPOSE_DIR" || { log "✖ $COMPOSE_DIR fehlt"; exit 1; }
mkdir -p "$STATE"

docker pull -q "$IMAGE:latest" >/dev/null 2>&1 || { log "✖ Pull von $IMAGE:latest fehlgeschlagen"; exit 1; }
latest=$(docker image inspect --format '{{.Id}}' "$IMAGE:latest")
current=$(docker inspect --format '{{.Image}}' "$SERVICE" 2>/dev/null || echo none)
[ "$latest" = "$current" ] && exit 0
if [ -f "$STATE/bad" ] && [ "$(cat "$STATE/bad")" = "$latest" ]; then exit 0; fi # schon als kaputt bekannt

version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE:latest")
log "Neue Version ${version:-?} gefunden"

# laufende Spiele nicht abwürgen – Lobbys leben nur im Arbeitsspeicher
if [ "$current" != none ] && [ "$FORCE" != "--now" ]; then
  for ((i = 0; i < MAX_WAIT_MIN * 6; i++)); do
    active=$(health | sed -n 's/.*"activeGames":\([0-9]*\).*/\1/p')
    [ "${active:-0}" = 0 ] && break
    [ "$i" = 0 ] && log "$active Spiel(e) laufen – warte, bis sie fertig sind (max. $MAX_WAIT_MIN min)"
    sleep 10
  done
fi

[ "$current" != none ] && docker tag "$current" "$IMAGE:previous"
docker compose up -d "$SERVICE" >/dev/null 2>&1

for ((i = 0; i < 30; i++)); do
  if health | grep -q '"ok":true'; then
    log "✔ ${version:-?} läuft"
    rm -f "$STATE/bad"
    exit 0
  fi
  sleep 2
done

log "✖ ${version:-?} startet nicht – zurück auf die vorige Version"
echo "$latest" >"$STATE/bad"
if [ "$current" != none ]; then
  docker tag "$IMAGE:previous" "$IMAGE:latest"
  docker compose up -d "$SERVICE" >/dev/null 2>&1
fi
exit 1
