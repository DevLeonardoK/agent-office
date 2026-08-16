// Estado da cena, sem uma linha de DOM.
//
// Recebe eventos do servidor e devolve uma lista de comandos que o renderizador
// executa. A separação existe para o `selftest.mjs` poder exercitar toda a
// lógica de posicionamento em Node, sem navegador.
//
// Modelo espacial (issue #4): um térreo de serviço fixo embaixo, com as quatro
// estações singulares, e um 1º andar com cinco cômodos — um agente por cômodo,
// e os móveis desse agente dentro do cômodo dele.

// ── o mundo isométrico ────────────────────────────────────────────────────
//
// O prédio deixou de ser uma elevação de frente: agora é isométrico, como a
// referência em `media-agents/escriotorio1.png`. Cada andar é uma plataforma
// de ladrilhos em losango, e os andares se empilham no eixo vertical da tela.
//
// A cena raciocina em **coordenadas de mundo** — `(wx, wy)` em ladrilhos sobre
// a plataforma, mais o andar — e projeta com `iso()`. Todo comando sai já
// projetado em pixels, então o renderizador continua sem saber de geometria:
// ele só recebe x/y de tela, como antes.

export const TILE = { w: 62, h: 31 };        // losango do ladrilho (2:1)
export const LEVEL = 168;                    // quanto um andar sobe na tela
export const PLATE = { x: 13, y: 8 };        // ladrilhos de uma plataforma

// O plano de desenho. A origem fica no topo, no meio: dali as plataformas
// descem para a direita e para a esquerda.
export const PLAN = { w: 1160, h: 900 };
const ORIGIN = { x: PLAN.w / 2, y: 300 };

/** Projeta um ponto do mundo (ladrilhos, andar) para o pixel na tela. */
export function iso(wx, wy, floor = 0) {
  return {
    x: ORIGIN.x + (wx - wy) * (TILE.w / 2),
    y: ORIGIN.y + (wx + wy) * (TILE.h / 2) - floor * LEVEL,
  };
}

/**
 * Profundidade de um ponto: quem tem mais wx+wy está mais à frente e tapa quem
 * está atrás. O renderizador usa isto como z-index — sem ele, um robô no fundo
 * do cômodo apareceria por cima da parede da frente.
 */
export const depth = (wx, wy, floor = 0) => Math.round((wx + wy) * 10 + floor * 1000);

// O térreo de serviço é o andar -1: uma plataforma maior, sempre presente, que
// não conta agentes. É onde ficam as quatro estações e a porta do prédio.
export const GROUND_FLOOR = -1;
export const GROUND_PLATE = { x: PLATE.x + 3, y: PLATE.y + 2 };

// Entrada do prédio: o canto de quem chega de fora, no térreo.
export const DOOR = iso(-1.4, GROUND_PLATE.y - 1.5, GROUND_FLOOR);

// As quatro estações canônicas (CONTEXT.md): recurso singular no prédio
// inteiro, sempre no térreo. A chave delas é global — um só de cada.
const stationAt = (wx, wy, label) => ({ ...iso(wx, wy, GROUND_FLOOR), wx, wy, label });
export const STATIONS = {
  terminal:   stationAt(2.2, 6.6, 'TERMINAL'),
  library:    stationAt(5.6, 6.6, 'BIBLIOTECA'),
  whiteboard: stationAt(9.0, 6.6, 'QUADRO'),
  cabinet:    stationAt(12.4, 6.6, 'ARQUIVO MORTO'),
};

// Cinco cômodos por andar, lado a lado ao longo do eixo wx da plataforma.
export const ROOMS_PER_FLOOR = 5;
const ROOM_TILES = PLATE.x / ROOMS_PER_FLOOR;   // 2,6 ladrilhos de frente

// Cômodo reservado ao agente principal: sempre no andar 0, nunca reciclado.
export const MAIN_ROOM = 0;

// O elevador ocupa o fundo da plataforma (wy pequeno), na coluna do meio: de
// lá a cabine desce até o térreo sem cruzar cômodo nenhum.
export const SHAFT = { wx: PLATE.x / 2 - 1, wy: -1.6, w: 2, d: 1.4 };

