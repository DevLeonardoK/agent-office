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

// Andares empilhados: cada um tem cinco cômodos lado a lado. O 1º andar (andar
// 0) fica logo acima do térreo; cada andar novo (issue #7) sobe sobre o
// anterior. O cômodo é endereçado por um índice global: andar = ⌊slot / 5⌋,
// coluna = slot % 5. O andar 0 nunca muda de geometria, então o cômodo do
// principal (MAIN_ROOM) tem endereço constante a sessão inteira.
export const ROOMS_PER_FLOOR = 5;
export const FLOOR = { top: 40, bottom: GROUND.y - 14 };  // andar 0: y=40 a y=456
const ROOM_W = PLAN.w / ROOMS_PER_FLOOR;                  // 200
const FLOOR_H = FLOOR.bottom - FLOOR.top;                 // 416
const SLAB = 14;                                          // laje entre andares
const FLOOR_PITCH = FLOOR_H + SLAB;                       // quanto cada andar sobe

// Cômodo reservado ao agente principal: sempre no andar 0, nunca reciclado.
export const MAIN_ROOM = 0;

/** Retângulo do cômodo do slot global `slot`. Única fonte de geometria. */
export function roomRect(slot) {
  const floor = Math.floor(slot / ROOMS_PER_FLOOR);
  const col = slot % ROOMS_PER_FLOOR;
  const pad = 12;
  return {
    x: col * ROOM_W + pad,
    y: FLOOR.top - floor * FLOOR_PITCH,   // andares acima têm y menor
    w: ROOM_W - pad * 2,                  // 176
    h: FLOOR_H,                           // 416
    cx: col * ROOM_W + ROOM_W / 2,        // centro horizontal
  };
}

/** Quantos andares o prédio tem agora. Deriva da ocupação: andar vazio some. */
export function floorCount(scene) {
  let max = 0;
  for (const a of scene.agents.values()) {
    if (a.room != null) max = Math.max(max, Math.floor(a.room / ROOMS_PER_FLOOR));
  }
  return max + 1;
}

/** Onde o robô fica parado no cômodo: centro, junto à base (perto do elevador). */
function roomHome(slot) {
  const r = roomRect(slot);
  return { x: r.cx, y: r.y + r.h - 46 };
}

/** Posição do n-ésimo móvel dentro de um cômodo. Grade de duas colunas. */
function propSlot(r, n) {
  const col = n % 2;
  const row = Math.floor(n / 2);
  return {
    x: r.cx + (col === 0 ? -40 : 40),
    // Presa ao cômodo: com muitos móveis a coluna empilha até a base e para,
    // para nenhum móvel escapar do cômodo do dono.
    y: Math.min(r.y + 78 + row * 58, r.y + r.h - 70),
  };
}

/** Onde o robô encosta para usar um móvel do próprio cômodo. */
function standAt(prop, slot) {
  const r = roomRect(slot);
  return {
    x: Math.max(r.x + 18, Math.min(prop.x, r.x + r.w - 18)),
    y: Math.min(prop.y + 44, r.y + r.h - 40),
  };
}

// Onde o robô fica em pé no térreo para usar uma estação (issue #9). Ele desce
// de elevador até aqui; `rank` desempata quem está na mesma estação ao mesmo
// tempo, para dois robôs não se sobreporem sobre o mesmo símbolo.
const STATION_STAND_Y = GROUND.y + 40;
export function stationStand(station, rank = 0) {
  const side = rank % 2 === 0 ? 1 : -1;
  const spread = Math.ceil(rank / 2) * 34;
  return {
    x: Math.max(20, Math.min(station.x + side * spread, PLAN.w - 20)),
    y: STATION_STAND_Y,
  };
}

export function createScene() {
  return {
    agents: new Map(),
    props: new Map(),
    doorAgent: null,   // quem convocou por último: a porta de onde o próximo filho sai
  };
}

// ── cômodos ────────────────────────────────────────────────────────────────

/** Menor índice de cômodo que não está no conjunto de ocupados. */
function firstFreeRoom(taken) {
  for (let i = 0; ; i++) if (!taken.has(i)) return i;
}

/**
 * Índice do primeiro cômodo livre. Vagas recicladas contam como livres. O
 * prédio cresce para cima quando o andar enche: o sexto agente pega o slot 5,
 * que é o primeiro cômodo do 2º andar. O cômodo do principal fica reservado
 * enquanto ele estiver no prédio, para o olho ter um ponto de retorno.
 */
