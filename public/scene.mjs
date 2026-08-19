// Estado da cena, sem uma linha de DOM.
//
// Recebe eventos do servidor e devolve uma lista de comandos que o renderizador
// executa. A separação existe para o `selftest.mjs` poder exercitar toda a
// lógica de posicionamento em Node, sem navegador.
//
// Modelo espacial: **um pavimento só** — três salas de trabalho lado a lado, um
// corredor à frente delas e, adiantado no meio, um saguão quadrado por onde todo
// mundo entra e sai. O escritório já vem mobiliado e a mobília não se desmonta:
// sala vazia é sala vazia, não sala sem móvel.

// ── o mundo 3D ────────────────────────────────────────────────────────────
//
// O escritório é uma cena 3D (ADR-0003). A cena raciocina em **unidades de
// mundo** — `wx` para o lado, `wz` para a profundidade, `wy` para a altura — e é
// ela quem resolve toda a geometria: onde fica a sala, onde o robô pisa, onde
// cada móvel assenta. O renderizador recebe pontos prontos e não calcula nada.
//
// Um ladrilho é uma unidade. Não há andares: `wy` é sempre o piso, e é isso que
// apaga de uma vez a escada, o poço, o escalonamento das lajes e o robô que
// aparecia andando no ar.

export const TILE = 1;                        // uma unidade de mundo = um ladrilho
export const FLOOR_Y = 0;                     // o piso, e a única altura que existe

// Pé-direito desenhado. Baixo de propósito: parede alta, com a câmera inclinada,
// projeta sobre o piso e a sala vira uma faixa preta.
export const WALL_H = 1.9;

// ── a planta ──────────────────────────────────────────────────────────────
//
// Três salas iguais no fundo, um corredor cruzando a frente delas e o saguão
// adiantado no meio. A planta é um **T**: o saguão avança para fora da fita das
// salas, e é esse avanço que o faz ler como entrada do prédio à primeira vista,
// sem depender de rótulo.
//
//        ┌───────┬───────┬───────┐
//        │ SALA 1│ SALA 2│ SALA 3│
//        └───────┴───────┴───────┘
//        ═════════ corredor ══════
//                ┌───────┐
//                │ SAGUÃO│
//                └── ▯ ──┘   ← a porta

/**
 * A **escala da planta**. O escritório cresceu 1,7× sem que o robô ou a mobília
 * crescessem junto — e é justamente essa diferença que o faz ler como maior: a
 * mesma mesa num chão maior mostra chão. Ela também é o que paga o desvio de
 * mobília: com a sala apertada, contornar um armário era sair pela parede.
 *
 * Só as medidas da **planta** passam por aqui. Móvel e robô não: multiplicar
 * tudo junto devolve exatamente o escritório de antes, com outro número na
 * câmera.
 */
export const SCALE = 1.7;

export const ROOM_COUNT = 3;
export const ROOM_W = 8 * SCALE;
export const ROOM_D = 8 * SCALE;

/** Fundo do corredor. Duas larguras de robô: dois se cruzam sem se raspar. */
export const CORRIDOR_D = 3.6 * SCALE;

/** O saguão é quadrado — é o que o distingue das salas de longe. */
export const LOBBY_SIDE = 7 * SCALE;

/**
 * A **galeria**: o corredor estreito que liga o corredor das salas ao saguão. Sem
 * ela o saguão nascia colado na fita das salas e a boca dele era a largura toda —
 * o que se lia como um recorte da mesma sala, não como outro espaço. Separar e
 * ligar por passagem é o que faz o saguão existir por conta própria.
 */
export const NECK_D = 4 * SCALE;      // o quanto o saguão fica afastado
export const NECK_W = 3 * SCALE;      // largura da passagem: um robô passa, dois se cruzam apertado

const ROOMS_Z1 = ROOM_D;                                  // onde as salas terminam
const CORRIDOR_Z1 = ROOMS_Z1 + CORRIDOR_D;                // e o corredor
const NECK_Z1 = CORRIDOR_Z1 + NECK_D;                     // e a galeria
export const PLATE = { x: ROOM_W * ROOM_COUNT, z: NECK_Z1 + LOBBY_SIDE };

/** A faixa em x que o saguão ocupa: centrado na fita das salas. */
export const LOBBY_X0 = (PLATE.x - LOBBY_SIDE) / 2;
export const LOBBY_X1 = LOBBY_X0 + LOBBY_SIDE;

/** O eixo da galeria e a faixa em x que ela ocupa. */
export const NECK_CX = PLATE.x / 2;
export const NECK_X0 = NECK_CX - NECK_W / 2;
export const NECK_X1 = NECK_CX + NECK_W / 2;

/** Ponto de mundo a partir de coordenadas locais da planta. */
export function world(lx, lz) {
  return { wx: lx, wy: FLOOR_Y, wz: lz };
}

/** A sala `i` em coordenadas locais, com a folga que a separa da divisória. */
export function roomRect(i) {
  const pad = 0.25;
  return { lx: i * ROOM_W + pad, lz: pad, w: ROOM_W - pad * 2, d: ROOM_D - pad * 2, index: i };
}