/**
 * O cômodo `slot` em ladrilhos: `{ wx, wy, w, d, floor }`, onde wx/wy é o canto
 * do fundo e w/d são frente e profundidade. Única fonte de geometria — quem
 * precisa de pixel chama `iso()` sobre isto.
 */
export function roomTiles(slot) {
  const floor = Math.floor(slot / ROOMS_PER_FLOOR);
  const col = slot % ROOMS_PER_FLOOR;
  const pad = 0.18;
  return { wx: col * ROOM_TILES + pad, wy: pad, w: ROOM_TILES - pad * 2, d: PLATE.y - pad * 2, floor };
}

/** Os quatro cantos do cômodo já projetados, para desenhar o losango do piso. */
export function roomQuad(slot) {
  const r = roomTiles(slot);
  return [
    iso(r.wx, r.wy, r.floor),
    iso(r.wx + r.w, r.wy, r.floor),
    iso(r.wx + r.w, r.wy + r.d, r.floor),
    iso(r.wx, r.wy + r.d, r.floor),
  ];
}

/** Caixa de tela que contém o cômodo inteiro — o que o enquadramento usa. */
export function roomRect(slot) {
  const q = roomQuad(slot);
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, cx: (x + Math.max(...xs)) / 2 };
}

/** Caixa de tela de um andar inteiro: a plataforma mais a altura de pé-direito. */
export function floorRect(floor) {
  const pl = floor === GROUND_FLOOR ? GROUND_PLATE : PLATE;
  const corners = [iso(0, 0, floor), iso(pl.x, 0, floor), iso(pl.x, pl.y, floor), iso(0, pl.y, floor)];
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x = Math.min(...xs) - 20, y = Math.min(...ys) - 96;   // 96 = parede do fundo
  return { x, y, w: Math.max(...xs) - x + 20, h: Math.max(...ys) - y + 24 };
}

/** O prédio inteiro como está agora: do topo do último andar à base do térreo. */
export function buildingRect(scene) {
  const top = floorRect(floorCount(scene) - 1);
  const base = floorRect(GROUND_FLOOR);
  const x = Math.min(top.x, base.x);
  const w = Math.max(top.x + top.w, base.x + base.w) - x;
  return { x, y: top.y, w, h: base.y + base.h - top.y };
}

/** Quantos andares o prédio tem agora. Deriva da ocupação: andar vazio some. */
export function floorCount(scene) {
  let max = 0;
  for (const a of scene.agents.values()) {
    if (a.room != null) max = Math.max(max, Math.floor(a.room / ROOMS_PER_FLOOR));
  }
  return max + 1;
}

/** O poço, do último andar até o térreo, em caixa de tela. */
export function shaftRect(scene) {
  const top = iso(SHAFT.wx, SHAFT.wy, floorCount(scene) - 1);
  const bottom = iso(SHAFT.wx + SHAFT.w, SHAFT.wy + SHAFT.d, GROUND_FLOOR);
  return { x: top.x - TILE.w, y: top.y - 110, w: TILE.w * 2.4, h: bottom.y - top.y + 150 };
}

/**
 * A cabine parada num andar, como caixa isométrica: os quatro cantos do piso
 * dela mais a altura. O térreo é o andar -1 — o fundo do poço.
 */
export function cabinBox(floor) {
  const { wx, wy, w, d } = SHAFT;
  const h = 78;
  return {
    h,
    floor: [iso(wx, wy, floor), iso(wx + w, wy, floor), iso(wx + w, wy + d, floor), iso(wx, wy + d, floor)],
  };
}

/** Caixa de tela da cabine — o que o desenho e o teste usam para medir. */
export function cabinRect(floor) {
  const b = cabinBox(floor);
  const xs = b.floor.map((p) => p.x), ys = b.floor.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys) - b.h;
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Onde o robô fica em pé dentro da cabine, no andar dado. */
export function cabinStand(floor) {
  return iso(SHAFT.wx + SHAFT.w / 2, SHAFT.wy + SHAFT.d / 2 + 0.2, floor);
}

/** Onde o robô fica parado no cômodo: no meio, um pouco à frente. */
function roomHome(slot) {
  const r = roomTiles(slot);
  return iso(r.wx + r.w / 2, r.wy + r.d * 0.62, r.floor);
}

