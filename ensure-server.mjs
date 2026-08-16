#!/usr/bin/env node
// Sobe o escritório se ele ainda não estiver de pé.
//
// Roda como hook de SessionStart — uma vez por sessão do Claude Code, não a
// cada ferramenta, então o custo de iniciar o Node aqui é irrelevante. Sem
// isso, abrir uma sessão com o servidor fechado encheria o transcript de
// avisos de hook falhando.

import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AGENT_OFFICE_PORT || 4517);
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

process.on('uncaughtException', () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();

function listening() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(500);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

if (await listening()) {
  process.exit(0);
}

const child = spawn(process.execPath, [SERVER], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

// Espera o socket abrir antes de sair: assim o primeiro hook da sessão, que
// vem logo atrás, já encontra alguém escutando.
for (let i = 0; i < 20; i++) {
  if (await listening()) break;
  await new Promise((r) => setTimeout(r, 100));
}

process.exit(0);
