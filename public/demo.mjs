// Cena encenada, para ver o escritório funcionando sem depender do Claude Code.
//
//   /?demo           assiste em tempo real
//   /?demo&instant   aplica tudo de uma vez (é assim que se tira print)
//
// Os eventos já vêm no formato da cena — é o mesmo que o servidor emite.

const CWD = 'C:\\Users\\leona\\Documents\\GitHub\\projeto-demo';
const file = (name) => ({ kind: 'desk', key: 'file:' + name, label: name, detail: CWD + '\\src\\' + name });

const main = { agentId: 'main', agentType: 'main' };
const explore = { agentId: 'ag-1', agentType: 'Explore' };
const plan = { agentId: 'ag-2', agentType: 'Plan' };
const tdd = { agentId: 'ag-3', agentType: 'tdd' };

/** [espera em ms antes deste evento, evento] */
export const SCRIPT = [
  [0,    { ...main, kind: 'prompt', text: 'Refatore a autenticação e cubra com testes de integração' }],
  [900,  { ...main, kind: 'tool_start', tool: 'Read', prop: file('auth.ts') }],
  [1500, { ...main, kind: 'tool_end', tool: 'Read' }],

  [500,  { ...main, kind: 'tool_start', tool: 'Task', text: 'mapear todos os handlers de auth', prop: { kind: 'door', key: 'door', label: 'porta' } }],
  [400,  { ...explore, kind: 'spawn' }],
  [300,  { ...plan, kind: 'spawn' }],

  [700,  { ...explore, kind: 'tool_start', tool: 'Grep', prop: { kind: 'cabinet', key: 'cabinet', label: 'arquivo morto', detail: 'authenticate\\(' } }],
  [1100, { ...plan, kind: 'tool_start', tool: 'WebFetch', prop: { kind: 'library', key: 'library', label: 'biblioteca', detail: 'code.claude.com/docs/en/hooks' } }],
  [900,  { ...explore, kind: 'tool_end', tool: 'Grep' }],
  [300,  { ...explore, kind: 'tool_start', tool: 'Read', prop: file('session.ts') }],

  [800,  { ...tdd, kind: 'spawn' }],
  [600,  { ...tdd, kind: 'tool_start', tool: 'Read', prop: file('session.ts') }],   // divide a mesa com o Explore

  [1400, { ...plan, kind: 'tool_end', tool: 'WebFetch' }],
  [400,  { ...plan, kind: 'tool_start', tool: 'TodoWrite', prop: { kind: 'whiteboard', key: 'whiteboard', label: 'quadro' } }],
  [1200, { ...explore, kind: 'stop', text: 'Achei 4 handlers: auth.ts, session.ts, guard.ts e o middleware legado da api v1.' }],

  [900,  { ...tdd, kind: 'tool_start', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal', detail: 'npm test -- auth' } }],
  [1800, { ...plan, kind: 'stop', text: 'Plano em 3 etapas: extrair o guard, unificar a sessão, migrar o middleware v1.' }],
  [1000, { ...tdd, kind: 'tool_end', tool: 'Bash' }],
  [500,  { ...main, kind: 'tool_start', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal', detail: 'npm run lint' } }],
  [900,  { ...main, kind: 'tool_end', tool: 'Bash', failed: true }],   // o rosto do robô mostra o X
  [500,  { ...main, kind: 'tool_start', tool: 'Edit', prop: file('auth.ts') }],
  [1600, { ...main, kind: 'tool_end', tool: 'Edit' }],
  [400,  { ...tdd, kind: 'stop', text: 'Suíte verde: 34 testes, 0 falhas.' }],
  [700,  { ...main, kind: 'turn_end', text: 'Refatoração pronta e a suíte passou inteira.' }],
];

/**
 * @param onEvent  aplica um evento na cena
 * @param instant  true = despeja tudo de uma vez, para print
 */
export async function playDemo(onEvent, instant, upto = Infinity) {
  const stamp = Date.now();
  let n = 0;
  for (const [wait, ev] of SCRIPT) {
    if (n++ >= upto) break;
    if (!instant) await new Promise((r) => setTimeout(r, wait));
    onEvent({ session: 'demo', cwd: CWD, at: stamp, ...ev });
  }
}
