#!/usr/bin/env bash
# Öffi-Guesser auf Ditto aktuell halten (läuft per cron alle 2 min als Benutzer mew):
#  1. neues Image :latest von ghcr.io holen – nichts Neues → fertig
#  2. warten, bis kein Spiel läuft (max. 15 min; "--now" überspringt das)
#  3. Container mit dem neuen Image neu erstellen und prüfen: läuft wirklich das neue Image, antwortet /api/health?
#  4. klappt das nicht → zurück auf die vorige Version, die kaputte wird gemerkt und übersprungen
set -uo pipefail

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
running_image() { docker inspect --format '{{.Image}}' "$SERVICE" 2>/dev/null || echo none; }

# Compose-Projekt direkt am laufenden Container ablesen – egal, in welchem Ordner die compose.yml liegt
label() { docker inspect --format "{{index .Config.Labels \"$1\"}}" "$SERVICE" 2>/dev/null; }
WORKDIR=$(label com.docker.compose.project.working_dir)
FILES=$(label com.docker.compose.project.config_files)
PROJECT=$(label com.docker.compose.project)
if [ -z "$WORKDIR" ] || [ -z "$FILES" ]; then
  log "✖ Container $SERVICE nicht gefunden (oder nicht per docker compose gestartet) – zuerst einmal von Hand starten"
  exit 1
fi
compose() {
  local args=(--project-directory "$WORKDIR" -p "$PROJECT")
  local f
  IFS=',' read -ra cfgs <<<"$FILES"
  for f in "${cfgs[@]}"; do args+=(-f "$f"); done
  docker compose "${args[@]}" "$@"
}

mkdir -p "$STATE"
docker pull -q "$IMAGE:latest" >/dev/null 2>&1 || { log "✖ Pull von $IMAGE:latest fehlgeschlagen"; exit 1; }
latest=$(docker image inspect --format '{{.Id}}' "$IMAGE:latest")
current=$(running_image)
[ "$latest" = "$current" ] && exit 0
if [ -f "$STATE/bad" ] && [ "$(cat "$STATE/bad")" = "$latest" ]; then exit 0; fi # schon als kaputt bekannt

version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE:latest")
log "Neue Version ${version:-?} gefunden"

# laufende Spiele nicht abwürgen – Lobbys leben nur im Arbeitsspeicher
if [ "$FORCE" != "--now" ]; then
  for ((i = 0; i < MAX_WAIT_MIN * 6; i++)); do
    active=$(health | sed -n 's/.*"activeGames":\([0-9]*\).*/\1/p')
    [ "${active:-0}" = 0 ] && break
    [ "$i" = 0 ] && log "$active Spiel(e) laufen – warte, bis sie fertig sind (max. $MAX_WAIT_MIN min)"
    sleep 10
  done
fi

docker tag "$current" "$IMAGE:previous"
if ! out=$(compose up -d --no-deps "$SERVICE" 2>&1); then
  log "✖ docker compose up fehlgeschlagen:"
  echo "$out"
  exit 1
fi

ok=0
for ((i = 0; i < 30; i++)); do
  if [ "$(running_image)" = "$latest" ] && health | grep -q '"ok":true'; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" = 1 ]; then
  log "✔ ${version:-?} läuft"
  rm -f "$STATE/bad"
  exit 0
fi

log "✖ ${version:-?} läuft nicht (Image oder Health-Check) – zurück auf die vorige Version"
echo "$out"
echo "$latest" >"$STATE/bad"
docker tag "$IMAGE:previous" "$IMAGE:latest"
compose up -d --no-deps "$SERVICE" >/dev/null 2>&1
exit 1
