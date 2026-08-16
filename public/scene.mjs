// Estado da cena, sem uma linha de DOM.
//
// Recebe eventos do servidor e devolve uma lista de comandos que o renderizador
// executa. A separação existe para o `selftest.mjs` poder exercitar toda a
// lógica de posicionamento em Node, sem navegador.
//
// Modelo espacial (issue #4): um térreo de serviço fixo embaixo, com as quatro
// estações singulares, e um 1º andar com cinco cômodos — um agente por cômodo,
// e os móveis desse agente dentro do cômodo dele.

export const PLAN = { w: 1000, h: 620 };

// Entrada do prédio, no canto do térreo. Quem sai do prédio caminha até aqui.
export const DOOR = { x: 30, y: 545 };

// Térreo de serviço: faixa fixa na base, sempre presente, não conta agentes.
export const GROUND = { y: 470, h: PLAN.h - 470 };

// As quatro estações canônicas (CONTEXT.md): recurso singular no prédio
// inteiro, sempre no térreo. A chave delas é global — um só de cada.
export const STATIONS = {
  terminal:   { x: 150, y: 545, label: 'TERMINAL' },
  library:    { x: 400, y: 545, label: 'BIBLIOTECA' },
  whiteboard: { x: 630, y: 545, label: 'QUADRO' },
  cabinet:    { x: 862, y: 545, label: 'ARQUIVO MORTO' },
};

// 1º andar: cinco cômodos lado a lado acima do térreo.
export const ROOMS_PER_FLOOR = 5;
export const FLOOR = { top: 40, bottom: GROUND.y - 14 };  // cômodos de y=40 a y=456
const ROOM_W = PLAN.w / ROOMS_PER_FLOOR;                  // 200

/** Retângulo do cômodo de índice `i`. É a única fonte de geometria do cômodo. */
export function roomRect(i) {
  const pad = 12;
  return {
    index: i,
    x: i * ROOM_W + pad,
    y: FLOOR.top,
    w: ROOM_W - pad * 2,          // 176
    h: FLOOR.bottom - FLOOR.top,  // 416
    cx: i * ROOM_W + ROOM_W / 2,  // centro horizontal
  };
}

/** Onde o robô fica parado no cômodo: centro, junto à base (perto do elevador). */
function roomHome(i) {
  const r = roomRect(i);
  return { x: r.cx, y: FLOOR.bottom - 46 };
}

/** Posição do n-ésimo móvel dentro de um cômodo. Grade de duas colunas. */
function propSlot(r, n) {
  const col = n % 2;
  const row = Math.floor(n / 2);
  return {
    x: r.cx + (col === 0 ? -40 : 40),
    // Presa ao cômodo: com muitos móveis a coluna empilha até a base e para,
    // para nenhum móvel escapar do cômodo do dono.
    y: Math.min(FLOOR.top + 78 + row * 58, FLOOR.bottom - 70),
  };
}

/** Onde o robô encosta para usar um móvel do próprio cômodo. */
function standAt(prop, i) {
  const r = roomRect(i);
  return {
    x: Math.max(r.x + 18, Math.min(prop.x, r.x + r.w - 18)),
    y: Math.min(prop.y + 44, FLOOR.bottom - 40),
  };
}

export function createScene() {
  return {
    agents: new Map(),
    props: new Map(),
  };
}

// ── cômodos ────────────────────────────────────────────────────────────────

/** Índice do primeiro cômodo livre. Vagas recicladas contam como livres. */
function allocRoom(scene, except) {
  const taken = new Set();
  for (const a of scene.agents.values()) if (a !== except && a.room != null) taken.add(a.room);
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) if (!taken.has(i)) return i;
  // Andar cheio: o crescimento para o 2º andar é a issue #7. Até lá, o excesso
  // reaproveita o último cômodo — nenhum cenário de #4 chega a seis agentes.
  return ROOMS_PER_FLOOR - 1;
}

// ── agentes e móveis ──────────────────────────────────────────────────────

function ensureAgent(scene, id, type, cmds) {
  let a = scene.agents.get(id);
  if (!a) {
    const isMain = id === 'main';
    a = {
      id,
      type: type || 'claude',
      isMain,
      hueIndex: isMain ? -1 : scene.agents.size % 5,
      face: 1,
      status: 'idle',
      tool: null,
      propKey: null,
      toolCount: 0,
      deskCursor: 0,
      since: Date.now(),
    };
    a.room = allocRoom(scene, a);
    const home = roomHome(a.room);
    a.x = home.x;
    a.y = home.y;
    scene.agents.set(id, a);
    // Emitido aqui, e não só no spawn: o agente principal nunca dá spawn —
    // ele aparece no primeiro evento que gerar, e sem isto ficava invisível.
    cmds?.push({ op: 'agent-enter', agent: a });
  }
  if (type && type !== 'main') a.type = type;
  return a;
}

