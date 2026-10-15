import type { QuizSettings } from '../../shared/quiz.ts';
import type {
  GameMode,
  GameSettings,
  LatLon,
  LobbyState,
  Guesses,
  JoinResponse,
  NetworkPublic,
  RoundReveal,
  SubmitResponse,
  TipKind,
  TrainingResult,
  TrainingRound,
  TipResult,
  UserLeg,
} from '../../shared/types.ts';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Lobby-Code + geheimer Spieler-Token */
export interface Auth {
  code: string;
  token: string;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

const g = (code: string) => `/api/games/${encodeURIComponent(code)}`;
const q = (a: Auth) => `token=${encodeURIComponent(a.token)}`;

export const api = {
  network: () => call<NetworkPublic>('GET', '/api/network'),
  create: (playerName: string, mode: GameMode, settings: Partial<GameSettings> | Partial<QuizSettings>) =>
    call<JoinResponse>('POST', '/api/games', { playerName, mode, settings }),
  join: (code: string, playerName: string) => call<JoinResponse>('POST', `${g(code)}/join`, { playerName }),
  state: (a: Auth) => call<{ playerId: string; state: LobbyState }>('GET', `${g(a.code)}?${q(a)}`),
  settings: (a: Auth, settings: Partial<GameSettings> | Partial<QuizSettings>) => call<LobbyState>('PUT', `${g(a.code)}/settings`, { token: a.token, settings }),
  start: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/start`, { token: a.token }),
  next: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/next`, { token: a.token }),
  lobby: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/lobby`, { token: a.token }),
  leave: (a: Auth) => call<{ ok: boolean }>('POST', `${g(a.code)}/leave`, { token: a.token }),
  pause: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/pause`, { token: a.token }),
  resume: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/resume`, { token: a.token }),
  cancel: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/cancel`, { token: a.token }),
  tip: (a: Auth, round: number, kind: TipKind) => call<TipResult>('POST', `${g(a.code)}/rounds/${round}/tips`, { token: a.token, kind }),
  tips: (a: Auth, round: number) => call<TipResult[]>('GET', `${g(a.code)}/rounds/${round}/tips?${q(a)}`),
  submit: (a: Auth, round: number, legs: UserLeg[], guesses: Guesses | null) =>
    call<SubmitResponse>('POST', `${g(a.code)}/rounds/${round}/submit`, { token: a.token, legs, guesses }),
  forceReveal: (a: Auth, round: number) => call<RoundReveal>('POST', `${g(a.code)}/rounds/${round}/reveal`, { token: a.token }),
  reveal: (a: Auth, round: number) => call<RoundReveal>('GET', `${g(a.code)}/rounds/${round}/reveal?${q(a)}`),
  eventsUrl: (a: Auth) => `${g(a.code)}/events?${q(a)}`,
  quizAnswer: (a: Auth, index: number, answer: string | string[] | LatLon | LatLon[]) =>
    call<LobbyState>('POST', `${g(a.code)}/quiz/answer`, { token: a.token, index, answer }),
  quizReveal: (a: Auth) => call<LobbyState>('POST', `${g(a.code)}/quiz/reveal`, { token: a.token }),
  trainingRound: (settings: Partial<GameSettings>, pair?: { from: string; to: string }) =>
    call<TrainingRound>('POST', '/api/training/round', { settings, pair }),
  trainingEvaluate: (id: string, legs: UserLeg[]) => call<TrainingResult>('POST', `/api/training/${encodeURIComponent(id)}/evaluate`, { legs }),
};
