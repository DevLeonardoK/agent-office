// Estado da cena, sem uma linha de DOM.
//
// Recebe eventos do servidor e devolve uma lista de comandos que o renderizador
// executa. A separação existe para o `selftest.mjs` poder exercitar toda a
// lógica de posicionamento em Node, sem navegador.
//
// Modelo espacial (issue #4): um térreo de serviço fixo embaixo, com as quatro
// estações singulares, e um 1º andar com cinco cômodos — um agente por cômodo,
// e os móveis desse agente dentro do cômodo dele.

// ── o mundo 3D ────────────────────────────────────────────────────────────
//
// O prédio é uma cena 3D (ADR-0003). A cena raciocina em **unidades de mundo** —
// `wx` para o lado, `wz` para a profundidade, `wy` para a altura — e é ela quem
// resolve toda a geometria: onde fica o cômodo, onde o robô pisa, por onde a
// escada sobe. O renderizador recebe pontos prontos e não calcula nada.
//
// Um ladrilho é uma unidade. Andar é altura mais deslocamento: as plataformas
// se escalonam em diagonal, de modo que nenhuma tape a de baixo.

export const TILE = 1;                        // uma unidade de mundo = um ladrilho
// Altura de um andar. Casada com a profundidade da plataforma e o escalonamento:
// é o trio que define a inclinação do lance. Pé-direito alto com plataforma curta
// dá escada de 60°, ou joga o pé do lance fora do piso.
export const LEVEL = 4.2;
// O escalonamento por andar. É só em profundidade, de propósito: na tela isso já
// lê como diagonal, e com deslocamento em x a escada tinha de vencer o desvio
// lateral além da altura — corria torta, e o vão dela caía sobre o canto
// chanfrado da plataforma, cortando a borda do prédio.
export const STAGGER = { x: 0, z: -2.6 };
export const PLATE = { x: 13, z: 10 };        // os cômodos de um andar
export const BAY = 4;                         // a baia da escada, à direita dos cômodos

// A baia em coordenadas locais: é a faixa em x onde o poço da escada é vazado.
export const BAY_X0 = PLATE.x + 0.2;
export const BAY_X1 = PLATE.x + BAY - 0.2;
// Pé-direito desenhado. Baixo de propósito: parede alta, com a câmera inclinada,
// projeta sobre o piso e tapa o cômodo — o andar virava uma faixa preta.
export const WALL_H = 1.9;

// O térreo de serviço é o andar -1: plataforma maior, sempre presente, que não
// conta agentes. É onde ficam as quatro estações e a porta do prédio.
export const GROUND_FLOOR = -1;
// O térreo é maior que os andares: além das quatro estações, ele precisa da praça
// de entrada, com espaço na frente da porta para quem chega e quem sai.
export const GROUND_PLATE = { x: PLATE.x + BAY + 4, z: PLATE.z + 7 };

/** A origem de uma plataforma no mundo. O escalonamento diagonal mora aqui. */
export function platformOrigin(floor) {
  return { x: floor * STAGGER.x, z: floor * STAGGER.z };
}

/** A altura do piso de um andar. */
export const levelY = (floor) => floor * LEVEL;

/** Ponto de mundo a partir de coordenadas locais da plataforma do andar. */
export function world(lx, lz, floor) {
  const o = platformOrigin(floor);
  return { wx: o.x + lx, wy: levelY(floor), wz: o.z + lz, floor };
}

/** Quanto mede a plataforma de um andar. O térreo é maior. */
export const plateOf = (floor) => (floor === GROUND_FLOOR ? GROUND_PLATE : { x: PLATE.x + BAY, z: PLATE.z });

/**
 * O contorno da plataforma: um pentágono — o retângulo com o canto do fundo à
 * direita chanfrado. É o chanfro que abre lugar para a escada e deixa a borda do
 * andar de baixo à vista.
 */
