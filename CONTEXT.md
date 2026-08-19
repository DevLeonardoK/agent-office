# Escritório dos Agentes

A atividade de uma sessão do Claude Code desenhada como um escritório: os
agentes são robôs que ocupam postos de trabalho, e as ferramentas que eles usam
acendem a mobília das salas. O vocabulário abaixo é o que o código, os commits e as issues devem
usar.

## O escritório

**Escritório**:
A representação completa de uma sessão: um pavimento com três salas, um corredor
e um saguão. Um escritório por sessão, sem ligação entre escritórios.
_Avoid_: prédio (não há mais andares), planta (é o desenho, não o lugar)

**Sala**:
Um dos três cômodos de trabalho, com dois postos e mobília própria. A sala existe
sempre — mobiliada e nomeada —, com ou sem ocupante.
_Avoid_: cômodo, andar, baia

**Posto**:
O lugar de exatamente um agente dentro de uma sala: a mesa dele e o chão à frente
dela. Dois por sala, seis no escritório. É o posto que se aloca e se recicla, não
a sala.
_Avoid_: cadeira, vaga, slot (é o nome no código)

**Saguão**:
A sala menor e quadrada, afastada à frente e ligada ao corredor pela galeria. É por
onde todo agente entra e sai, e é onde ficam as estações. Tem piso de cor própria e
néon próprio — são eles que o identificam, não um rótulo.
_Avoid_: lobby, recepção, hall, térreo

**Corredor**:
A faixa à frente das três salas. Todo trajeto passa por ele: é o que faz o robô
contornar em vez de atravessar a sala dos outros.
_Avoid_: passagem, hall, lane (é o nome no código)

**Galeria**:
A passagem estreita que desce do corredor até o saguão. É ela que separa o saguão da
fita das salas e, ao mesmo tempo, o liga a elas.
_Avoid_: corredor (é o outro), túnel, neck (é o nome no código)

**Planta**:
A vista da cena: o escritório inteiro enquadrado, de cima e de lado. Uma só, e de
tamanho constante — o escritório não cresce durante a sessão.
_Avoid_: vista empilhada (era o prédio de andares), mapa, corte

**Ladrilho**:
A unidade do mundo 3D. Posição de agente e de móvel se pensa em ladrilhos; pixel
é coisa do renderizador. O piso é liso: o ladrilho é medida, não desenho.
_Avoid_: célula, tile, quadrado

## Quem trabalha

**Robô**:
A representação de um agente na planta: carcaça colorida com plaqueta de
identificação, esteiras e tela-rosto. A carcaça carrega o matiz do agente.
São seis matizes e seis postos — um por lugar no escritório.
_Avoid_: boneco, personagem, avatar, sprite

**Agente**:
Uma linha de execução do Claude Code, identificada por `agent_id`. O agente
principal é o que não traz `agent_id` no evento; os demais são subagents.
_Avoid_: worker, thread, ator

**Apelido**:
O nome do agente na tela, tirado da descrição da tarefa que o convocou — duas
palavras de conteúdo. É ele que aparece na plaqueta, no elenco e no registro; o
`agent_type` fica de legenda.
_Avoid_: tipo (é a legenda), label, título

**Carta**:
A ficha do agente, aberta ao clicar nele: retrato, apelido, tipo, estado, o que faz
agora e a última fala. A planta diz onde ele está; a carta diz quem ele é. Fica
**fixa no canto do palco** — presa ao robô, ela escorregava enquanto se lia.
_Avoid_: popup, modal, tooltip

## Onde se trabalha

**Móvel**:
Um volume da mobília — mesa, estante, arquivo morto, quadro. É do **escritório**,
não do agente e não do evento: nasce com a planta e nunca é desmontado. Usar uma
ferramenta **acende** o móvel que já está lá.
_Avoid_: prop (é o nome no código, não no domínio), objeto, item

**Pegada**:
A planta baixa de um móvel: o retângulo que ele ocupa no chão, com a folga do corpo
do robô. É o que o trajeto contorna — o robô **sabe onde a mobília está** e não passa
por dentro dela.
_Avoid_: colisão, hitbox, bounding box

**Estação**:
Um móvel de recurso singular — terminal e biblioteca. Existe um só de cada no
escritório inteiro, no saguão, e o agente sai da sala para usá-lo. É o que
distingue estação de móvel de sala: a estação é de todos.
_Avoid_: móvel fixo, recurso compartilhado

## O que se lê

**Registro**:
A lista textual do que aconteceu na sessão, em ordem. É a única memória do
passado — a planta mostra estritamente o agora.
_Avoid_: log (é o arquivo em disco), histórico, timeline, feed

**Evento**:
A tradução de um hook do Claude Code para o que o escritório sabe desenhar. A cena
é função pura da lista de eventos.
_Avoid_: hook (é o que chega do Claude Code, antes da tradução), mensagem

**Sessão**:
Uma execução do Claude Code, identificada por `session_id`. Nasce no
`SessionStart`, morre no `SessionEnd` ou após trinta minutos de silêncio, e
ressuscita se voltar a mandar eventos.
_Avoid_: run, conversa, instância