/** O saguão em coordenadas locais. */
export const LOBBY = { lx: LOBBY_X0, lz: NECK_Z1, w: LOBBY_SIDE, d: LOBBY_SIDE };

/** A galeria em coordenadas locais. */
export const NECK = { lx: NECK_X0, lz: CORRIDOR_Z1, w: NECK_W, d: NECK_D };

/** Os quatro cantos de uma sala, no mundo. Serve ao rótulo e ao contorno. */
export function roomQuad(i) {
  const r = roomRect(i);
  return [
    world(r.lx, r.lz),
    world(r.lx + r.w, r.lz),
    world(r.lx + r.w, r.lz + r.d),
    world(r.lx, r.lz + r.d),
  ];
}

/**
 * O contorno do pavimento: a fita das salas com o corredor, a galeria descendo
 * estreita do meio dela, e o saguão quadrado no fim. Doze pontos, em sentido
 * horário visto de cima — é o estrangulamento da galeria que dá a silhueta.
 */
export function officeShape() {
  const p = PLATE;
  return [
    world(0, 0),
    world(p.x, 0),
    world(p.x, CORRIDOR_Z1),
    world(NECK_X1, CORRIDOR_Z1),
    world(NECK_X1, NECK_Z1),
    world(LOBBY_X1, NECK_Z1),
    world(LOBBY_X1, p.z),
    world(LOBBY_X0, p.z),
    world(LOBBY_X0, NECK_Z1),
    world(NECK_X0, NECK_Z1),
    world(NECK_X0, CORRIDOR_Z1),
    world(0, CORRIDOR_Z1),
  ];
}

/**
 * As paredes desenhadas: só as que ficam **atrás** ou ao lado do olhar. A frente
 * de cada espaço fica aberta, senão a parede projeta sobre o próprio piso e tapa
 * o que interessa. Cada uma é um segmento com espessura.
 */
export function walls() {
  const p = PLATE;
  const seg = (x0, z0, x1, z1) => ({ a: world(x0, z0), b: world(x1, z1), h: WALL_H });
  return [
    seg(0, 0, p.x, 0),                            // fundo das salas
    seg(0, 0, 0, CORRIDOR_Z1),                    // lateral esquerda
    seg(p.x, 0, p.x, CORRIDOR_Z1),                // lateral direita
    seg(0, CORRIDOR_Z1, NECK_X0, CORRIDOR_Z1),    // frente do corredor, até a boca da galeria
    seg(NECK_X1, CORRIDOR_Z1, p.x, CORRIDOR_Z1),  // e do outro lado dela
    seg(NECK_X0, CORRIDOR_Z1, NECK_X0, NECK_Z1),  // as duas paredes da galeria
    seg(NECK_X1, CORRIDOR_Z1, NECK_X1, NECK_Z1),
    seg(LOBBY_X0, NECK_Z1, NECK_X0, NECK_Z1),     // fundo do saguão, dos dois lados da boca
    seg(NECK_X1, NECK_Z1, LOBBY_X1, NECK_Z1),
    seg(LOBBY_X0, NECK_Z1, LOBBY_X0, p.z),        // laterais do saguão
    seg(LOBBY_X1, NECK_Z1, LOBBY_X1, p.z),
  ];
}

/** As divisórias entre salas: do fundo até a boca do corredor. */
export function partitions() {
  const out = [];
  for (let i = 1; i < ROOM_COUNT; i++) {
    out.push({ a: world(i * ROOM_W, 0), b: world(i * ROOM_W, ROOMS_Z1), h: WALL_H });
  }
  return out;
}

// A faixa livre da frente das salas. Todo trajeto passa por ela: é o corredor, e
// é o que faz o robô contornar em vez de atravessar a sala dos outros.
export const LANE = ROOMS_Z1 + CORRIDOR_D / 2;

// A faixa livre do saguão, logo depois da boca da galeria. É o equivalente do
// corredor lá dentro: quem sai da galeria entra nela e só então vira para o alvo.
export const LOBBY_LANE = LOBBY.lz + 2.2;

// Entrada do escritório, no meio da borda da frente do saguão: quem chega de fora
// nasce aqui, e quem sai caminha até aqui antes de desaparecer.
export const DOOR = world(PLATE.x / 2, PLATE.z - 1.0);

// ── postos e salas ────────────────────────────────────────────────────────
//
// Dois postos por sala, três salas: seis lugares, um por matiz da paleta. O
// `slot` é o posto; a sala se deriva dele. Foi assim que o prédio deixou de
// crescer para cima — com seis lugares fixos, um sétimo agente divide posto em
// vez de inaugurar um andar que ninguém pediu.

export const SEATS_PER_ROOM = 2;
export const SEAT_COUNT = ROOM_COUNT * SEATS_PER_ROOM;

// Quantos matizes a paleta tem. Vive aqui, e não só no renderizador, porque é o
// `scene.mjs` que distribui o matiz entre os subagentes.
export const HUE_COUNT = 6;

