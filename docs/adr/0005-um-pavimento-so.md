# ADR-0005 — Um pavimento só: três salas e um saguão

**Estado**: aceito
**Revoga**: a parte do ADR-0002 que amarra um agente a um cômodo exclusivo, e o
prédio de andares que o ADR-0003 desenhou.

## Contexto

O escritório era um prédio que crescia: um térreo de serviço, cinco cômodos por
andar, e um andar novo a cada cinco agentes, ligado por uma escada em U dentro de
um poço. Três coisas saíram caras nesse desenho:

- **O poço da escada comia o piso.** Para o lance de um andar chegar ao de cima, a
  baia inteira precisava ser vazada em todo andar. Visto de cima — que é a única
  vista —, o andar de cima aparecia com metade do chão faltando. Duas tentativas de
  fechar aquilo falharam por geometria: com o escalonamento diagonal, o lance
  atravessa a baia inteira, e o recorte mínimo é a baia inteira.
- **A mobília piscava.** Ela era montada quando o cômodo ganhava ocupante e
  desmontada quando esvaziava. O efeito era um escritório que se esvaziava de
  móveis a cada saída — e sala sem móvel não lê como sala vazia, lê como sala não
  construída.
- **O prédio mudava de tamanho durante a sessão.** Cada andar novo remedia a caixa
  e o enquadramento saltava.

## Decisão

Um pavimento só, de planta fixa: **três salas** de trabalho lado a lado, um
**corredor** cruzando a frente delas e um **saguão** quadrado adiantado no meio,
por onde todo mundo entra e sai.

- **Dois postos por sala, seis no total** — um por matiz da paleta. O agente aloca
  um posto, não uma sala; duas pessoas dividem uma sala como num escritório de
  verdade. Acima de seis, o posto se repete com um passo de lado.
- **A mobília é da planta.** `fixedProps()` é função pura: mesma planta, mesma
  lista. O renderizador a monta uma vez junto com as paredes, e não existe mais
  comando de montar ou desmontar móvel. Usar uma ferramenta só **acende** o que já
  está lá.
- **Quadro e arquivo morto viraram mobília de sala**; terminal e biblioteca
  continuam estações, e por isso moram no saguão. Atravessar o escritório para
  riscar um quadro era caminhada à toa.
- **`wy` é constante.** Sem andares não há escada, poço, patamar, faixa de lance
  nem escalonamento diagonal — e some junto a classe inteira de bug em que o robô
  parecia andar no ar.

## Consequências

O `scene.mjs` encolheu: saíram `stairSteps`, `stairWell`, `stairLanding`,
`stairMid`, `stairDoor`, `stairLaneOffset`, `platformOrigin`, `plateOf`,
`floorCount`, `levelY`, `furnishRoom`, `unfurnishRoom` e `ensureStation`. O
enquadramento virou constante. O `selftest` trocou as asserções de escada e de
andar por asserções de planta: nenhuma perna de caminhada sai do piso, nenhuma
atravessa uma divisória, e todo móvel assenta dentro do espaço dele.

O preço aceito: **o escritório tem um teto de seis lugares**. Uma sessão com mais
agentes empilha postos em vez de crescer. Em troca, a planta é sempre a mesma — e
uma planta que não muda é uma planta que se aprende.
