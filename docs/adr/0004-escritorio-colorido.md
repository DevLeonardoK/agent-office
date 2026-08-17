# Escritório colorido: o olho acha o agente por valor e silhueta

O prédio deixa de ser azul de prancheta dessaturado e passa a ser colorido —
paredes amarelas, piso claro em xadrez, mobília com cor por tipo, terreno verde,
no espírito da referência em `media-agents/escriotorio1.png`.

Isto **revoga** a invariante que estava no `CLAUDE.md` desde o começo:

> *Desenho frio, gente quente.* O prédio inteiro é azul de prancheta dessaturado;
> os agentes são a única coisa saturada da tela.

## Por que ela existia, e o que a substitui

A regra não era gosto: era um atalho de leitura. Com o prédio dessaturado, achar os
agentes custava zero — eles eram a única coisa colorida. Um escritório colorido
perde esse atalho, e sem substituto a cena viraria um mural onde nada salta.

O substituto tem três partes, e todas valem ao mesmo tempo:

**Valor.** O prédio é claro e pouco saturado (parede em L 0,62; piso em 0,86 e
0,72). A carcaça dos robôs é o oposto: saturada e de valor médio, o que a destaca
contra parede e piso claros. Nenhum robô compete com o fundo por brilho.

**Matiz com distância mínima.** Os seis matizes de agente ficam a pelo menos 24° um
do outro **e** a pelo menos 20° de qualquer cor de fundo do prédio. Foi o que
empurrou o âmbar 38 para o laranja 24 (a parede é amarela, 44) e o limão 90 para 96
(o terreno é verde, 120). Isto não é comentário: está afirmado no `selftest.mjs`, e
quem pintar uma parede da cor de um robô reprova o teste.

**Silhueta.** O robô é a única forma alta e arredondada num mundo de caixas e
planos, e é o único objeto com rosto aceso. Some-se a plaqueta do cômodo, que
aponta para ele de cima.

## A paleta vive num módulo puro

`public/palette.mjs`, sem DOM e sem `three`. O renderizador lê de lá, a interface
2D lê de lá, e o `selftest.mjs` exercita as distâncias em Node. Cor passou a ser
regra do projeto, não escolha local de quem desenha um móvel.

## Consequências

- **A interface 2D continua sóbria.** Trilhos, registro e elenco seguem escuros: o
  contraste entre a moldura escura e a cena colorida é o que faz o escritório ler
  como diorama, e é o que impede o texto de competir com o prédio. Meio a meio —
  parte colorida, parte não — seria pior que qualquer um dos dois.
- **A luz subiu.** Com o prédio claro, a luz de antes (feita para o azul escuro)
  achatava tudo; ambiente e hemisférica ficaram mais fortes, e a direcional mais
  suave, para as faces se distinguirem sem estourar.
- **O rosto de erro segue vermelho** e a paleta de agente mantém distância dele: um
  robô parado não pode parecer um robô com falha.
- **O fundo do palco** ficou num azul-esverdeado mais claro que antes, para o
  diorama assentar em algo. Continua escuro o bastante para os trilhos não sumirem.
