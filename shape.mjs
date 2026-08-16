// Traduz o payload cru de um hook do Claude Code no evento que o escritório
// sabe desenhar. Mora aqui porque tanto o servidor quanto o simulador usam.

const MAX_TEXT = 400;

export function clip(v, n = MAX_TEXT) {
  if (v == null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// O que o robô está fazendo determina em qual móvel ele vai encostar.
// A chave é estável, então dois agentes lendo o mesmo arquivo disputam a
// mesma mesa em vez de cada um ganhar a sua.
export function propFor(tool, input = {}) {
  const path = input.file_path || input.notebook_path;
  const base = path ? String(path).split(/[\\/]/).pop() : null;

  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'desk', key: 'file:' + (path || '?'), label: base || 'arquivo', detail: path };
    case 'Bash':
    case 'PowerShell':
      return { kind: 'terminal', key: 'terminal', label: 'terminal', detail: clip(input.description || input.command, 120) };
    case 'Grep':
    case 'Glob':
      return { kind: 'cabinet', key: 'cabinet', label: 'arquivo morto', detail: clip(input.pattern, 80) };
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'library', key: 'library', label: 'biblioteca', detail: clip(input.url || input.query, 120) };
    case 'Task':
    case 'Agent':
      return { kind: 'door', key: 'door', label: 'porta', detail: clip(input.description, 80) };
    case 'Skill':
      return { kind: 'shelf', key: 'shelf', label: 'manuais', detail: clip(input.skill, 80) };
    case 'TodoWrite':
      return { kind: 'whiteboard', key: 'whiteboard', label: 'quadro', detail: undefined };
    case 'Workflow':
      return { kind: 'whiteboard', key: 'whiteboard', label: 'quadro', detail: clip(input.name, 80) };
    default:
      return { kind: 'desk', key: 'tool:' + tool, label: tool, detail: undefined };
  }
}

/** @returns o evento do escritório, ou null se o hook não interessa à cena. */
export function shape(h) {
  if (!h || !h.hook_event_name) return null;

  const ev = {
    at: Date.now(),
    session: h.session_id || 'desconhecida',
    cwd: h.cwd,
    // Sem agent_id significa que quem agiu foi o agente principal.
    agentId: h.agent_id || 'main',
    agentType: h.agent_type || 'main',
    event: h.hook_event_name,
  };

  switch (h.hook_event_name) {
    case 'SubagentStart':
      ev.kind = 'spawn';
      // Quem gerou o filho, quando o hook diz — a cena usa isso para fazê-lo
      // sair da porta do pai. Sem o campo, a cena recorre a quem convocou por último.
      ev.parentId = h.parent_agent_id || h.parent_id || undefined;
      break;

    case 'SubagentStop':
      ev.kind = 'stop';
      ev.text = clip(h.last_assistant_message);
      break;

    case 'PreToolUse': {
      ev.kind = 'tool_start';
      ev.tool = h.tool_name;
      ev.toolUseId = h.tool_use_id;
      ev.prop = propFor(h.tool_name, h.tool_input || {});
      // O prompt de um Task é o que o pai "fala" ao despachar o filho.
      if (h.tool_name === 'Task' || h.tool_name === 'Agent') {
        ev.text = clip(h.tool_input?.description || h.tool_input?.prompt, 200);
        ev.spawnType = h.tool_input?.subagent_type || 'claude';
      }
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      ev.kind = 'tool_end';
      ev.tool = h.tool_name;
      ev.toolUseId = h.tool_use_id;
      ev.failed = h.hook_event_name === 'PostToolUseFailure';
      break;

    case 'UserPromptSubmit':
      ev.kind = 'prompt';
      ev.text = clip(h.user_input, 200);
      break;

    case 'Stop':
      ev.kind = 'turn_end';
      ev.text = clip(h.last_assistant_message, 200);
      break;

    case 'SessionStart':
      ev.kind = 'session_start';
      break;

    case 'SessionEnd':
      ev.kind = 'session_end';
      break;

    case 'Notification':
      ev.kind = 'notify';
      ev.text = clip(h.message, 200);
      break;

    default:
      return null;
  }

  return ev;
}