/**
 * Posição do n-ésimo móvel dentro de um cômodo. Os móveis encostam na parede
 * do fundo e avançam em duas fileiras — como as baias da referência.
 */
function propSlot(slot, n) {
  const r = roomTiles(slot);
  const col = n % 2;
  const row = Math.floor(n / 2);
  return iso(
    r.wx + r.w * (col === 0 ? 0.3 : 0.72),
    // Preso ao cômodo: com muitos móveis a fileira empilha até a frente e para.
    Math.min(r.wy + 0.7 + row * 1.15, r.wy + r.d - 0.7),
    r.floor,
  );
}

/** Onde o robô encosta para usar um móvel do próprio cômodo: logo à frente. */
function standAt(prop, slot) {
  const r = roomTiles(slot);
  const q = roomQuad(slot);
  const y = Math.min(prop.y + 34, Math.max(q[2].y, q[3].y) - 8);
  return { x: prop.x, y };
}

// Onde o robô fica em pé no térreo para usar uma estação (issue #9). Ele desce
// de elevador até aqui; `rank` desempata quem está na mesma estação ao mesmo
// tempo, para dois robôs não se sobreporem sobre o mesmo símbolo.
export function stationStand(station, rank = 0) {
  const side = rank % 2 === 0 ? 1 : -1;
  const spread = Math.ceil(rank / 2) * 1.1;   // um ladrilho inteiro entre dois robôs
  return iso(station.wx + side * spread, station.wy + 0.9, GROUND_FLOOR);
}

export function createScene() {
  return {
    agents: new Map(),
    props: new Map(),
    doorAgent: null,   // quem convocou por último: a porta de onde o próximo filho sai
    cabinFloor: -1,    // onde a cabine do elevador está parada; -1 é o térreo
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

  // Os móveis vão junto: reocupam as mesmas vagas, agora no cômodo novo. Em
  // isométrico não dá para somar um deslocamento — a vaga é que é a verdade.
  let n = 0;
  for (const p of scene.props.values()) {
    if (p.owner !== agent.id || p.fixed) continue;
    const spot = propSlot(dst, n++);
    p.x = spot.x;
    p.y = spot.y;
    cmds.push({ op: 'prop-move', prop: p });
  }
  agent.deskCursor = n;
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
      // wx/wy vão junto: é deles que sai onde o robô fica em pé na estação.
      pos = { x: station.x, y: station.y, wx: station.wx, wy: station.wy, room: station.label, fixed: true, owner: null };
    } else {
      const s = propSlot(agent.room, agent.deskCursor++);
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

/**
 * Viagem de elevador entre o cômodo e o térreo. Duas pernas: o robô entra na
 * cabine do próprio andar e a cabine desce (ou sobe) até o destino. O
 * renderizador encadeia as duas — é isso que faz o elevador ser visível em vez
 * de o robô cortar caminho na diagonal.
 */
function elevatorTo(scene, a, x, y, cmds, goingDown) {
  const floor = Math.floor(a.room / ROOMS_PER_FLOOR);
  const board = cabinStand(goingDown ? floor : -1);
  const land = cabinStand(goingDown ? -1 : floor);

  moveTo(scene, a, board.x, board.y, cmds, { leg: 'board' });
  scene.cabinFloor = goingDown ? floor : -1;
  cmds.push({ op: 'cabin', from: scene.cabinFloor, to: goingDown ? -1 : floor });
  scene.cabinFloor = goingDown ? -1 : floor;
  moveTo(scene, a, land.x, land.y, cmds, { leg: 'ride', elevator: true });
  moveTo(scene, a, x, y, cmds, { leg: 'off' });
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
  if (wasAway) elevatorTo(scene, a, home.x, home.y, cmds, false);
  else moveTo(scene, a, home.x, home.y, cmds);
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
        elevatorTo(scene, a, spot.x, spot.y, cmds, true);
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
  scene.cabinFloor = -1;
  const cmds = [];
  for (const ev of events || []) {
    for (const c of apply(scene, ev)) cmds.push({ ...c, instant: true });
  }
  return cmds;
}
