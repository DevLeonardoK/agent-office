// Estado da cena, sem uma linha de DOM.
//
// Recebe eventos do servidor e devolve uma lista de comandos que o renderizador
// executa. A separação existe para o `selftest.mjs` poder exercitar toda a
// lógica de posicionamento em Node, sem navegador.

export const PLAN = { w: 1000, h: 620 };
export const DOOR = { x: 58, y: 300 };

// Estações fixas: recursos que só existem em um exemplar no prédio ganham
// endereço próprio, com o nome que aparece na planta.
export const STATIONS = {
  whiteboard: { x: 178, y: 168, label: 'QUADRO' },
  terminal:   { x: 178, y: 468, label: 'TERMINAL' },
  cabinet:    { x: 872, y: 168, label: 'ARQUIVO' },
  library:    { x: 872, y: 318, label: 'BIBLIOTECA' },
  shelf:      { x: 872, y: 468, label: 'MANUAIS' },
};

// Arquivos são muitos e imprevisíveis, então ganham uma grade de mesas.
const DESK_COLS = [340, 468, 596, 724];
const DESK_ROWS = [168, 318, 468];
const DESKS = DESK_ROWS.flatMap((y) => DESK_COLS.map((x) => ({ x, y })));

const CORRIDOR_Y = 566;   // onde quem está ocioso espera

export function createScene() {
  return {
    agents: new Map(),
    props: new Map(),
    deskCursor: 0,
  };
}

// ── posicionamento ────────────────────────────────────────────────────────

function placeProp(scene, seed) {
  const fixed = STATIONS[seed.kind];
  if (fixed) return { x: fixed.x, y: fixed.y, room: fixed.label, fixed: true };

  const desk = DESKS[scene.deskCursor % DESKS.length];
  scene.deskCursor++;
  return { x: desk.x, y: desk.y, room: 'MESAS', fixed: false };
}

/** Onde o boneco fica em pé para usar o móvel. `rank` desempata quem chegou junto. */
export function station(prop, rank = 0) {
  const above = prop.y > PLAN.h / 2;          // móvel embaixo: aborda por cima
  const side = rank % 2 === 0 ? 1 : -1;
  const spread = Math.ceil(rank / 2) * 40;
  // Folga suficiente para o boneco não cobrir o rótulo do móvel: ele tem 46px
  // acima dos pés, e o rótulo desce ~52px abaixo do centro do símbolo.
  return {
    x: prop.x + side * spread,
    y: prop.y + (above ? -62 : 100),
  };
}

function corridorSpot(scene, agent) {
  const others = [...scene.agents.values()].filter((a) => a !== agent);
  const lane = others.length;
  return { x: 306 + (lane % 6) * 84, y: CORRIDOR_Y - (lane % 2) * 26 };
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
      since: Date.now(),
    };
    a.home = corridorSpot(scene, a);
    // Subagentes chegam de fora; o principal já estava no prédio.
    a.x = isMain ? a.home.x : DOOR.x;
    a.y = isMain ? a.home.y : DOOR.y;
    scene.agents.set(id, a);
    // Emitido aqui, e não só no spawn: o agente principal nunca dá spawn —
    // ele aparece no primeiro evento que gerar, e sem isto ficava invisível.
    cmds?.push({ op: 'agent-enter', agent: a });
  }
  if (type && type !== 'main') a.type = type;
  return a;
}

function ensureProp(scene, seed, cmds) {
  let p = scene.props.get(seed.key);
  if (!p) {
    p = { ...seed, ...placeProp(scene, seed), uses: 0, born: Date.now() };
    scene.props.set(seed.key, p);
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
  // ainda assim faria nascer um boneco na planta.
  if (!KINDS.has(ev.kind)) return [];

  const cmds = [];
  const a = ensureAgent(scene, ev.agentId, ev.agentType, cmds);

  switch (ev.kind) {
    case 'spawn': {
      a.status = 'walking';
      a.since = Date.now();
      const spot = corridorSpot(scene, a);
      a.home = spot;
      moveTo(scene, a, spot.x, spot.y, cmds);
      break;
    }

    case 'tool_start': {
      const seed = ev.prop || { kind: 'desk', key: 'tool:' + ev.tool, label: ev.tool };

      // Convocar um subagente acontece na porta — e a porta já está desenhada
      // na planta, então não vira mobília no meio da sala.
      if (seed.kind === 'door') {
        a.status = 'working';
        a.tool = ev.tool;
        a.propKey = null;
        a.toolCount++;
        // Bem junto da porta: mais para dentro esbarraria na estação do quadro.
        moveTo(scene, a, DOOR.x + 62, DOOR.y, cmds);
        cmds.push({ op: 'agent-state', agent: a });
        if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
        break;
      }

      const p = ensureProp(scene, seed, cmds);
      a.status = 'working';
      a.tool = ev.tool;
      a.propKey = p.key;
      a.toolCount++;
      a.since = Date.now();

      const rank = [...scene.agents.values()].filter((o) => o !== a && o.propKey === p.key).length;
      const s = station(p, rank);
      moveTo(scene, a, s.x, s.y, cmds);
      cmds.push({ op: 'prop-hit', prop: p, by: a.id });
      cmds.push({ op: 'agent-state', agent: a });
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'brief' });
      break;
    }

    case 'tool_end':
      a.status = 'idle';
      a.tool = null;
      a.propKey = null;
      a.since = Date.now();
      cmds.push({ op: 'agent-state', agent: a });
      break;

    case 'stop':
      a.status = 'leaving';
      a.tool = null;
      a.propKey = null;
      moveTo(scene, a, DOOR.x, DOOR.y, cmds);
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'result' });
      cmds.push({ op: 'agent-leave', id: a.id });
      scene.agents.delete(a.id);
      break;

    case 'prompt':
      cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
      break;

    case 'turn_end':
      a.status = 'idle';
      a.tool = null;
      a.propKey = null;
      a.since = Date.now();
      moveTo(scene, a, a.home.x, a.home.y, cmds);
      cmds.push({ op: 'agent-state', agent: a });
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'result' });
      break;

    case 'notify':
      cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'brief' });
      break;

    default:
      return cmds;
  }

  cmds.push({ op: 'log', event: ev });
  return cmds;
}

/** Reconstrói a cena a partir do estado que o servidor guarda (troca de sala). */
export function hydrate(scene, room) {
  scene.agents.clear();
  scene.props.clear();
  scene.deskCursor = 0;
  const cmds = [];
  if (!room) return cmds;

  for (const seed of room.props) ensureProp(scene, seed, cmds);

  for (const raw of room.agents) {
    const enters = [];
    const a = ensureAgent(scene, raw.id, raw.type, enters);
    a.status = raw.status === 'working' ? 'working' : 'idle';
    a.tool = raw.tool;
    a.toolCount = raw.toolCount || 0;
    a.propKey = raw.prop || null;

    // Ao trocar de sala ninguém "chega": todo mundo já está no lugar.
    const p = a.propKey && scene.props.get(a.propKey);
    const spot = p ? station(p) : a.home;
    a.x = spot.x;
    a.y = spot.y;
    for (const c of enters) cmds.push({ ...c, instant: true });
  }
  return cmds;
}
