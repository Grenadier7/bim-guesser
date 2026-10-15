// Quiz – Mehrspieler: alle bekommen dieselbe Frage, Punkte für richtig und schnell.
import type { LatLon, QuizAnswerResult, QuizRevealPublic, QuizState } from '../shared/types.ts';
import { linePatterns } from '../shared/rules.ts';
import {
  DEFAULT_QUIZ_SETTINGS,
  generateQuiz,
  gradeQuiz,
  publicQuestion,
  quizPoints,
  sanitizeQuizSettings,
  type QuizNet,
  type QuizQuestion,
  type QuizSettings,
} from '../shared/quiz.ts';
import { DEADLINE_GRACE_MS, GameError, Lobby } from './lobby.ts';
import type { Network } from './network.ts';

interface Answer {
  answer: unknown;
  elapsedMs: number;
}

/** Netzdaten im Format, das die Fragen-Erzeugung braucht */
export function quizNet(net: Network): QuizNet {
  const cache = new Map<string, string[][]>();
  return {
    stations: net.data.stations,
    station: (id) => net.station(id),
    line: (id) => net.lines.get(id),
    lines: net.data.lines,
    districts: net.data.districts,
    patterns(l) {
      let hit = cache.get(l.id);
      if (!hit) {
        const reg = linePatterns(l, 'regular');
        hit = reg.length ? reg : linePatterns(l, 'current');
        cache.set(l.id, hit);
      }
      return hit;
    },
  };
}

/** Antwort aus dem Request in eine erlaubte Form bringen */
function cleanAnswer(q: QuizQuestion, a: unknown): unknown {
  if (q.type === 'draw') {
    // Skizze: Liste von Punkten (begrenzt)
    if (!Array.isArray(a)) return null;
    const pts: LatLon[] = [];
    for (const p of a.slice(0, 80)) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      const [lat, lon] = p.map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat - 48.2) < 1 && Math.abs(lon - 16.4) < 1) pts.push([lat, lon]);
    }
    return pts;
  }
  if (q.type === 'locate') {
    if (!Array.isArray(a) || a.length !== 2) return null;
    const [lat, lon] = a.map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? ([lat, lon] as LatLon) : null;
  }
  const ids = new Set((q.options ?? []).map((o) => o.id));
  if (q.multi) return Array.isArray(a) ? [...new Set(a.map(String))].filter((x) => ids.has(x)) : [];
  return ids.has(String(a)) ? String(a) : null;
}

export class QuizGame extends Lobby {
  readonly mode = 'quiz' as const;
  settings: QuizSettings;
  private qnet: QuizNet;
  private questions: QuizQuestion[] = [];
  private current = -1;
  private status: 'open' | 'revealed' | null = null;
  private answers = new Map<string, Answer>();
  private reveal: QuizRevealPublic | null = null;
  private startedAt: number | null = null;
  private deadline: number | null = null;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(id: string, net: QuizNet, settings: unknown) {
    super(id);
    this.qnet = net;
    this.settings = sanitizeQuizSettings(settings as Partial<QuizSettings>, DEFAULT_QUIZ_SETTINGS);
  }

  // -------------------------------------------------------------- Lobby

  updateSettings(token: string, s: unknown) {
    this.requireHost(token);
    if (this.phase !== 'lobby') throw new GameError('Einstellungen nur in der Lobby änderbar.');
    this.settings = sanitizeQuizSettings(s as Partial<QuizSettings>, this.settings);
    this.touch();
    this.emitState();
  }

  async start(token: string) {
    this.requireHost(token);
    if (this.phase !== 'lobby') return;
    this.questions = generateQuiz(this.qnet, this.settings);
    if (!this.questions.length) throw new GameError('Für diese Einstellungen gibt es keine Fragen – Gebiet oder Verkehrsmittel erweitern.');
    for (const p of this.players.values()) p.score = 0;
    this.phase = 'playing';
    this.open(0);
  }

  async next(token: string) {
    this.requireHost(token);
    if (this.phase !== 'playing' || this.status !== 'revealed') throw new GameError('Frage ist noch nicht aufgelöst.');
    if (this.current + 1 >= this.questions.length) {
      this.phase = 'finished';
      this.status = null;
      this.touch();
      this.emitState();
      return;
    }
    this.open(this.current + 1);
  }

  backToLobby(token: string) {
    this.requireHost(token);
    this.clearTimer();
    this.phase = 'lobby';
    this.questions = [];
    this.current = -1;
    this.status = null;
    this.reveal = null;
    for (const p of this.players.values()) p.score = 0;
    this.touch();
    this.emitState();
  }

  private open(i: number) {
    this.current = i;
    this.status = 'open';
    this.answers.clear();
    this.reveal = null;
    this.pausedAt = null;
    this.pausedTotal = 0;
    this.startedAt = Date.now();
    this.deadline = this.startedAt + this.limitSec() * 1000;
    this.arm();
    this.touch();
    this.emitState();
  }