function allocRoom(scene, agent) {
  if (agent.isMain) return MAIN_ROOM;
  const taken = new Set();
  let mainPresent = false;
  for (const a of scene.agents.values()) {
    if (a === agent) continue;
    if (a.isMain) mainPresent = true;
    if (a.room != null) taken.add(a.room);
  }
  if (mainPresent) taken.add(MAIN_ROOM);
  return firstFreeRoom(taken);
}

/**
 * Muda um agente de cômodo, levando os móveis dele junto. Usado quando o
 * principal aparece depois que um subagente já ocupou o cômodo reservado —
 * raro (o principal costuma ser o primeiro a agir), mas mantém o endereço do
 * principal constante mesmo assim. Posição não é estável entre eventos, então
 * realocar é legítimo aqui.
 */
function relocateAgent(scene, agent, cmds) {
  const from = agent.room;
  const taken = new Set([MAIN_ROOM]);
  for (const a of scene.agents.values()) if (a !== agent && a.room != null) taken.add(a.room);
  const dst = firstFreeRoom(taken);

  agent.room = dst;
  const home = roomHome(dst);
  agent.x = home.x;
  agent.y = home.y;
  cmds.push({ op: 'agent-move', id: agent.id, x: home.x, y: home.y, face: agent.face });

  const dy = roomRect(dst).y - roomRect(from).y;
  for (const p of scene.props.values()) {
    if (p.owner === agent.id) {
      p.y += dy;
      cmds.push({ op: 'prop-move', prop: p });
    }
  }
}

/** A porta por onde um filho recém-convocado entra: o cômodo do pai, se ele
 *  ainda está no prédio; senão a porta do prédio. Sem pai não há linhagem. */
function parentDoor(scene, ev) {
  const parentId = ev.parentId || scene.doorAgent;
  if (!parentId || parentId === ev.agentId) return null;
  const parent = scene.agents.get(parentId);
  return parent ? { x: parent.x, y: parent.y } : null;
}

// ── agentes e móveis ──────────────────────────────────────────────────────

function ensureAgent(scene, id, type, cmds, entry) {
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
      away: false,        // fora do cômodo, descido ao térreo usando uma estação
      toolCount: 0,
      deskCursor: 0,
      since: Date.now(),
    };
    // Se um subagente já tomou o cômodo reservado do principal, ele cede a vaga
    // antes de o principal entrar.
    if (isMain) {
      const squatter = [...scene.agents.values()].find((o) => o.room === MAIN_ROOM);
      if (squatter) relocateAgent(scene, squatter, cmds);
    }
    a.room = allocRoom(scene, a);
    const home = roomHome(a.room);
    // Um filho convocado nasce na porta do cômodo do pai (`entry`) e caminha
    // dali até o próprio cômodo. Sem pai no prédio, entra pela porta do prédio;
    // o principal já estava dentro e nasce no cômodo dele.
    const start = entry || (isMain ? home : DOOR);
    a.x = start.x;
    a.y = start.y;
    scene.agents.set(id, a);
    // Emitido aqui, e não só no spawn: o agente principal nunca dá spawn —
    // ele aparece no primeiro evento que gerar, e sem isto ficava invisível.
    // O ponto de entrada vai no comando, não só no objeto: o `moveTo` seguinte
    // sobrescreve `a.x`, e sem o retrato o renderizador perderia de onde partir.
    cmds?.push({ op: 'agent-enter', agent: a, x: a.x, y: a.y });
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
    let pos;
    if (station) {
      pos = { x: station.x, y: station.y, room: station.label, fixed: true, owner: null };
    } else {
      const s = propSlot(roomRect(agent.room), agent.deskCursor++);
      pos = { x: s.x, y: s.y, room: 'CÔMODO', fixed: false, owner: agent.id };
    }
    p = { ...seed, key, ...pos, uses: 0, born: Date.now() };
    scene.props.set(key, p);
    cmds.push({ op: 'prop-add', prop: p });
  }
  if (seed.detail) p.detail = seed.detail;
  p.uses++;
  return p;
}

function moveTo(scene, a, x, y, cmds, extra) {
  if (Math.abs(x - a.x) > 6) a.face = x > a.x ? 1 : -1;
  a.x = x;
  a.y = y;
  cmds.push({ op: 'agent-move', id: a.id, x, y, face: a.face, ...extra });
}

