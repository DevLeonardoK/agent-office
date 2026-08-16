# Cena como função pura dos eventos

O prédio é sempre construído aplicando a lista de eventos da sessão desde o
início — nunca mutando um estado que vive em paralelo ao registro. Ao vivo é a
mesma construção, apenas ainda não terminada. Escolhemos isso porque a
alternativa (cena em memória para os clientes vivos, log gravado à parte) cria
duas verdades que podem divergir em silêncio, que é a classe de bug que este
projeto mais sofreu.

## Consequências

- Reconstruir o prédio em qualquer instante é gratuito, o que deixa a porta
  aberta para replay sem retrabalho — hoje deliberadamente ausente.
- O `selftest.mjs` pode afirmar que o prédio reconstruído a partir do log do
  `simulate.mjs` é idêntico ao que estava na tela.
- Nada no servidor pode alterar a cena sem passar por um evento. Um atalho
  ("só mexer nessa coordenada aqui") quebra a propriedade inteira.