// Posto reservado ao agente principal: nunca reciclado, para o olho ter um ponto
// de retorno fixo.
export const MAIN_SEAT = 0;

/** A sala e a cadeira de um posto. Acima de seis, os postos se repetem. */
export function seatOf(slot) {
  const base = ((slot % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT;
  return {
    room: Math.floor(base / SEATS_PER_ROOM),
    seat: base % SEATS_PER_ROOM,
    // A partir do sétimo, o posto se repete: o desempate é um passo de lado, para
    // dois não ficarem exatamente no mesmo ponto.
    dup: Math.floor(slot / SEAT_COUNT),
  };
}

// ── a pegada de cada móvel ────────────────────────────────────────────────
//
// O robô precisa **saber onde a mobília está** para não passar por dentro dela, e
// quem sabe é o `scene.mjs`: ele é que resolve a geometria. `PROP_FOOT` é a
// planta baixa de cada volume — largura em x, profundidade em z, e o deslocamento
// do centro da pegada em relação ao ponto do móvel (a mesa tem cadeira na frente,
// e o centro da pegada não é o centro do tampo).
//
// **Isto espelha o `propVolume()` do renderizador.** Mudou o volume desenhado,
// atualize a pegada — senão o robô contorna um móvel de um tamanho e o olho vê
// outro. O `selftest` confere que toda pegada cabe na sala e que nenhuma engole
// o ponto onde alguém fica em pé.
/**
 * O quanto o volume do móvel cresceu junto com a planta. Menos que a planta, de
 * propósito: crescer tudo na mesma proporção devolve o escritório de antes com
 * outro número na câmera. Mas mobília no tamanho antigo numa sala 1,7× maior lia
 * como brinquedo largado no chão — e sala com móvel de brinquedo lê como sala
 * vazia. O renderizador multiplica o volume por este mesmo número.
 */
export const PROP_K = 1.3;

export const PROP_FOOT = {
  desk: { w: 1.9, d: 2.3, dz: 0.35 },     // tampo, pés e a cadeira à frente
  shelf: { w: 1.5, d: 0.62, dz: 0 },
  cabinet: { w: 1.5, d: 1.0, dz: 0 },
  whiteboard: { w: 2.52, d: 0.5, dz: -0.35 },
  terminal: { w: 1.9, d: 1.2, dz: -0.15 },
  library: { w: 2.2, d: 0.56, dz: -0.3 },
  door: { w: 2.2, d: 0.6, dz: 0 },
};

/** Meio corpo do robô, mais a folga que o impede de raspar. */
export const BODY = 0.62;

const QUARTER = Math.PI / 2;

/** A pegada de um móvel no mundo, já girada. `pad` é a folga extra em volta. */
export function footprint(prop, pad = 0) {
  const f = PROP_FOOT[prop.kind] || PROP_FOOT.desk;
  const k = PROP_K * (prop.station ? 1.15 : 1);
  const deitado = Math.abs(Math.cos(prop.rot || 0)) < 0.5;    // ±90°: largura e fundo trocam
  const w = (deitado ? f.d : f.w) * k;
  const d = (deitado ? f.w : f.d) * k;
  // O deslocamento acompanha a rotação: o móvel girado tem a frente para o lado.
  const dz = f.dz * k;
  const cx = prop.wx + (deitado ? -Math.sin(prop.rot || 0) * dz : 0);
  const cz = prop.wz + (deitado ? 0 : Math.cos(prop.rot || 0) * dz);
  return { x0: cx - w / 2 - pad, x1: cx + w / 2 + pad, z0: cz - d / 2 - pad, z1: cz + d / 2 + pad };
}

/** Toda a mobília como caixa intransponível, com a folga do corpo do robô. */
export function obstacles(pad = BODY) {
  // A porta fica de fora: ela é um vão, e é por dentro dele que se entra e sai.
  return fixedProps()
    .filter((p) => p.kind !== 'door')
    .map((p) => ({ key: p.key, ...footprint(p, pad) }));
}

// Onde cada móvel assenta dentro da sala, em coordenadas locais dela. Espalhados
// de propósito: enfileirados, os três volumes liam como um balcão só, e a sala
// parecia um corredor. Cada um encosta numa parede diferente e sobra chão no meio
// para o robô circular.
//
// As posições saem das **bordas** da sala, não de uma fração dela: com a planta a
// 1,7×, uma fração deixaria a estante boiando a dois metros da parede — a sala
// cresce, o móvel continua do mesmo tamanho, e é a parede que ele tem de encostar.
//
// `rot` é o quarto de volta que põe a frente do móvel virada para o miolo da
// sala. Sem ele, a estante encostada na parede da direita mostrava o fundo fechado
// para quem olha, e a sala parecia mobiliada de costas.
const ROOM_LAYOUT = {
  desk: [
    { lx: 2.4, lz: ROOM_D * 0.30, rot: 0 },                     // posto do fundo, à esquerda
    { lx: ROOM_W - 2.4, lz: ROOM_D * 0.66, rot: 0 },            // posto da frente, à direita
  ],
  shelf: { lx: ROOM_W - 1.1, lz: 2.6, rot: -QUARTER },          // parede da direita
  cabinet: { lx: 1.1, lz: ROOM_D - 2.6, rot: QUARTER },         // parede da esquerda
  whiteboard: { lx: ROOM_W * 0.5, lz: 1.0, rot: 0 },            // parede do fundo
};

/** O ponto de mundo de um móvel da sala. */
function roomSpot(room, at) {
  return { ...world(room * ROOM_W + at.lx, at.lz), rot: at.rot || 0 };
}

/** A mesa de um posto. */
export function deskOf(slot) {
  const s = seatOf(slot);
  return roomSpot(s.room, ROOM_LAYOUT.desk[s.seat]);
}

/**
 * Onde o robô fica parado: logo à frente da própria mesa, **fora da pegada dela**.
 * A distância sai da pegada, não de um número solto: era 1,5 fixo, e com a mesa
 * medindo 2,3 de fundo o robô parava dentro da própria cadeira.
 */
export function seatHome(slot) {
  const d = deskOf(slot);
  const s = seatOf(slot);
  const f = footprint({ kind: 'desk', wx: d.wx, wz: d.wz, rot: d.rot });
  return { ...d, wz: f.z1 + BODY + 0.2, wx: d.wx + s.dup * 0.9 };
}

// As duas estações canônicas (CONTEXT.md): recurso singular no escritório
// inteiro, e por isso moram no saguão — o espaço que é de todos. As outras duas
// viraram mobília de sala: quadro e arquivo são de quem trabalha ali, e obrigar
// o robô a atravessar o escritório para riscar um quadro era caminhada à toa.
const stationAt = (lx, lz, label, rot) => ({ ...world(lx, lz), label, rot });
export const STATIONS = {
  terminal: stationAt(LOBBY_X0 + 1.1, LOBBY.lz + 3.4, 'TERMINAL', QUARTER),
  library: stationAt(LOBBY_X1 - 1.1, LOBBY.lz + 3.4, 'BIBLIOTECA', -QUARTER),
};

// ── a mobília, que é do prédio ─────────────────────────────────────────────
//
// O escritório já vem mobiliado e **nada some**. Antes a mobília era montada
// quando a sala ganhava ocupante e desmontada quando esvaziava; o efeito era um
// escritório que piscava vazio a cada saída, e uma sala sem móvel lê como sala
// não construída. Agora a mobília faz parte da planta: é função pura da planta,
// e o renderizador a monta uma vez junto com as paredes.

/** A chave do móvel compartilhado da sala, e a do móvel do posto. */
const roomPropKey = (room, kind) => `sala${room}|${kind}`;
const deskPropKey = (slot) => `posto${slot}|desk`;

/**
 * Todo móvel do escritório, do jeito que ele nasce. Função pura: mesma planta,
 * mesma lista — é o que deixa o `selftest` conferir a mobília inteira sem
 * encenar sessão nenhuma.
 */
export function fixedProps() {
  const out = [];
  const add = (p) => out.push({ ...p, uses: 0 });

  for (let room = 0; room < ROOM_COUNT; room++) {
    const nome = `SALA ${room + 1}`;
    for (const kind of ['shelf', 'cabinet', 'whiteboard']) {
      add({ kind, key: roomPropKey(room, kind), label: kind, room: nome, ...roomSpot(room, ROOM_LAYOUT[kind]) });
    }
    for (let seat = 0; seat < SEATS_PER_ROOM; seat++) {
      const slot = room * SEATS_PER_ROOM + seat;
      add({ kind: 'desk', key: deskPropKey(slot), label: 'mesa', room: nome, slot, ...deskOf(slot) });
    }
  }

  for (const [kind, st] of Object.entries(STATIONS)) {
    add({ kind, key: kind, label: st.label, room: 'SAGUÃO', station: true, wx: st.wx, wy: st.wy, wz: st.wz, rot: st.rot });
  }

  add({ kind: 'door', key: 'door', label: 'PORTA', room: 'SAGUÃO', wx: DOOR.wx, wy: DOOR.wy, wz: DOOR.wz });
  return out;
}

/**
 * O móvel que atende àquele tipo de ferramenta para o agente do posto `slot`. A
 * estação é do prédio; o resto é da sala do agente; o que não tem casa própria
 * cai na mesa dele.
 */
function propFor(scene, slot, kind) {
  if (STATIONS[kind]) return scene.props.get(kind);
  const s = seatOf(slot);
  return scene.props.get(roomPropKey(s.room, kind)) || scene.props.get(deskPropKey(slot % SEAT_COUNT));
}

/** Onde o robô encosta para usar um móvel: logo à frente dele, dentro da sala. */
function standAt(prop, slot) {
  const s = seatOf(slot);
  const r = roomRect(s.room);
  const f = footprint(prop);
  // À frente da pegada, nunca dentro dela — e sem passar da boca da sala.
  const lz = Math.min(f.z1 + BODY + 0.2, r.lz + r.d - 0.4);
  return world(prop.wx, lz);
}

/**
 * Onde o robô fica em pé no saguão para usar uma estação. `rank` desempata quem
 * está na mesma estação ao mesmo tempo, para dois não se sobreporem.
 */
export function stationStand(station, rank = 0) {
  const side = rank % 2 === 0 ? 1 : -1;
  const spread = Math.ceil(rank / 2) * 1.3;
  // Para dentro do saguão: a estação encosta na parede lateral, e quem a usa fica
  // de frente para ela, no meio do saguão. O desempate é ao longo da parede, em z.
  const dentro = station.wx < PLATE.x / 2 ? 2.0 : -2.0;
  return { wx: station.wx + dentro, wy: station.wy, wz: station.wz + side * spread };
}

/**
 * A caixa do escritório no mundo, para a câmera enquadrar. Constante: sem
 * andares, o prédio não muda de tamanho durante a sessão, e o enquadramento
 * deixou de saltar a cada agente que entra.
 */
export function buildingBounds() {
  const pts = officeShape();
  return {
    min: { x: Math.min(...pts.map((p) => p.wx)), y: FLOOR_Y, z: Math.min(...pts.map((p) => p.wz)) },
    max: { x: Math.max(...pts.map((p) => p.wx)), y: FLOOR_Y + WALL_H, z: Math.max(...pts.map((p) => p.wz)) },
  };
}

/**
 * O terreno: o chão em que o escritório se apoia, com folga em volta. Sem ele o
 * piso flutuava no vazio, e a cena parecia recortada no ar.
 */
export const TERRAIN_MARGIN = 2.5;

export function terrainRect() {
  const b = buildingBounds();
  return {
    x0: b.min.x - TERRAIN_MARGIN,
    x1: b.max.x + TERRAIN_MARGIN,
    z0: b.min.z - TERRAIN_MARGIN,
    z1: b.max.z + TERRAIN_MARGIN,
    y: FLOOR_Y - 0.55,
  };
}

// Palavras que não nomeiam nada: caem fora do apelido. São as de ligação, não as
// de conteúdo — o verbo fica, porque é ele que diz o que o agente veio fazer.
const VAZIAS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na',
  'nos', 'nas', 'por', 'para', 'com', 'que', 'e', 'ou', 'todo', 'toda', 'todos', 'todas',
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'all', 'any', 'this',
]);