// Volta o agente ao próprio cômodo, ocioso. De elevador se estava lá embaixo
// numa estação (issue #9).
function returnHome(scene, a, cmds, status = 'idle') {
  const wasAway = a.away;
  a.status = status;
  a.tool = null;
  a.propKey = null;
  a.away = false;
  a.since = Date.now();
  const home = roomHome(a.room);
  moveTo(scene, a, home.x, home.y, cmds, wasAway ? { elevator: true } : undefined);
  cmds.push({ op: 'agent-state', agent: a });
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
  // Um filho recém-convocado precisa saber a porta do pai antes de nascer.
  const entry = ev.kind === 'spawn' ? parentDoor(scene, ev) : null;
  const a = ensureAgent(scene, ev.agentId, ev.agentType, cmds, entry);

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

      // Convocar um subagente (a porta) acontece no próprio cômodo por ora: a
      // linhagem pela porta é a issue #10.
      if (seed.kind === 'door') {
        a.propKey = null;
        a.away = false;
        // Quem convoca vira a porta de onde o próximo filho vai sair.
        scene.doorAgent = a.id;
        const home = roomHome(a.room);
        moveTo(scene, a, home.x, home.y, cmds);
        cmds.push({ op: 'agent-state', agent: a });
        if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
        break;
      }

      const p = ensureProp(scene, a, seed, cmds);
      a.propKey = p.key;

      if (p.fixed) {
        // Estação: recurso singular no térreo. O robô desce de elevador até lá,
        // usa a estação, e o cômodo dele fica "ocupado, fora" enquanto isso
        // (issue #9). `rank` afasta quem divide a mesma estação.
        const rank = [...scene.agents.values()].filter((o) => o !== a && o.away && o.propKey === p.key).length;
        const spot = stationStand(p, rank);
        a.away = true;
        moveTo(scene, a, spot.x, spot.y, cmds, { elevator: true });
      } else {
        a.away = false;
        const spot = standAt(p, a.room);
        moveTo(scene, a, spot.x, spot.y, cmds);
      }
      cmds.push({ op: 'prop-hit', prop: p, by: a.id });
      cmds.push({ op: 'agent-state', agent: a });
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'brief' });
      break;
    }

    case 'tool_end':
      // Uma falha deixa o rosto do robô com um X até a próxima ação; qualquer
      // outro evento (tool_start, turn_end) o traz de volta ao normal.
      returnHome(scene, a, cmds, ev.failed ? 'error' : 'idle');
      break;

    case 'stop':
      a.status = 'leaving';
      a.tool = null;
      a.propKey = null;
      moveTo(scene, a, DOOR.x, DOOR.y, cmds);
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'result' });
      cmds.push({ op: 'agent-leave', id: a.id });
      // O cômodo é esvaziado: os móveis do ocupante somem com ele, para não
      // ficarem para o próximo que reciclar a vaga. Estações (dono nulo) ficam.
      for (const [key, p] of scene.props) {
        if (p.owner === a.id) {
          scene.props.delete(key);
          cmds.push({ op: 'prop-remove', key });
        }
      }
      // O cômodo é liberado: some do elenco e a vaga volta ao pool.
      scene.agents.delete(a.id);
      break;

    case 'prompt':
      cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
      break;

    case 'turn_end':
      returnHome(scene, a, cmds);
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

/**
 * Reconstrói a cena aplicando a lista de eventos desde o início — é assim que
 * um cliente que chega no meio (recarregar a página, trocar de sessão) monta o
 * prédio, sem depender de nenhum instantâneo montado pelo servidor (ADR-0001).
 *
 * Construir ao vivo é a mesma construção, só que ainda não terminada: por isso
 * `rebuild` é `apply` em sequência numa cena limpa. A única diferença é que
 * cada comando sai marcado como instantâneo — o prédio aparece pronto em vez de
 * reencenar a caminhada e o balão de fala de cada evento já passado.
 */
export function rebuild(scene, events) {
  scene.agents.clear();
  scene.props.clear();
  scene.doorAgent = null;
  const cmds = [];
  for (const ev of events || []) {
    for (const c of apply(scene, ev)) cmds.push({ ...c, instant: true });
  }
  return cmds;
}