export function platformShape(floor) {
  const p = plateOf(floor);
  const cut = 2.8;
  const pts = [];
  const add = (lx, lz) => pts.push(world(lx, lz, floor));

  // O chanfro fica no canto do fundo à **esquerda**: a baia da escada é à direita,
  // e chanfrar aquele canto era o que fazia o vão da escada furar a borda.
  add(cut, 0);
  add(p.x, 0);
  add(p.x, p.z);

  // O poço da escada: a baia é vazada em todo andar, da boca até a borda da frente.
  // Quem sobe pisa nos patamares da escada, nunca na laje da baia.
  if (floor > GROUND_FLOOR) {
    add(BAY_X1, p.z);
    add(BAY_X1, NOTCH_Z);
    add(BAY_X0, NOTCH_Z);
    add(BAY_X0, p.z);
  }

  add(0, p.z);
  add(0, cut);
  return pts;
}

// Entrada do prédio, na quina do térreo: quem chega de fora nasce aqui, e quem sai
// caminha até aqui. Tem de ficar **sobre** a plataforma: fora dela, quem saía do
// prédio caminhava para o vazio e parecia flutuar numa escada imaginária.
export const DOOR = world(2.6, GROUND_PLATE.z - 2.2, GROUND_FLOOR);

// As quatro estações canônicas (CONTEXT.md): recurso singular no prédio inteiro,
// sempre no térreo. A chave delas é global — há uma só de cada.
const stationAt = (lx, lz, label) => ({ ...world(lx, lz, GROUND_FLOOR), label });
export const STATIONS = {
  terminal:   stationAt(2.4, GROUND_PLATE.z - 4.8, 'TERMINAL'),
  library:    stationAt(6.2, GROUND_PLATE.z - 4.8, 'BIBLIOTECA'),
  whiteboard: stationAt(10.0, GROUND_PLATE.z - 4.8, 'QUADRO'),
  cabinet:    stationAt(13.8, GROUND_PLATE.z - 4.8, 'ARQUIVO MORTO'),
};

// Cinco cômodos por andar, lado a lado ao longo de wx.
export const ROOMS_PER_FLOOR = 5;
const ROOM_W = PLATE.x / ROOMS_PER_FLOOR;

// Quantos matizes a paleta tem. Vive aqui, e não só no renderizador, porque é o
// `scene.mjs` que distribui o matiz entre os subagentes — o número precisava
// deixar de ser um `% 5` casado por acidente com os cinco cômodos por andar
// (issue #17).
export const HUE_COUNT = 6;

// Cômodo reservado ao agente principal: sempre no andar 0, nunca reciclado.
export const MAIN_ROOM = 0;

/** O cômodo `slot` em coordenadas locais da plataforma, mais o andar. */
export function roomTiles(slot) {
  const floor = Math.floor(slot / ROOMS_PER_FLOOR);
  const col = slot % ROOMS_PER_FLOOR;
  const pad = 0.2;
  return { lx: col * ROOM_W + pad, lz: pad, w: ROOM_W - pad * 2, d: PLATE.z - pad * 2, floor, col };
}

/** Os quatro cantos do piso do cômodo, no mundo. */
export function roomQuad(slot) {
  const r = roomTiles(slot);
  return [
    world(r.lx, r.lz, r.floor),
    world(r.lx + r.w, r.lz, r.floor),
    world(r.lx + r.w, r.lz + r.d, r.floor),
    world(r.lx, r.lz + r.d, r.floor),
  ];
}

/** Quantos andares o prédio tem agora. Deriva da ocupação: andar vazio some. */
export function floorCount(scene) {
  let max = 0;
  for (const a of scene.agents.values()) {
    if (a.room != null) max = Math.max(max, Math.floor(a.room / ROOMS_PER_FLOOR));
  }
  return max + 1;
}

/**
 * A caixa do prédio inteiro no mundo, para a câmera enquadrar. Cresce com os
 * andares e acompanha o escalonamento — sem isso o prédio sai de quadro para o
 * lado conforme sobe.
 */
export function buildingBounds(scene) {
  const floors = floorCount(scene);
  let min = { x: Infinity, y: 0, z: Infinity };
  let max = { x: -Infinity, y: 0, z: -Infinity };
  for (let f = GROUND_FLOOR; f < floors; f++) {
    for (const p of platformShape(f)) {
      min.x = Math.min(min.x, p.wx); max.x = Math.max(max.x, p.wx);
      min.z = Math.min(min.z, p.wz); max.z = Math.max(max.z, p.wz);
    }
  }
  min.y = levelY(GROUND_FLOOR);
  max.y = levelY(floors - 1) + WALL_H;
  return { min, max };
}

