// Grava o log de eventos em disco — um arquivo `.jsonl` por sessão, um evento
// por linha, conforme os eventos chegam.
//
// É arquivo morto de propósito: nada aqui lê o log. A porta de um replay futuro
// fica aberta (a cena é função pura dos eventos, então reaplicar o log
// reconstrói o prédio), mas esta versão só escreve. Quem for implementar leitura
// deve fazê-lo em outro lugar — o servidor não pode ler no boot nem na conexão
// de um cliente.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ensured = new Set();

/** Onde os logs moram. Sobrescrevível para o teste não sujar a pasta do projeto. */
export function logDir() {
  return process.env.AGENT_OFFICE_LOG_DIR || path.join(HERE, 'logs');
}

/** O arquivo de uma sessão. O id vira nome de arquivo seguro. */
export function logPathFor(sessionId, dir = logDir()) {
  const safe = String(sessionId ?? 'desconhecida').replace(/[^A-Za-z0-9._-]/g, '_') || 'desconhecida';
  return path.join(dir, safe + '.jsonl');
}

/**
 * Acrescenta um evento ao log da sua sessão. Síncrono e append-only para manter
 * a ordem de chegada; um erro de disco não pode derrubar o escritório.
 * @param {{session?: string}} event  o evento já traduzido, como o servidor transmite
 */
export function appendEvent(event, dir = logDir()) {
  try {
    if (!ensured.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      ensured.add(dir);
    }
    fs.appendFileSync(logPathFor(event.session, dir), JSON.stringify(event) + '\n');
  } catch {
    /* disco cheio ou pasta somente-leitura não pode quebrar o servidor */
  }
}
