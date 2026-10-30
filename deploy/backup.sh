#!/usr/bin/env bash
# BimGuesser-Sicherung auf Ditto (per cron als Benutzer mew, z.B. täglich 04:30):
#   30 4 * * * bash ~/docker/services/bimguesser/backup.sh >> ~/docker/services/bimguesser/backup.log 2>&1
#
# Warum so: die Sicherungen liegen in einem Ordner, den der BimGuesser-Container NIE sieht (er ist nirgends gemountet).
# Was auch immer jemand über die Admin-Seite oder eine Lücke im Server anstellt – an die Sicherungen kommt er nicht.
#  1. accounts.db wird in einem eigenen Wegwerf-Container (gleiches Image, ohne Netzwerk) per VACUUM INTO kopiert und
#     geprüft (integrity_check) – nur dieser Container sieht den Sicherungsordner, und nur für ein paar Sekunden
#  2. Spiel-Konfiguration und Netzpläne (state/config) als .tar.gz dazu
#  3. Sicherung schreibgeschützt ablegen, alte aufräumen: die letzten 14 Tage + je Woche eine für 12 Wochen
set -euo pipefail

SERVICE="${SERVICE:-oeffi-guesser}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/bimguesser}"
KEEP_DAYS=14
KEEP_WEEKS=12

exec 9>/tmp/oeffi-backup.lock
flock -n 9 || exit 0 # läuft schon

log() { echo "$(date '+%F %T') $*"; }

# State-Ordner und Image direkt am laufenden Container ablesen
SRC=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/state"}}{{.Source}}{{end}}{{end}}' "$SERVICE" 2>/dev/null || true)
IMAGE=$(docker inspect --format '{{.Image}}' "$SERVICE" 2>/dev/null || true)
if [ -z "$SRC" ] || [ -z "$IMAGE" ] || [ ! -f "$SRC/accounts.db" ]; then
  log "✖ Container $SERVICE oder $SRC/accounts.db nicht gefunden"
  exit 1
fi
case "$(realpath -m "$BACKUP_DIR")/" in
  "$(realpath -m "$SRC")/"*)
    log "✖ BACKUP_DIR liegt im State-Ordner – dort könnte der Container hin. Bitte einen Ordner außerhalb wählen."
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP=$(date '+%F_%H%M')
WORK=$(mktemp -d "$BACKUP_DIR/.neu-XXXXXX")
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

# 1. Datenbank – konsistente Kopie auch während der Server läuft (SQLite mit WAL)
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$SRC:/state" -v "$WORK:/out" --entrypoint node "$IMAGE" -e "
    const { DatabaseSync } = require('node:sqlite');
    new DatabaseSync('/state/accounts.db').exec(\"VACUUM INTO '/out/accounts.db'\");
    const r = new DatabaseSync('/out/accounts.db', { readOnly: true }).prepare('PRAGMA integrity_check').get();
    if (Object.values(r)[0] !== 'ok') { console.error('integrity_check:', JSON.stringify(r)); process.exit(1); }
  "

# 2. Konfiguration und Netzpläne (falls schon angelegt)
if [ -d "$SRC/config" ]; then tar -czf "$WORK/config.tar.gz" -C "$SRC" config; fi

# 3. fertig ablegen – schreibgeschützt
chmod 400 "$WORK"/*
chmod 500 "$WORK"
mv "$WORK" "$BACKUP_DIR/$STAMP"
trap - EXIT
log "✔ Sicherung $BACKUP_DIR/$STAMP ($(du -sh "$BACKUP_DIR/$STAMP" | cut -f1))"

# aufräumen: neueste je Tag für KEEP_DAYS Tage, neueste je Woche für KEEP_WEEKS Wochen, Rest weg
declare -A keep_day keep_week
now=$(date +%s)
for d in $(ls -1 "$BACKUP_DIR" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}$' | sort -r); do
  day=${d%_*}
  t=$(date -d "$day" +%s)
  age=$(((now - t) / 86400))
  week=$(date -d "$day" +%G-%V)
  if [ "$age" -lt "$KEEP_DAYS" ] && [ -z "${keep_day[$day]:-}" ]; then
    keep_day[$day]=1
    keep_week[$week]=1
  elif [ "$age" -lt $((KEEP_WEEKS * 7)) ] && [ -z "${keep_week[$week]:-}" ]; then
    keep_week[$week]=1
  else
    chmod -R u+w "$BACKUP_DIR/$d"
    rm -rf "${BACKUP_DIR:?}/$d"
    log "  alte Sicherung $d entfernt"
  fi
done