// A faixa livre da frente da plataforma. Todo trajeto dentro de um andar passa
// por ela: é o corredor, e é o que faz o robô contornar em vez de atravessar os
// cômodos dos outros.
const LANE = PLATE.z - 0.6;
const GROUND_LANE = GROUND_PLATE.z - 1.4;

// ── a escada ──────────────────────────────────────────────────────────────
//
// Escada em U dentro de um **poço**: a baia à direita dos cômodos é vazada em todos
// os andares, e a escada tem os patamares dela própria. Foi a terceira tentativa —
// e a que fecha:
//
//   - Um lance reto só não vencia a altura do andar dentro da baia.
//   - Com laje na baia, o pé do lance seguinte caía no vão aberto pelo lance
//     anterior, porque o desenho repete a cada andar.
//
// Com poço, ninguém pisa em laje dentro da baia: o robô anda no corredor, entra no
// patamar do andar (que é da escada), sobe meio lance até o patamar do meio, e sobe
// o outro meio até o patamar do andar de cima. Descer é o mesmo caminho, invertido —
// sempre pelo mesmo lado.

export const STEPS = 12;                      // degraus por lance (metade em cada meio)
const HALF = STEPS / 2;

const LANDING_LZ = PLATE.z - 0.8;             // patamar de andar, na frente da baia
const MID_LZ = 3.4;                           // patamar do meio, no fundo da baia
const STAIR_CX = (BAY_X0 + BAY_X1) / 2;       // eixo da escada, no meio da baia
const LANE_X = 0.9;                           // meio-lance de subida à direita, volta à esquerda

/** Onde a laje é vazada para o poço, medindo do fundo do andar. */
const NOTCH_Z = MID_LZ - 0.8;

/** O patamar de um andar, dentro do poço: é dele que se sai e onde se chega. */
export const stairLanding = (floor) => world(STAIR_CX, LANDING_LZ, floor);

/** O patamar do meio do lance: meia altura entre dois andares, no fundo do poço. */
export function stairMid(floor) {
  const p = world(STAIR_CX, MID_LZ, floor);
  return { ...p, wy: p.wy + LEVEL / 2 };
}

/** O pé do lance que sai de `floor` para `floor + 1`. */
export const stairFoot = (floor) => stairLanding(floor);
/** O desembarque do mesmo lance, no andar de cima. */
export const stairHead = (floor) => stairLanding(floor + 1);

/** Onde o robô espera no corredor para entrar no poço, no andar dado. */
export const stairDoor = (floor) => world(BAY_X0 - 0.7, LANDING_LZ, floor);

// Duas faixas por meio-lance: é o que permite dois subirem ao mesmo tempo sem se
// atropelar (issue #18).
export const STAIR_LANES = 2;
const LANE_GAP = 1.4;   // o robô tem ~1,2 de largura: menos que isso e eles se cruzam

/** O deslocamento lateral da faixa `lane`: sempre em x, ao lado do lance. */
export function stairLaneOffset(floor, lane) {
  const k = (lane % STAIR_LANES) - (STAIR_LANES - 1) / 2;
  return { x: k * LANE_GAP, z: 0 };
}

/**
 * Os degraus do lance, do patamar de baixo ao de cima, na faixa `lane`: meio lance
 * subindo pela direita do poço, meio voltando pela esquerda.
 */
export function stairSteps(floor, lane = 0) {
  const off = stairLaneOffset(floor, lane);
  const a = stairLanding(floor);
  const m = stairMid(floor);
  const b = stairLanding(floor + 1);
  const out = [];
  const leg = (from, to, n, side, endFloor) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push({
        wx: from.wx + (to.wx - from.wx) * t + side * LANE_X + off.x,
        wy: from.wy + (to.wy - from.wy) * t,
        wz: from.wz + (to.wz - from.wz) * t,
        floor: t === 1 ? endFloor : floor,
      });
    }
  };
  leg(a, m, HALF, 1, floor);            // sobe pela direita até o patamar do meio
  leg(m, b, HALF, -1, floor + 1);       // e volta pela esquerda até o andar de cima
  return out;
}