  /** Zeitlimit der aktuellen Frage (Linie zeichnen hat mehr Zeit) */
  private limitSec(): number {
    return this.questions[this.current]?.timeSec ?? this.settings.timeSec;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm() {
    this.clearTimer();
    if (!this.deadline) return;
    this.timer = setTimeout(() => {
      if (this.status === 'open' && !this.pausedAt) this.doReveal(false);
    }, Math.max(0, this.deadline - Date.now()) + DEADLINE_GRACE_MS);
    this.timer.unref();
  }

  // -------------------------------------------------------------- Host-Steuerung

  pause(token: string) {
    this.requireHost(token);
    if (this.status !== 'open' || this.pausedAt) return;
    this.pausedAt = Date.now();
    this.clearTimer();
    this.emitState();
  }

  resume(token: string) {
    this.requireHost(token);
    if (this.status !== 'open' || !this.pausedAt) return;
    const d = Date.now() - this.pausedAt;
    this.pausedTotal += d;
    if (this.deadline) this.deadline += d;
    this.pausedAt = null;
    this.arm();
    this.emitState();
  }

  /** Frage überspringen: Lösung zeigen, keine Punkte */
  cancelRound(token: string) {
    this.requireHost(token);
    if (this.status !== 'open') throw new GameError('Keine offene Frage.');
    this.doReveal(true);
  }

  forceReveal(token: string) {
    this.requireHost(token);
    if (this.status !== 'open') throw new GameError('Keine offene Frage.');
    this.doReveal(false);
  }

  protected onPresenceChange() {
    this.maybeReveal();
  }

  // -------------------------------------------------------------- Antworten

  answer(token: string, index: number, answer: unknown) {
    const p = this.auth(token);
    if (index !== this.current || this.status !== 'open') throw new GameError('Diese Frage ist nicht mehr offen.');
    if (this.pausedAt) throw new GameError('Das Quiz ist gerade pausiert.', 409);
    if (this.answers.has(p.id)) throw new GameError('Schon geantwortet.');
    const now = Date.now();
    if (this.deadline && now > this.deadline + DEADLINE_GRACE_MS) throw new GameError('Zeit abgelaufen');
    const q = this.questions[this.current];
    this.answers.set(p.id, {
      answer: cleanAnswer(q, answer),
      elapsedMs: Math.min(now - this.startedAt! - this.pausedTotal, this.limitSec() * 1000),
    });
    this.touch();
    this.emitState();
    this.maybeReveal();
  }

  private maybeReveal() {
    if (this.status !== 'open' || this.answers.size === 0) return;
    const waiting = [...this.players.values()].filter((p) => !this.answers.has(p.id) && this.isConnected(p));
    if (!waiting.length) this.doReveal(false);
  }

  private doReveal(cancelled: boolean) {
    this.clearTimer();
    const q = this.questions[this.current];
    const limit = this.limitSec() * 1000;
    const results: QuizAnswerResult[] = [...this.players.values()].map((p) => {
      const a = this.answers.get(p.id);
      const base = a && !cancelled ? gradeQuiz(q, a.answer) : 0;
      // "Linie zeichnen": nur Genauigkeit zählt, nicht das Tempo
      const points = a && !cancelled ? (q.type === 'draw' ? Math.round(base * 1000) : quizPoints(base, a.elapsedMs, limit)) : 0;
      p.score += points;
      return {
        playerId: p.id,
        playerName: p.name,
        answer: (a?.answer as QuizAnswerResult['answer']) ?? null,
        base,
        points,
        elapsedSec: a ? Math.round(a.elapsedMs / 100) / 10 : null,
      };
    });
    results.sort((x, y) => y.points - x.points);
    this.reveal = {
      correct: q.correct,
      explanation: q.explanation,
      revealStationId: q.revealStationId ?? q.stationId ?? null,
      revealLineId: q.revealLineId ?? q.drawLineId ?? null,
      results,
      cancelled,
    };
    this.status = 'revealed';
    this.pausedAt = null;
    this.touch();
    this.emitState();
  }

  // -------------------------------------------------------------- Zustand

  state(): QuizState {
    const q = this.questions[this.current];
    return {
      mode: 'quiz',
      id: this.id,
      serverNow: Date.now(),
      settings: this.settings,
      phase: this.phase,
      players: this.playersPublic(),
      current: this.current,
      total: this.questions.length || this.settings.questions,
      status: this.status,
      question: q && this.status ? publicQuestion(q) : null,
      answered: [...this.answers.keys()],
      startedAt: this.startedAt,
      deadline: this.status === 'open' ? this.deadline : null,
      pausedAt: this.pausedAt,
      reveal: this.status === 'revealed' ? this.reveal : null,
    };
  }
}