/**
 * O apelido de um agente, tirado da descrição da tarefa que o convocou. O
 * `agent_type` sozinho não nomeia ninguém — metade dos subagentes chega como
 * `general-purpose`, e uma planta com três "general-purpose" não diz quem é quem.
 * A descrição do `Task` diz.
 *
 * A regra é curta de propósito: fora as palavras de ligação, ficam as duas
 * primeiras de conteúdo. "mapear todos os handlers de auth" vira "mapear handlers"
 * — cabe numa plaqueta e ainda é reconhecível na lista.
 */
export function apelido(texto) {
  if (!texto) return null;
  const palavras = String(texto)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !VAZIAS.has(w));
  if (!palavras.length) return null;
  const nome = palavras.slice(0, 2).join(' ');
  return nome.length > 24 ? palavras[0].slice(0, 24) : nome;
}

export function createScene() {
  const props = new Map();
  // A mobília nasce com a cena, não com o ocupante: é do prédio.
  for (const p of fixedProps()) props.set(p.key, p);
  // `chamado` guarda a última convocação ainda sem dono: o `Task` traz a descrição,
  // e o `SubagentStart` que vem logo atrás é quem a recebe como nome.
  return { agents: new Map(), props, hueSeq: 0, chamado: null };
}

// ── postos ─────────────────────────────────────────────────────────────────