/**
 * O poço da escada num andar: a baia vazada, da boca no fundo até a borda da frente.
 * É o que o desenho recorta da laje e o que ganha guarda-corpo.
 */
export function stairWell(floor) {
  const p = plateOf(floor);
  return [
    world(BAY_X0, NOTCH_Z, floor),
    world(BAY_X1, NOTCH_Z, floor),
    world(BAY_X1, p.z, floor),
    world(BAY_X0, p.z, floor),
  ];
}

/** Um ponto está no poço da escada? Serve às invariantes: patamar não é laje. */
export function inStairWell(p, floor) {
  const o = platformOrigin(floor);
  const lx = p.wx - o.x;
  const lz = p.wz - o.z;
  return lx >= BAY_X0 - 0.8 && lx <= BAY_X1 + 0.8 && lz >= NOTCH_Z - 0.8 && lz <= plateOf(floor).z + 0.8;
}

/**
 * O terreno: o chão em que o prédio se apoia, com folga em volta. Sem ele o térreo
 * flutuava no vazio, e a cena parecia recortada no ar.
 */
export const TERRAIN_MARGIN = 6;

export function terrainRect(scene) {
  const b = buildingBounds(scene);
  return {
    x0: b.min.x - TERRAIN_MARGIN,
    x1: b.max.x + TERRAIN_MARGIN,
    z0: b.min.z - TERRAIN_MARGIN,
    z1: b.max.z + TERRAIN_MARGIN,
    y: levelY(GROUND_FLOOR) - 0.55,
  };
}

/** Onde o robô fica parado no cômodo: no meio, um pouco à frente. */
function roomHome(slot) {
  const r = roomTiles(slot);
  return world(r.lx + r.w / 2, r.lz + r.d * 0.62, r.floor);
}

/**
 * A mobília fixa de um cômodo (issue #14). É do cômodo, não do agente e não do
 * evento: montada quando o cômodo ganha ocupante, desmontada quando ele esvazia,
 * e nunca criada por uso de ferramenta. Usar uma ferramenta acende o móvel que
 * já está lá.
 *
 * A mesa cobre arquivo e ferramenta sem casa própria; a estante cobre os
 * manuais. Os demais recursos são estações, singulares no térreo.
 */
const ROOM_FURNITURE = [
  { kind: 'desk', label: 'mesa', at: 0.3 },
  { kind: 'shelf', label: 'manuais', at: 0.72 },
];

/** A chave do móvel fixo: do cômodo e do tipo, sem identidade de arquivo. */
const roomPropKey = (slot, kind) => `room${slot}|${kind}`;

/** Monta a mobília do cômodo. Idempotente: chamar de novo não duplica. */
function furnishRoom(scene, slot, cmds) {
  const r = roomTiles(slot);
  for (const f of ROOM_FURNITURE) {
    const key = roomPropKey(slot, f.kind);
    if (scene.props.has(key)) continue;
    const at = world(r.lx + r.w * f.at, r.lz + r.d * 0.28, r.floor);
    const p = {
      kind: f.kind, key, label: f.label, room: 'CÔMODO', fixed: false, slot, ...at,
      uses: 0, born: Date.now(),
    };
    scene.props.set(key, p);
    cmds.push({ op: 'prop-add', prop: p });
  }
}

/** Desmobilia o cômodo: chamado quando ele deixa de ter ocupante. */
function unfurnishRoom(scene, slot, cmds) {
  for (const f of ROOM_FURNITURE) {
    const key = roomPropKey(slot, f.kind);
    if (!scene.props.delete(key)) continue;
    cmds.push({ op: 'prop-remove', key });
  }
}

/** O móvel do cômodo que atende àquele tipo de ferramenta. A mesa é o padrão. */
function roomPropFor(scene, slot, kind) {
  return scene.props.get(roomPropKey(slot, kind)) || scene.props.get(roomPropKey(slot, 'desk'));
}

/** Onde o robô encosta para usar um móvel do próprio cômodo: logo à frente. */
function standAt(prop, slot) {
  const r = roomTiles(slot);
  const o = platformOrigin(r.floor);
  const lz = Math.min(prop.wz - o.z + 1.2, r.lz + r.d - 0.5);
  return world(prop.wx - o.x, lz, r.floor);
}

