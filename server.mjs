#!/usr/bin/env node
// Servidor do escritorio dos agentes.
//
// Ouve os eventos dos hooks em UDP, mantem o estado de cada sala (uma por
// sessao do Claude Code) e transmite tudo para o navegador via SSE.
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
      agents: new Map(),
      props: new Map(),
      history: [],
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

function agent(s, id, type) {
  let a = s.agents.get(id);
  if (!a) {
    a = {
      id,
      type: type || 'claude',
      isMain: id === 'main',
      status: 'idle',
      tool: null,
      prop: null,
      spawnedAt: Date.now(),
      lastSeen: Date.now(),
      toolCount: 0,
    };
    s.agents.set(id, a);
  }
  a.lastSeen = Date.now();
  if (type && type !== 'main') a.type = type;
  return a;
}

// Traduz o evento cru do hook em mutacao de estado + evento de animacao.
function ingest(ev) {
  const s = session(ev.session, ev.cwd);
  const a = agent(s, ev.agentId, ev.agentType);

  switch (ev.kind) {
    case 'spawn':
      a.status = 'entering';
      a.spawnedAt = Date.now();
      break;

    case 'stop':
      a.status = 'leaving';
      a.tool = null;
      a.prop = null;
      break;

    case 'tool_start':
      a.status = 'working';
      a.tool = ev.tool;
      a.prop = ev.prop?.key || null;
      a.toolCount++;
      if (ev.prop) {
        const p = s.props.get(ev.prop.key) || { ...ev.prop, firstSeen: Date.now(), uses: 0 };
        p.uses++;
        p.lastUsed = Date.now();
        p.detail = ev.prop.detail ?? p.detail;
        s.props.set(ev.prop.key, p);
      }
      break;

    case 'tool_end':
      // Um Read termina em milissegundos; deixar o boneco parado na mesa por um
      // instante e o que faz a animacao ser legivel. O front controla o atraso.
      a.status = 'idle';
      a.tool = null;
      break;

    case 'prompt':
      // Turno novo: todo mundo que ficou pendurado volta a ser irrelevante.
      for (const other of s.agents.values()) {
        if (!other.isMain && Date.now() - other.lastSeen > 60_000) s.agents.delete(other.id);
      }
      a.status = 'idle';
      break;

    case 'turn_end':
      a.status = 'idle';
      a.tool = null;
      break;

    case 'session_end':
      s.closed = true;
      break;
  }

  const out = { ...ev, seq: ++seq };
  s.history.push(out);
  if (s.history.length > HISTORY) s.history.shift();
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
        agents: [...s.agents.values()],
        props: [...s.props.values()],
        history: s.history,
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