/**
 * O próximo matiz livre, **girando** pela paleta. Era `agents.size % HUE_COUNT`, e
 * isso tinha três defeitos calados:
 *
 *   - com o principal contando no tamanho, o índice 0 nunca saía — o primeiro matiz
 *     da paleta não aparecia em sessão nenhuma;
 *   - o matiz de quem saía voltava para o começo da fila, então uma sessão inteira
 *     podia usar sempre os mesmos três;
 *   - e por isso o sexto matiz, o **rosa**, só existiria numa sessão com cinco
 *     subagentes vivos ao mesmo tempo — que é mais do que o escritório costuma ter.
 *
 * Girando, os seis aparecem ao longo da sessão mesmo com poucos agentes vivos, e
 * dois que estão no escritório ao mesmo tempo continuam sem repetir cor.
 */
function allocHue(scene) {
  const taken = new Set([...scene.agents.values()].filter((a) => !a.isMain).map((a) => a.hueIndex));
  const inicio = scene.hueSeq || 0;
  for (let k = 0; k < HUE_COUNT; k++) {
    const i = (inicio + k) % HUE_COUNT;
    if (!taken.has(i)) {
      scene.hueSeq = (i + 1) % HUE_COUNT;
      return i;
    }
  }
  // Escritório cheio de subagentes: repete, sem estourar o índice.
  scene.hueSeq = (inicio + 1) % HUE_COUNT;
  return inicio;
}

