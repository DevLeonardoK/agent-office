# ADR-0006 — Sumida: o escritório à noite

**Estado**: aceito
**Altera**: ADR-0004 — a regra de leitura continua valendo, mas com o sinal
invertido.

## Contexto

O escritório era claro: parede amarela, piso areia, terreno verde. A leitura do
agente vinha de a carcaça ser saturada e de valor médio **sobre superfície clara**.
Foi pedida uma direção cyberpunk, e cinco tratamentos foram desenhados e comparados
sobre a planta real. O escolhido foi o **Sumida**: a cidade molhada vista de cima —
azul-petróleo profundo no chão e nas paredes, néon ciano e magenta na quina delas.

## Decisão

- **Toda superfície grande fica abaixo de 30% de luz.** Parede, piso, laje, calçada
  e terreno. Há asserção por superfície: uma parede clarinha entra sem ninguém notar
  e apaga o robô que passa na frente dela.
- **Quem emite é quem se lê.** A regra de valor inverteu: antes o fundo era claro e o
  robô era médio; agora o fundo é escuro e o robô é claro. O `selftest` afirma que a
  carcaça, no valor em que é desenhada (0,60), bate cada cor de fundo por pelo menos
  0,25 de luz.
- **Néon é luz, não tinta.** A fita da quina e do rodapé, a tela acesa e a fita da
  carcaça são `MeshBasicMaterial` — não dependem de lâmpada e não escurecem junto com
  a parede em que estão pregadas. Subir as luzes da cena para "clarear" só lava o azul
  e mata o contraste que faz o néon existir.
- **A galeria e o saguão são magenta; o resto é ciano.** A passagem para a entrada
  muda de cor, e é assim que ela se anuncia antes de o robô chegar lá.
- **Os móveis levam um respiro de emissão** do próprio matiz. No escuro, o Lambert
  puro devolvia vulto: o volume existia como massa preta e a cor só aparecia na face
  de cima.
- **O robô ganhou luz própria**: fita no peito, facho rente ao chão sob as esteiras,
  antena com luz de topo e visor quase preto com o traço aceso. O facho é o que cola
  o robô no piso — sem ele, com o chão escuro, ele parecia pairar um dedo acima.

## O preço, que era conhecido antes de escolher

Com o escritório azul, a faixa de **193° a 252°** virou fundo inteiro. Os matizes de
agente `214` (azul) e `334` (magenta) caíam dentro dela — dois robôs que sumiriam na
própria parede. A lista mudou de `[8, 84, 152, 214, 268, 334]` para
`[30, 78, 152, 262, 312, 350]`, mantendo os 24° entre agentes, os 20° do fundo e os
6° do vermelho de erro.

A comparação das cinco direções media esse custo antes da decisão: Sumida e Sintonia
derrubavam dois matizes cada, Nostromo um, Holograma nenhum.

## Consequências

Os rótulos sobre o canvas tiveram de inverter junto — eles eram escuros sobre piso
claro e sumiam por completo. A etiqueta de papel dos móveis virou etiqueta de vidro:
clara, ela era o ponto mais brilhante da tela e roubava o robô.

A interface 2D em volta não mudou: ela já era escura, e a moldura escura com cena
colorida continua sendo a leitura do projeto.
