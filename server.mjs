#!/usr/bin/env node
// Servidor do escritorio dos agentes.
//
// Ouve os eventos dos hooks, traduz cada um para o evento que a cena entende,
// guarda no buffer da sessao (uma por sessao do Claude Code) e transmite via
// SSE. Nao mantem cena propria: nem agentes, nem moveis, nem instantaneo
// montado. Quem monta o predio e o cliente, aplicando a lista de eventos desde
// o inicio (ADR-0001). O servidor so guarda metadados e a lista de eventos.
//
// Zero dependencias: so Node.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shape } from './shape.mjs';
import { appendEvent } from './logstore.mjs';

const PORT = Number(process.env.AGENT_OFFICE_PORT || 4517);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

const HISTORY = 300;         // eventos guardados por sala, para quem chega depois
const SESSION_TTL = 6 * 60 * 60 * 1000;  // sala esquecida apos 6h sem sinal

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Set<http.ServerResponse>} */
const clients = new Set();

let seq = 0;

function session(id, cwd) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      cwd: cwd || null,
      label: cwd ? path.basename(cwd) : id.slice(0, 8),
      startedAt: Date.now(),
      lastSeen: Date.now(),
      events: [],
    };
    sessions.set(id, s);
  }
  s.lastSeen = Date.now();
  if (cwd && !s.cwd) {
    s.cwd = cwd;
    s.label = path.basename(cwd);
  }
  return s;
}

// Numera o evento e o guarda no buffer da sessao. Nao monta cena nenhuma: a
// unica leitura que o servidor faz do conteudo e o `session_end`, que e
// metadado de sessao (marca a sala como fechada no seletor), nao estado de cena.
function ingest(ev) {
  const s = session(ev.session, ev.cwd);
  if (ev.kind === 'session_end') s.closed = true;

  const out = { ...ev, seq: ++seq };
  s.events.push(out);
  if (s.events.length > HISTORY) s.events.shift();
  return out;
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function snapshot() {
  sweep();
  return {
    type: 'snapshot',
    now: Date.now(),
    sessions: [...sessions.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((s) => ({
        id: s.id,
        label: s.label,
        cwd: s.cwd,
        closed: !!s.closed,
        lastSeen: s.lastSeen,
        events: s.events,
      })),
  };
}

function sweep() {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}

// ── HTTP: hooks, pagina e fluxo SSE ───────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  // Sem o .mjs aqui o navegador recebe octet-stream e recusa o modulo.
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Entrada dos hooks do Claude Code. Precisa responder 2xx com corpo vazio:
  // qualquer outra coisa vira um aviso de erro no transcript do usuario.
  if (url.pathname === '/hook' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4_000_000) req.destroy();
    });
    req.on('error', () => {});
    req.on('end', () => {
      res.writeHead(204).end();
      try {
        const ev = shape(JSON.parse(body));
        if (ev) {
          const out = ingest(ev);
          // Grava o log em disco antes de transmitir. Ninguém o relê — é arquivo
          // morto, guardado para não fechar a porta de um replay futuro.
          appendEvent(out);
          broadcast({ type: 'event', event: out });
        }
      } catch {
        /* payload estranho nao derruba o escritorio */
      }
    });
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* a limpeza acontece no close */
      }
    }, 20_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot(), null, 2));
    return;
  }

  // Estatico, preso dentro de public/.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('proibido');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('nao encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🏢  Escritorio dos agentes`);
  console.log(`      http://127.0.0.1:${PORT}`);
  console.log(`      recebendo hooks em POST /hook\n`);
});
