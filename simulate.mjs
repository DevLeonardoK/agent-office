#!/usr/bin/env node
// Encena uma sessão fictícia no escritório, alimentando o hook.mjs com
// payloads iguais aos que o Claude Code manda. Serve para conferir o visual
// sem precisar disparar subagents de verdade.
//
//   node simulate.mjs

const PORT = Number(process.env.AGENT_OFFICE_PORT || 4517);
const SESSION = 'sim-' + process.pid;
const CWD = 'C:\\Users\\leona\\Documents\\GitHub\\projeto-demo';

// Fala com o servidor exatamente como o Claude Code fala: POST do payload cru.
async function fire(payload) {
  await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SESSION, cwd: CWD, ...payload }),
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const pre = (tool, input, agent) => ({
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
  tool_use_id: 'toolu_' + Math.random().toString(36).slice(2), ...agent,
});
const post = (tool, agent) => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_response: 'ok', ...agent });

const explore = { agent_id: 'ag-explore-1', agent_type: 'Explore' };
const plan = { agent_id: 'ag-plan-1', agent_type: 'Plan' };

const script = [
  [0, { hook_event_name: 'SessionStart', how_session_started: 'startup' }],
  [400, { hook_event_name: 'UserPromptSubmit', user_input: 'Refatore a autenticação e cubra com testes' }],

  [1200, pre('Read', { file_path: CWD + '\\src\\auth.ts' })],
  [1800, post('Read')],

  [700, pre('Task', { subagent_type: 'Explore', description: 'mapear handlers', prompt: 'Ache todos os handlers de auth' })],
  [400, { hook_event_name: 'SubagentStart', ...explore }],

  [900, pre('Grep', { pattern: 'authenticate\\(' }, explore)],
  [1400, post('Grep', explore)],
  [600, pre('Read', { file_path: CWD + '\\src\\middleware\\session.ts' }, explore)],

  [500, pre('Task', { subagent_type: 'Plan', description: 'desenhar migração', prompt: 'Planeje a migração' })],
  [300, { hook_event_name: 'SubagentStart', ...plan }],

  [800, post('Read', explore)],
  [500, pre('WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }, plan)],

  [900, { hook_event_name: 'SubagentStop', ...explore, last_assistant_message: 'Achei 4 handlers: auth.ts, session.ts, guard.ts e o middleware legado em api/v1.' }],
  [1500, post('WebFetch', plan)],

  [400, pre('Bash', { command: 'npm test', description: 'rodar a suíte de testes' }, plan)],
  [2200, post('Bash', plan)],

  [600, { hook_event_name: 'SubagentStop', ...plan, last_assistant_message: 'Plano em 3 etapas: extrair o guard, unificar a sessão, migrar o middleware v1.' }],

  [900, pre('Edit', { file_path: CWD + '\\src\\auth.ts' })],
  [1600, post('Edit')],
  [500, { hook_event_name: 'Stop', last_assistant_message: 'Refatoração pronta e a suíte passou inteira.' }],
];

console.log(`Encenando a sessão ${SESSION} — abra http://127.0.0.1:4517\n`);
for (const [delay, payload] of script) {
  await wait(delay);
  const who = payload.agent_type || 'principal';
  console.log(`  ${String(who).padEnd(10)} ${payload.hook_event_name}${payload.tool_name ? ' ' + payload.tool_name : ''}`);
  await fire(payload);
}
console.log('\nFim da encenação.');