function ensureProp(scene, agent, seed, cmds) {
  const station = STATIONS[seed.kind];
  // Estação: chave global, singular no prédio. Móvel: chave composta por agente
  // e recurso, então dois agentes no mesmo arquivo produzem dois móveis.
  const key = station ? seed.key : agent.id + '|' + seed.key;

  let p = scene.props.get(key);
  if (!p) {
    const pos = station
      ? { x: station.x, y: station.y, room: station.label, fixed: true, owner: null }
      : (() => {
          const s = propSlot(roomRect(agent.room), agent.deskCursor++);
          return { x: s.x, y: s.y, room: 'CÔMODO', fixed: false, owner: agent.id };
        })();
    p = { ...seed, key, ...pos, uses: 0, born: Date.now() };
    scene.props.set(key, p);
    cmds.push({ op: 'prop-add', prop: p });
  }
  if (seed.detail) p.detail = seed.detail;
  p.uses++;
  return p;
}

function moveTo(scene, a, x, y, cmds) {
  if (Math.abs(x - a.x) > 6) a.face = x > a.x ? 1 : -1;
  a.x = x;
  a.y = y;
  cmds.push({ op: 'agent-move', id: a.id, x, y, face: a.face });
}

// ── redutor ───────────────────────────────────────────────────────────────

/**
 * Aplica um evento do servidor.
 * @returns {Array} comandos para o renderizador executar
 */
const KINDS = new Set(['spawn', 'tool_start', 'tool_end', 'stop', 'prompt', 'turn_end', 'notify']);

export function apply(scene, ev) {
  // Validar antes de tocar no elenco: senão um evento que a cena não desenha
  // ainda assim faria nascer um robô na planta.
  if (!KINDS.has(ev.kind)) return [];

  const cmds = [];
  const a = ensureAgent(scene, ev.agentId, ev.agentType, cmds);

  switch (ev.kind) {
    case 'spawn': {
      a.status = 'walking';
      a.since = Date.now();
      const home = roomHome(a.room);
      moveTo(scene, a, home.x, home.y, cmds);
      break;
    }

    case 'tool_start': {
      const seed = ev.prop || { kind: 'desk', key: 'tool:' + ev.tool, label: ev.tool };
      a.status = 'working';
      a.tool = ev.tool;
      a.toolCount++;
      a.since = Date.now();

      // Convocar um subagente (a porta) e usar uma estação acontecem sem tirar o
      // robô do cômodo por ora: a linhagem é a issue #10 e a descida de elevador
      // até a estação é a #9. Até lá o robô trabalha do próprio cômodo.
      if (seed.kind === 'door') {
        a.propKey = null;
        const home = roomHome(a.room);
        moveTo(scene, a, home.x, home.y, cmds);
        cmds.push({ op: 'agent-state', agent: a });
        if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
        break;
      }

      const p = ensureProp(scene, a, seed, cmds);
      a.propKey = p.key;

      if (p.fixed) {
        const home = roomHome(a.room);
        moveTo(scene, a, home.x, home.y, cmds);
      } else {
        const spot = standAt(p, a.room);
        moveTo(scene, a, spot.x, spot.y, cmds);
      }
      cmds.push({ op: 'prop-hit', prop: p, by: a.id });
      cmds.push({ op: 'agent-state', agent: a });
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'brief' });
      break;
    }

    case 'tool_end': {
      a.status = 'idle';
      a.tool = null;
      a.propKey = null;
      a.since = Date.now();
      const home = roomHome(a.room);
      moveTo(scene, a, home.x, home.y, cmds);
      cmds.push({ op: 'agent-state', agent: a });
      break;
    }

    case 'stop':
      a.status = 'leaving';
      a.tool = null;
      a.propKey = null;
      moveTo(scene, a, DOOR.x, DOOR.y, cmds);
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'result' });
      cmds.push({ op: 'agent-leave', id: a.id });
      // O cômodo é liberado: some do elenco e a vaga volta ao pool.
      scene.agents.delete(a.id);
      break;

    case 'prompt':
      cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
      break;

    case 'turn_end': {
      a.status = 'idle';
      a.tool = null;
      a.propKey = null;
      a.since = Date.now();
      const home = roomHome(a.room);
      moveTo(scene, a, home.x, home.y, cmds);
      cmds.push({ op: 'agent-state', agent: a });
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'result' });
      break;
    }

    case 'notify':
      cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'brief' });
      break;

    default:
      return cmds;
  }

  cmds.push({ op: 'log', event: ev });
  return cmds;
}

/** Reconstrói a cena a partir do estado que o servidor guarda (troca de sessão). */
export function hydrate(scene, room) {
  scene.agents.clear();
  scene.props.clear();
  const cmds = [];
  if (!room) return cmds;

  // O servidor guarda o móvel atual de cada agente pela chave global; aqui ele
  // renasce dentro do cômodo do dono, com a chave composta do novo modelo.
  const seedByKey = new Map((room.props || []).map((p) => [p.key, p]));

  for (const raw of room.agents) {
    const enters = [];
    const a = ensureAgent(scene, raw.id, raw.type, enters);
    a.status = raw.status === 'working' ? 'working' : 'idle';
    a.tool = raw.tool || null;
    a.toolCount = raw.toolCount || 0;

    let spot = roomHome(a.room);
    if (raw.prop && seedByKey.has(raw.prop)) {
      const p = ensureProp(scene, a, seedByKey.get(raw.prop), cmds);
      a.propKey = p.key;
      spot = p.fixed ? roomHome(a.room) : standAt(p, a.room);
    }
    a.x = spot.x;
    a.y = spot.y;

    // Ao trocar de sessão ninguém "chega": todo mundo já está no lugar.
    for (const c of enters) cmds.push({ ...c, instant: true });
  }
  return cmds;
}