/** Menor índice de posto que não está no conjunto de ocupados. */
function firstFreeSeat(taken) {
  for (let i = 0; ; i++) if (!taken.has(i)) return i;
}

/**
 * Índice do primeiro posto livre. Vagas recicladas contam como livres. O posto do
 * principal fica reservado enquanto ele estiver no escritório.
 */
function allocSeat(scene, agent) {
  if (agent.isMain) return MAIN_SEAT;
  const taken = new Set();
  let mainPresent = false;
  for (const a of scene.agents.values()) {
    if (a === agent) continue;
    if (a.isMain) mainPresent = true;
    if (a.slot != null) taken.add(a.slot);
  }
  if (mainPresent) taken.add(MAIN_SEAT);
  return firstFreeSeat(taken);
}

/**
 * Muda um agente de posto. Usado quando o principal aparece depois que um
 * subagente já ocupou o posto reservado — raro (o principal costuma ser o
 * primeiro a agir), mas mantém o endereço do principal constante mesmo assim.
 */
function relocateAgent(scene, agent, cmds) {
  const taken = new Set([MAIN_SEAT]);
  for (const a of scene.agents.values()) if (a !== agent && a.slot != null) taken.add(a.slot);
  agent.slot = firstFreeSeat(taken);
  agent.propKey = null;
  // Muda de posto andando pelo corredor, como qualquer outro trajeto: o salto
  // instantâneo era o que fazia a realocação parecer teleporte.
  moveTo(scene, agent, seatHome(agent.slot), cmds);
}

function ensureAgent(scene, id, type, cmds) {
  let a = scene.agents.get(id);
  if (!a) {
    const isMain = id === 'main';
    a = {
      id,
      type: type || 'claude',
      isMain,
      hueIndex: isMain ? -1 : allocHue(scene),
      face: 1,
      status: 'idle',
      tool: null,
      propKey: null,
      away: false,        // fora da própria sala, usando uma estação do saguão
      toolCount: 0,
      since: Date.now(),
    };
    // Se um subagente já tomou o posto reservado do principal, ele cede a vaga
    // antes de o principal entrar.
    if (isMain) {
      const squatter = [...scene.agents.values()].find((o) => o.slot === MAIN_SEAT);
      if (squatter) relocateAgent(scene, squatter, cmds);
    }
    a.slot = allocSeat(scene, a);
    // O nome vem da convocação que ainda não tinha dono. Consumir aqui, e não no
    // `spawn`, cobre o agente que aparece direto por um evento de ferramenta.
    if (!isMain && scene.chamado) {
      a.name = scene.chamado;
      scene.chamado = null;
    }
    // Todo subagente entra pela porta, no saguão, e caminha até a sala dele —
    // inclusive o filho convocado por outro agente. O principal é a exceção: ele
    // já estava dentro, e nasce no posto.
    const start = isMain ? seatHome(a.slot) : DOOR;
    a.wx = start.wx;
    a.wy = start.wy;
    a.wz = start.wz;
    scene.agents.set(id, a);
    // Emitido aqui, e não só no spawn: o agente principal nunca dá spawn — ele
    // aparece no primeiro evento que gerar, e sem isto ficava invisível. O ponto
    // de entrada vai no comando, não só no objeto: o `moveTo` seguinte sobrescreve
    // `a.wx`, e sem o retrato o renderizador perderia de onde partir.
    cmds?.push({ op: 'agent-enter', agent: a, wx: a.wx, wy: a.wy, wz: a.wz });
  }
  if (type && type !== 'main') a.type = type;
  return a;
}

/** O ponto está do lado do saguão (depois da boca da galeria)? */
const noSaguao = (p) => p.wz >= LOBBY.lz - 0.01;

/**
 * O caminho de um ponto a outro. Sai do lugar até a faixa livre, corre por ela e
 * entra no destino — em L, como quem anda por um escritório de verdade.
 *
 * Com o saguão afastado, o trajeto entre os dois lados **tem de passar pela
 * galeria**: ela é estreita, e um L simples cortava a diagonal por cima da parede
 * dela. O caminho ganhou o eixo da galeria como ponto obrigatório — quatro pernas
 * em vez de duas, e é assim que se lê como alguém atravessando uma passagem.
 *
 * Pontos repetidos são descartados, então um trajeto curto continua curto.
 */
