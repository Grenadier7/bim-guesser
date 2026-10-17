// Wo der Server Laufzeitdaten ablegt (Auskunfts-Cache, Statistik).
// Standard: data/ im Projekt · im Container: STATE_DIR=/app/state (als Volume gemountet).
import path from 'node:path';

export const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : path.resolve(import.meta.dirname, '../data');
