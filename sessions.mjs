// Ciclo de vida das sessões, sem servidor à volta.
//
// Uma sessão é uma sala: nasce no primeiro sinal, morre no `SessionEnd` ou
// depois de trinta minutos calada, e ressuscita — reconstruída do zero — se
// voltar a mandar eventos. Mora aqui, e não dentro do `server.mjs`, para o
// `selftest.mjs` poder exercitar a morte e a ressurreição em Node.

import path from 'node:path';

// Rede de segurança: meia hora sem sinal e a sala é dada como perdida. Ficar
// pensando e só então digitar não deve custar o prédio — o próximo evento a
// ressuscita.
export const SESSION_TTL = 30 * 60 * 1000;

export function makeSession(id, cwd, now) {
  return {
    id,
    cwd: cwd || null,
    label: cwd ? path.basename(cwd) : id.slice(0, 8),
    startedAt: now,
    lastSeen: now,
    agents: new Map(),
    props: new Map(),
    history: [],
  };
}

/** Morta se recebeu `SessionEnd` ou se passou o TTL sem dar sinal. */
export function isDead(s, now) {
  return !!s.closed || now - s.lastSeen > SESSION_TTL;
}

/**
 * Abre (ou reabre) a sala da sessão e marca o sinal de vida. Uma sala morta que
 * volta a agir é descartada e reconstruída do zero — ninguém herda os agentes
 * nem o histórico da vida anterior.
 */
export function openSession(store, id, cwd, now) {
  let s = store.get(id);
  if (s && isDead(s, now)) {
    store.delete(id);
    s = undefined;
  }
  if (!s) {
    s = makeSession(id, cwd, now);
    store.set(id, s);
  }
  s.lastSeen = now;
  if (cwd && !s.cwd) {
    s.cwd = cwd;
    s.label = path.basename(cwd);
  }
  return s;
}

/** `SessionEnd`: a sala morre agora. */
export function endSession(store, id) {
  const s = store.get(id);
  if (s) s.closed = true;
}

/** Tira do armazém tudo que já morreu — chamado antes de listar. */
export function sweep(store, now) {
  for (const [id, s] of store) if (isDead(s, now)) store.delete(id);
}

/** As salas vivas, da mais recente para a mais antiga. Varre as mortas antes. */
export function liveSessions(store, now) {
  sweep(store, now);
  return [...store.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}
