# Um agente por cômodo, cinco cômodos por andar

O prédio não tem planta predefinida acima do térreo de serviço: cada agente vivo
ocupa um cômodo só dele, e cinco cômodos formam um andar. Escolhemos capacidade
um por cômodo — em vez de salas compartilhadas — porque os móveis moram dentro
do cômodo de quem os usa, e dois agentes na mesma sala tornam impossível ler de
quem é qual mesa. Com um dono por cômodo, a plaqueta da porta pode ser o
`agent_type`, que é a informação que se quer ler de longe.

## Consequências

- A planta mostra estritamente o agora: vaga de agente que termina é reciclada,
  o cômodo é esvaziado antes do novo ocupante entrar, e andar vazio é demolido.
  O passado da sessão vive só no registro.
- Nenhuma posição na tela é estável. O `selftest.mjs` afirma invariantes de
  layout (nenhuma sobreposição, cômodo dentro do andar, cômodo fixo do principal
  intacto), não coordenadas.
- O agente principal é a única exceção: cômodo fixo no 1º andar, nunca
  reciclado, para o olho ter um ponto de retorno num prédio que se rearranja.

## A cor, que esta decisão revoga

A invariante anterior dizia que o agente principal não usa matiz nenhuma — é
creme, e essa é a única distinção dele. Ela cai. Os agentes agora são robôs de
carcaça colorida, e a carcaça *é* o matiz: os subagents recebem os cinco matizes
da paleta e o principal recebe um gradiente arco-íris. Rainbow não compete com
os cinco porque não é um sexto matiz — é a ausência de escolha entre eles.