function walkPath(from, to) {
  const pts = [];
  const push = (wx, wz) => {
    const last = pts[pts.length - 1] || from;
    if (Math.abs(last.wx - wx) > 0.05 || Math.abs(last.wz - wz) > 0.05) pts.push(world(wx, wz));
  };
  // A faixa livre de cada lado: o corredor das salas, ou a do saguão.
  const laneOf = (p) => (noSaguao(p) ? LOBBY_LANE : LANE);
  // O atalho reto só vale **dentro do mesmo espaço**. Fora dele o L é obrigatório:
  // dois pontos com a mesma profundidade em salas vizinhas davam uma perna reta que
  // varava a divisória — e, de quebra, a mesa que estivesse no meio do caminho.
  const espaco = (p) => freeRects().findIndex((r) =>
    p.wx >= r.x0 - 0.3 && p.wx <= r.x1 + 0.3 && p.wz >= r.z0 - 0.3 && p.wz <= r.z1 + 0.3);
  const emL = (de, alvo, lane) => {
    const junto = espaco(de) === espaco(alvo);
    const perto = Math.abs(de.wz - alvo.wz) < 0.5 || Math.abs(de.wx - alvo.wx) < 0.5;
    if (junto && perto) return;
    push(de.wx, lane);
    push(alvo.wx, lane);
  };

  if (noSaguao(from) !== noSaguao(to)) {
    // Atravessar: até a faixa deste lado, até o eixo da galeria, pela galeria, e
    // então a faixa do outro lado.
    const aqui = laneOf(from);
    const la = laneOf(to);
    push(from.wx, aqui);
    push(NECK_CX, aqui);
    push(NECK_CX, la);
    push(to.wx, la);
    push(to.wx, to.wz);
    return pts;
  }

  emL(from, to, laneOf(to));
  push(to.wx, to.wz);
  return pts;
}

// ── desviar da mobília ────────────────────────────────────────────────────
//
// O L do `walkPath` resolve a parede, não o móvel: ele cortava reto por dentro da
// mesa e da estante, e o robô atravessava o volume como se fosse fumaça. Agora o
// trajeto passa por um segundo crivo — cada perna é cruzada com a pegada de cada
// móvel, e a que bate ganha um contorno de dois pontos pelo lado mais perto.
//
// O desvio é validado antes de entrar: um contorno que caia fora do piso, ou em
// cima de outro móvel, é descartado e o outro lado é tentado. Se nenhum dos dois
// serve, a perna segue reta — melhor um caso raro feio do que um robô preso na
// beira de um armário.

/** Os retângulos por onde se pode andar. Um desvio tem de cair dentro de um. */
export function freeRects() {
  const out = [];
  for (let i = 0; i < ROOM_COUNT; i++) {
    out.push({ x0: i * ROOM_W, x1: (i + 1) * ROOM_W, z0: 0, z1: ROOMS_Z1 });
  }
  out.push({ x0: 0, x1: PLATE.x, z0: ROOMS_Z1, z1: CORRIDOR_Z1 });
  out.push({ x0: NECK_X0, x1: NECK_X1, z0: CORRIDOR_Z1, z1: NECK_Z1 });
  out.push({ x0: LOBBY_X0, x1: LOBBY_X1, z0: NECK_Z1, z1: PLATE.z });
  return out;
}

const dentroDaCaixa = (p, c) => p.wx > c.x0 && p.wx < c.x1 && p.wz > c.z0 && p.wz < c.z1;

/** O ponto dá pé: cai num retângulo livre, com folga da parede, e fora de móvel. */
function livre(p, boxes) {
  const m = 0.3;
  const pisa = freeRects().some((r) =>
    p.wx >= r.x0 + m && p.wx <= r.x1 - m && p.wz >= r.z0 + m && p.wz <= r.z1 - m);
  return pisa && !boxes.some((c) => dentroDaCaixa(p, c));
}

/** A primeira caixa que o trecho `a→b` corta, ignorando a que já o contém. */
function firstHit(a, b, boxes) {
  let melhor = null;
  let perto = Infinity;
  for (const c of boxes) {
    if (dentroDaCaixa(a, c) || dentroDaCaixa(b, c)) continue;
    const t = cortaCaixa(a, b, c);
    if (t !== null && t < perto) { perto = t; melhor = c; }
  }
  return melhor;
}

/** Onde o trecho entra na caixa, em fração do trecho. `null` se não entra. */
function cortaCaixa(a, b, c) {
  const dx = b.wx - a.wx;
  const dz = b.wz - a.wz;
  let t0 = 0;
  let t1 = 1;
  for (const [p0, d, lo, hi] of [[a.wx, dx, c.x0, c.x1], [a.wz, dz, c.z0, c.z1]]) {
    if (Math.abs(d) < 1e-9) {
      if (p0 <= lo || p0 >= hi) return null;
      continue;
    }
    let e = (lo - p0) / d;
    let s = (hi - p0) / d;
    if (e > s) [e, s] = [s, e];
    t0 = Math.max(t0, e);
    t1 = Math.min(t1, s);
    if (t0 >= t1) return null;
  }
  return t0;
}

/** O trecho `a→b`, contornando o que estiver no caminho. Devolve os pontos até `b`. */
function legAround(a, b, boxes, depth = 0) {
  const c = firstHit(a, b, boxes);
  if (!c || depth >= 3) return [b];
  // O desvio é perpendicular ao trecho, e sai da borda da caixa.
  const horiz = Math.abs(b.wx - a.wx) >= Math.abs(b.wz - a.wz);
  const base = horiz ? (a.wz + b.wz) / 2 : (a.wx + b.wx) / 2;
  const lados = (horiz ? [c.z0 - 0.06, c.z1 + 0.06] : [c.x0 - 0.06, c.x1 + 0.06])
    .sort((u, v) => Math.abs(u - base) - Math.abs(v - base));
  for (const off of lados) {
    const p1 = horiz ? world(a.wx, off) : world(off, a.wz);
    const p2 = horiz ? world(b.wx, off) : world(off, b.wz);
    if (!livre(p1, boxes) || !livre(p2, boxes)) continue;
    return [
      ...legAround(a, p1, boxes, depth + 1),
      ...legAround(p1, p2, boxes, depth + 1),
      ...legAround(p2, b, boxes, depth + 1),
    ];
  }
  return [b];
}