/**
 * Onde o robô fica em pé no térreo para usar uma estação. `rank` desempata quem
 * está na mesma estação ao mesmo tempo, para dois não se sobreporem.
 */
export function stationStand(station, rank = 0) {
  const side = rank % 2 === 0 ? 1 : -1;
  const spread = Math.ceil(rank / 2) * 1.3;
  return { wx: station.wx + side * spread, wy: station.wy, wz: station.wz + 1.5, floor: GROUND_FLOOR };
}

export function createScene() {
  return {
    agents: new Map(),
    props: new Map(),
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
  // A mobília é do cômodo: a do antigo fica para trás (o cômodo esvaziou) e a do
  // novo já está lá — ou é montada agora.
  unfurnishRoom(scene, from, cmds);
  furnishRoom(scene, dst, cmds);
  agent.propKey = null;
  // Muda de cômodo andando pelo corredor, como qualquer outro trajeto: o salto
  // instantâneo era o que fazia a realocação parecer teleporte.
  moveTo(scene, agent, roomHome(dst), cmds);
}

function ensureAgent(scene, id, type, cmds) {
  let a = scene.agents.get(id);
  if (!a) {
    const isMain = id === 'main';
    a = {
      id,
      type: type || 'claude',
      isMain,
      hueIndex: isMain ? -1 : scene.agents.size % HUE_COUNT,
      face: 1,
      status: 'idle',
      tool: null,
      propKey: null,
      away: false,        // fora do cômodo, descido ao térreo usando uma estação
      flight: null,       // lance de escada que está usando, se estiver
      lane: 0,            // faixa dentro do lance, para dois não se atropelarem
      toolCount: 0,
      since: Date.now(),
    };
    // Se um subagente já tomou o cômodo reservado do principal, ele cede a vaga
    // antes de o principal entrar.
    if (isMain) {
      const squatter = [...scene.agents.values()].find((o) => o.room === MAIN_ROOM);
      if (squatter) relocateAgent(scene, squatter, cmds);
    }
    a.room = allocRoom(scene, a);
    furnishRoom(scene, a.room, cmds);
    const home = roomHome(a.room);
    // Todo subagente entra pela porta do prédio, no térreo, e sobe a escada até
    // o cômodo dele — inclusive o filho convocado por outro agente. Antes o filho
    // nascia ao lado do pai, e num andar de cima ele simplesmente aparecia lá.
    // O principal é a exceção: ele já estava dentro, e nasce no cômodo.
    const start = isMain ? home : DOOR;
    a.wx = start.wx;
    a.wy = start.wy;
    a.wz = start.wz;
    a.floor = start.floor;
    scene.agents.set(id, a);
    // Emitido aqui, e não só no spawn: o agente principal nunca dá spawn —
    // ele aparece no primeiro evento que gerar, e sem isto ficava invisível.
    // O ponto de entrada vai no comando, não só no objeto: o `moveTo` seguinte
    // sobrescreve `a.x`, e sem o retrato o renderizador perderia de onde partir.
    cmds?.push({ op: 'agent-enter', agent: a, wx: a.wx, wy: a.wy, wz: a.wz });
  }
  if (type && type !== 'main') a.type = type;
  return a;
}

/**
 * A estação do térreo, criada na primeira vez que alguém a usa. Chave global —
 * há uma de cada no prédio inteiro. Móvel de cômodo não passa por aqui: aquele é
 * mobília fixa, montada com o cômodo (issue #14).
 */
function ensureStation(scene, seed, cmds) {
  const station = STATIONS[seed.kind];
  let p = scene.props.get(seed.key);
  if (!p) {
    p = {
      ...seed, key: seed.key, room: station.label, fixed: true, owner: null,
      // O ponto de mundo vai junto: é dele que sai onde o robô fica em pé.
      wx: station.wx, wy: station.wy, wz: station.wz, floor: GROUND_FLOOR,
      uses: 0, born: Date.now(),
    };
    scene.props.set(seed.key, p);
    cmds.push({ op: 'prop-add', prop: p });
  }
  return p;
}

/**
 * O caminho de um ponto a outro dentro do mesmo andar. Sai do cômodo até o
 * corredor da frente, corre pelo corredor e entra no destino — em L, como quem
 * anda por um escritório de verdade. Pontos repetidos são descartados.
 */
function walkPath(from, to, lane) {
  const floor = to.floor;
  const laneZ = platformOrigin(floor).z + lane;
  const y = levelY(floor);
  const pts = [];
  const push = (wx, wz) => {
    const last = pts[pts.length - 1] || from;
    if (Math.abs(last.wx - wx) > 0.05 || Math.abs(last.wz - wz) > 0.05) pts.push({ wx, wy: y, wz, floor });
  };
  const sameLane = Math.abs(from.wz - to.wz) < 0.5;
  const sameCol = Math.abs(from.wx - to.wx) < 0.5;
  if (!sameLane && !sameCol) {
    push(from.wx, laneZ);
    push(to.wx, laneZ);
  }
  push(to.wx, to.wz);
  return pts;
}

/**
 * Move o robô por um trajeto de ladrilhos e emite um comando por perna. Cada
 * perna vira uma animação encadeada no renderizador, com duração proporcional à
 * distância: é isso que faz a cena parecer gente andando em vez de ícone
 * saltando de um ponto ao outro.
 */
function walkAlong(scene, a, points, cmds, kind = 'walk') {
  // `start` marca a primeira perna de um trajeto novo. O renderizador usa isso
  // para abandonar o trajeto anterior: numa rajada de ferramentas, a fila de
  // pernas antigas atrasava o robô em segundos e a cena passava a mostrar um
  // passado que já não era verdade.
  let first = !a.pathOpen;
  a.pathOpen = true;
  for (const p of points) {
    if (Math.abs(p.wx - a.wx) > 0.1) a.face = p.wx > a.wx ? 1 : -1;
    a.wx = p.wx;
    a.wy = p.wy;
    a.wz = p.wz;
    if (p.floor != null) a.floor = p.floor;
    cmds.push({ op: 'agent-move', id: a.id, wx: a.wx, wy: a.wy, wz: a.wz, face: a.face, kind, start: first });
    first = false;
  }
}

/**
 * Leva o robô a um destino. Ponto único de roteamento: se o destino está em outro
 * andar, o caminho passa pela escada — nenhum chamador precisa lembrar disso.
 *
 * Era o buraco que fazia o robô "andar no limbo": ao sair do prédio, ele ia da
 * porta do próprio cômodo até a porta do térreo em linha reta, atravessando o
 * vazio na diagonal.
 */
function moveTo(scene, a, target, cmds) {
  // O trajeto é calculado de uma vez, mas o robô leva tempo para andá-lo: o
  // `flight` fica marcado até o próximo movimento dele. É assim que a escolha de
  // faixa sabe quem ainda está no lance — sem isso, dois que saem no mesmo
  // instante escolhiam a mesma faixa e subiam um dentro do outro.
  a.flight = null;
  const here = a.floor ?? Math.floor(a.room / ROOMS_PER_FLOOR);
  if (target.floor !== here) {
    stairsTo(scene, a, target, cmds);
    return;
  }
  const lane = target.floor === GROUND_FLOOR ? GROUND_LANE : LANE;
  walkAlong(scene, a, walkPath(a, target, lane), cmds);
}

/**
 * Viagem entre andares pela escada (issue #16 começa aqui). O robô anda até o pé
 * — ou o topo — do lance, sobe degrau a degrau (um comando por degrau, para o
 * renderizador poder animar a subida) e caminha até o destino. Diferença de
 * vários andares vira vários lances, um atrás do outro.
 */
function stairsTo(scene, a, target, cmds) {
  const from = a.floor ?? Math.floor(a.room / ROOMS_PER_FLOOR);
  const to = target.floor;
  const up = to > from;

  for (let f = from; up ? f < to : f > to; f += up ? 1 : -1) {
    // Subindo, o lance é o que sai de f; descendo, o que chega a f.
    const flight = up ? f : f - 1;

    // Faixa livre do lance: com o pé do lance sendo o mesmo ponto para todos, dois
    // robôs subindo ao mesmo tempo se sobrepunham no degrau (issue #18).
    const taken = new Set([...scene.agents.values()].filter((o) => o !== a && o.flight === flight).map((o) => o.lane));
    let lane = 0;
    while (taken.has(lane) && lane < STAIR_LANES - 1) lane++;
    a.flight = flight;
    a.lane = lane;

    const off = stairLaneOffset(flight, lane);
    const shift = (p) => ({ ...p, wx: p.wx + off.x, wz: p.wz + off.z });
    // Entra no poço pelo corredor: primeiro a porta da escada, já no piso, depois o
    // patamar do andar — que é da escada, não da laje.
    const fromFloor = up ? flight : flight + 1;
    const door = stairDoor(fromFloor);
    const board = shift(up ? stairFoot(flight) : stairHead(flight));
    const steps = stairSteps(flight, lane);
    const climb = up ? steps : [...steps].reverse().slice(1).concat([shift(stairFoot(flight))]);

    // A porta da escada e a entrada no patamar são chão: andar. Só os degraus são
    // 'stair' — é o que deixa a asserção de faixa falar de degrau, e não de piso.
    walkAlong(scene, a, walkPath(a, shift(door), fromFloor === GROUND_FLOOR ? GROUND_LANE : LANE), cmds);
    walkAlong(scene, a, [board], cmds);
    walkAlong(scene, a, climb, cmds, 'stair');
    // Sai do poço para o piso do andar de destino.
    walkAlong(scene, a, [shift(stairDoor(up ? flight + 1 : flight))], cmds);
  }
  walkAlong(scene, a, walkPath(a, target, to === GROUND_FLOOR ? GROUND_LANE : LANE), cmds);
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
  moveTo(scene, a, home, cmds);
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
  for (const other of scene.agents.values()) other.pathOpen = false;
  const a = ensureAgent(scene, ev.agentId, ev.agentType, cmds);

  switch (ev.kind) {
    case 'spawn': {
      a.status = 'walking';
      a.since = Date.now();
      const home = roomHome(a.room);
      // Quem chega de fora entra pelo térreo e sobe a escada; quem já está no
      // andar só anda. Quem decide é o moveTo.
      moveTo(scene, a, home, cmds);
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
        a.subject = null;   // convocar não toca em móvel: nada a mostrar no elenco
        a.away = false;
        moveTo(scene, a, roomHome(a.room), cmds);
        cmds.push({ op: 'agent-state', agent: a });
        if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
        break;
      }

      // O que a ferramenta tocou (arquivo, comando, busca) vive no registro e no
      // elenco — não vira móvel novo na planta (issue #14).
      a.subject = seed.label || null;
      const p = STATIONS[seed.kind]
        ? ensureStation(scene, seed, cmds)
        : roomPropFor(scene, a.room, seed.kind);
      a.propKey = p.key;
      // O uso é contado num lugar só: aqui. A estação é compartilhada, e contar
      // também na criação dava dois usos para a primeira ferramenta.
      p.uses++;
      p.detail = seed.detail || undefined;

      if (p.fixed) {
        // Estação: recurso singular no térreo. O robô desce de elevador até lá,
        // usa a estação, e o cômodo dele fica "ocupado, fora" enquanto isso
        // (issue #9). `rank` afasta quem divide a mesma estação.
        const rank = [...scene.agents.values()].filter((o) => o !== a && o.away && o.propKey === p.key).length;
        const spot = stationStand(p, rank);
        a.away = true;
        moveTo(scene, a, spot, cmds);
      } else {
        a.away = false;
        moveTo(scene, a, standAt(p, a.room), cmds);
      }
      cmds.push({ op: 'prop-hit', prop: p, by: a.id, subject: a.subject });
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
      moveTo(scene, a, DOOR, cmds);
      if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'result' });
      cmds.push({ op: 'agent-leave', id: a.id });
      // O cômodo esvaziou: a mobília dele é desmontada. As estações do térreo,
      // que são do prédio, ficam.
      unfurnishRoom(scene, a.room, cmds);
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
  const cmds = [];
  for (const ev of events || []) {
    for (const c of apply(scene, ev)) cmds.push({ ...c, instant: true });
  }
  return cmds;
}
