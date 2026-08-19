// A paleta do escritório, sem uma linha de DOM nem de three.
//
// Vive num módulo próprio porque a cor deixou de ser detalhe de desenho: com o
// escritório colorido (ADR-0004), é a paleta que garante que o olho ainda ache os
// agentes. O `selftest.mjs` afirma as distâncias de matiz que sustentam essa
// leitura — se alguém pintar uma parede da cor de um robô, o teste reprova.

/** Matiz, saturação e luz em HSL, no formato que o three e o CSS entendem. */
export const hsl = (h, s, l) => ({ h, s, l });

// ── o escritório ──────────────────────────────────────────────────────────
//
// Direção **Sumida** (ADR-0006): a cidade molhada vista de cima. Azul-petróleo
// profundo no chão e nas paredes, e a cor forte reservada ao que é luz — a fita de
// néon na quina da parede, a tela acesa, o robô.
//
// A regra que sustenta isso inverteu-se: antes o escritório era claro e o robô se
// achava por ser saturado sobre superfície clara. Agora o fundo é escuro e de valor
// baixo, e **quem emite é quem se lê**. Toda superfície grande fica abaixo de 30% de
// luz; nada aqui compete com um robô aceso.

export const BUILDING = {
  wall: hsl(214, 0.42, 0.24),         // parede azul-noite
  wallTrim: hsl(196, 0.95, 0.58),     // a fita de néon no topo da parede — isto é luz
  floorA: hsl(213, 0.44, 0.24),       // piso das salas e do corredor, escuro e polido
  floorB: hsl(232, 0.52, 0.28),       // piso do saguão: violeta, para a entrada se ler de longe
  slab: hsl(214, 0.45, 0.11),         // espessura da laje
  divider: hsl(205, 0.35, 0.30),      // divisória entre salas
  stair: hsl(28, 0.70, 0.44),         // soleira da porta
  landing: hsl(28, 0.60, 0.34),
  rail: hsl(196, 0.90, 0.50),         // guarda-corpo, no mesmo ciano da fita
  terrain: hsl(215, 0.55, 0.11),      // a rua molhada em volta
  sidewalk: hsl(212, 0.40, 0.15),     // calçada
};

/** O ciano e o magenta que fazem o Sumida. Só aparecem como luz, nunca como área. */
export const NEON = {
  cool: hsl(190, 1.00, 0.62),
  hot: hsl(322, 1.00, 0.66),
};

// ── os móveis ─────────────────────────────────────────────────────────────
//
// Seis matizes distintos, cada um a pelo menos 14° do vizinho: com poucos volumes
// por sala, é a cor que distingue mesa de estante de longe. No Sumida eles são
// escuros — o que os separa do piso é matiz e aresta acesa, não valor.

export const PROPS = {
  whiteboard: hsl(168, 0.55, 0.32),   // quadro, verde-água
  terminal: hsl(190, 0.62, 0.32),     // terminal, ciano
  desk: hsl(214, 0.45, 0.30),         // mesa, azul-aço
  cabinet: hsl(258, 0.45, 0.36),      // arquivo morto, violeta
  shelf: hsl(322, 0.58, 0.36),        // estante, magenta
  library: hsl(350, 0.55, 0.36),      // biblioteca, rosa-carmim
  screen: hsl(200, 0.60, 0.13),       // vidro apagado
  screenLit: hsl(186, 1.00, 0.66),    // vidro aceso — isto é luz
};

// ── os agentes ────────────────────────────────────────────────────────────
//
// Seis matizes, escolhidos para se separarem entre si **e** do fundo (ADR-0004). O
// Sumida moveu esta lista: com o escritório azul, a faixa de 193° a 252° virou fundo
// inteiro, e os antigos 214 (azul) e 334 (magenta) caíam dentro dela — dois robôs
// que sumiriam na própria parede. Foi o preço previsto ao escolher a direção.
// O sexto é o **rosa** (issue #17), e ele existe de propósito: numa paleta que já
// tem violeta e magenta, é o rosa que fecha a volta sem colidir com nenhum dos dois.
// O principal não usa matiz: leva o arco-íris.

export const AGENT_HUES = [28, 76, 152, 262, 300, 332];

/**
 * A luz da carcaça do robô. Mora aqui, e não no renderizador, porque é o número
 * que o `selftest` compara com o fundo — duplicado, ele saía de sincronia com o
 * desenho na primeira vez que alguém clareasse o robô, e a asserção passaria a
 * afirmar um robô que não existe mais.
 */
export const SHELL_L = 0.66;

/** O vermelho do rosto de erro. Não pode se confundir com matiz de agente. */
export const ERROR_HUE = 0;

/** A menor distância entre dois matizes, na roda de 360°. */
export function hueGap(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

/**
 * As cores do prédio que ficam **atrás** de um robô e por isso disputam leitura
 * com a carcaça dele. Vidro e arremates não entram: são detalhes pequenos.
 */
export const BACKDROP = [BUILDING.wall, BUILDING.floorA, BUILDING.floorB, BUILDING.slab, BUILDING.terrain];

/** Formata para CSS. Serve à interface 2D, que lê a mesma paleta. */
export const css = (c) => `hsl(${c.h} ${Math.round(c.s * 100)}% ${Math.round(c.l * 100)}%)`;