/** O trajeto inteiro, já desviando da mobília. Pontos repetidos caem fora. */
export function avoidProps(from, pts) {
  const boxes = obstacles();
  const out = [];
  let cur = from;
  for (const alvo of pts) {
    for (const q of legAround(cur, alvo, boxes)) {
      const last = out[out.length - 1] || from;
      if (Math.abs(last.wx - q.wx) > 0.05 || Math.abs(last.wz - q.wz) > 0.05) out.push(q);
      cur = q;
    }
  }
  return out;
}

/**
 * Move o robô por um trajeto e emite um comando por perna. Cada perna vira uma
 * animação encadeada no renderizador, com duração proporcional à distância: é
 * isso que faz a cena parecer gente andando em vez de ícone saltando.
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
    cmds.push({ op: 'agent-move', id: a.id, wx: a.wx, wy: a.wy, wz: a.wz, face: a.face, kind, start: first });
    first = false;
  }
}

/**
 * O trajeto pronto de um ponto a outro: o L pelas faixas livres, já contornando a
 * mobília. Ponto único de roteamento, e é por ele que o `selftest` mede.
 */
export function route(from, to) {
  return avoidProps(from, walkPath(from, to));
}

/** Leva o robô a um destino. */
function moveTo(scene, a, target, cmds) {
  walkAlong(scene, a, route(a, target), cmds);
}

/** Volta o agente ao próprio posto, ocioso. */
function returnHome(scene, a, cmds, status = 'idle') {
  a.status = status;
  a.tool = null;
  a.propKey = null;
  a.away = false;
  a.since = Date.now();
  moveTo(scene, a, seatHome(a.slot), cmds);
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
      moveTo(scene, a, seatHome(a.slot), cmds);
      break;
    }

    case 'tool_start': {
      const seed = ev.prop || { kind: 'desk', key: 'tool:' + ev.tool, label: ev.tool };
      a.status = 'working';
      a.tool = ev.tool;
      a.toolCount++;
      a.since = Date.now();

      // Convocar um subagente (a porta) acontece no próprio posto: o filho é que
      // entra pela porta, não o pai.
      if (seed.kind === 'door') {
        // Convocar deixa o nome esperando: o filho que entrar em seguida o pega.
        scene.chamado = apelido(ev.text) || null;
        a.propKey = null;
        a.subject = null;   // convocar não toca em móvel: nada a mostrar no elenco
        a.away = false;
        moveTo(scene, a, seatHome(a.slot), cmds);
        cmds.push({ op: 'agent-state', agent: a });
        if (ev.text) cmds.push({ op: 'say', id: a.id, text: ev.text, tone: 'order' });
        break;
      }

      // O que a ferramenta tocou (arquivo, comando, busca) vive no registro e no
      // elenco — não vira móvel novo na planta.
      a.subject = seed.label || null;
      const p = propFor(scene, a.slot, seed.kind);
      a.propKey = p.key;
      p.uses++;
      p.detail = seed.detail || undefined;

      if (p.station) {
        // Estação: recurso singular, no saguão. O robô sai da sala e vai até lá; o
        // posto dele fica "ocupado, fora" enquanto isso. `rank` afasta quem divide
        // a mesma estação.
        const rank = [...scene.agents.values()].filter((o) => o !== a && o.away && o.propKey === p.key).length;
        a.away = true;
        moveTo(scene, a, stationStand(p, rank), cmds);
      } else {
        a.away = false;
        moveTo(scene, a, standAt(p, a.slot), cmds);
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
      // O posto é liberado: some do elenco e a vaga volta ao pool. A mobília fica
      // onde está — ela é do escritório, não do agente.
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
 * escritório, sem depender de nenhum instantâneo montado pelo servidor (ADR-0001).
 *
 * Construir ao vivo é a mesma construção, só que ainda não terminada: por isso
 * `rebuild` é `apply` em sequência numa cena limpa. A única diferença é que
 * cada comando sai marcado como instantâneo — o escritório aparece pronto em vez
 * de reencenar a caminhada e o balão de fala de cada evento já passado.
 */
export function rebuild(scene, events) {
  scene.agents.clear();
  scene.props.clear();
  scene.hueSeq = 0;
  scene.chamado = null;
  for (const p of fixedProps()) scene.props.set(p.key, p);
  const cmds = [];
  for (const ev of events || []) {
    for (const c of apply(scene, ev)) cmds.push({ ...c, instant: true });
  }
  return cmds;
}
