# Escritório dos Agentes

A atividade de uma sessão do Claude Code desenhada como um escritório: os
agentes são robôs que ocupam cômodos, e as ferramentas que eles usam são o
mobiliário. O vocabulário abaixo é o que o código, os commits e as issues devem
usar.

## O prédio

**Prédio**:
A representação completa de uma sessão. Um prédio por sessão, sem ligação entre
prédios.
_Avoid_: escritório (é o projeto todo, não uma sessão), planta

**Andar**:
Uma divisão vertical do prédio, com capacidade para cinco agentes. Nasce quando
o andar anterior enche e é demolido quando fica vazio.
_Avoid_: piso, nível, camada

**Térreo de serviço**:
O andar fixo, sempre presente, onde ficam as estações. O único andar que não
emerge da sessão e o único que não conta agentes.
_Avoid_: térreo (ambíguo com o 1º andar), lobby, salão

**Cômodo**:
O lugar de exatamente um agente dentro de um andar, com os móveis que esse
agente usou. Cinco por andar. É esvaziado quando muda de ocupante.
_Avoid_: sala, baia, estação (é outra coisa), escritório

## Quem trabalha

**Robô**:
A representação de um agente na planta: carcaça colorida com plaqueta de
identificação, esteiras e tela-rosto. A carcaça carrega o matiz do agente.
_Avoid_: boneco, personagem, avatar, sprite

**Agente**:
Uma linha de execução do Claude Code, identificada por `agent_id`. O agente
principal é o que não traz `agent_id` no evento; os demais são subagents.
_Avoid_: worker, thread, ator

## Onde se trabalha

**Móvel**:
A representação de um recurso que um agente tocou — um arquivo, um comando, uma
busca. Mora dentro do cômodo de quem o usou e não existe fora dele.
_Avoid_: prop (é o nome no código, não no domínio), objeto, item

**Estação**:
Um móvel de recurso singular — terminal, biblioteca, quadro, arquivo morto.
Existe um só de cada no prédio inteiro, sempre no térreo de serviço, e o agente
desce até ele. É o que distingue estação de móvel: móvel é do cômodo, estação é
do prédio.
_Avoid_: móvel fixo, recurso compartilhado

## O que se lê

**Registro**:
A lista textual do que aconteceu na sessão, em ordem. É a única memória do
passado — a planta mostra estritamente o agora.
_Avoid_: log (é o arquivo em disco), histórico, timeline, feed

**Evento**:
A tradução de um hook do Claude Code para o que o prédio sabe desenhar. A cena
é função pura da lista de eventos.
_Avoid_: hook (é o que chega do Claude Code, antes da tradução), mensagem

**Sessão**:
Uma execução do Claude Code, identificada por `session_id`. Nasce no
`SessionStart`, morre no `SessionEnd` ou após trinta minutos de silêncio, e
ressuscita se voltar a mandar eventos.
_Avoid_: run, conversa, instância
