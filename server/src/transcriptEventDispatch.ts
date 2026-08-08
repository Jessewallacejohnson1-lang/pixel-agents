/**
 * Generic transcript-event dispatch.
 *
 * Providers that implement `parseTranscriptLine` produce `AgentEvent`s from their
 * own log format; this applies one to an agent. It is the file-fallback twin of
 * `HookEventHandler`, for CLIs with no hooks API.
 *
 * The Claude path stays on `transcriptParser.processTranscriptLine`, which reads
 * things `AgentEvent` cannot express — context usage, team membership, /clear
 * detection, background-agent sidecars. Making that function generic would mean
 * rewriting it around a model that loses information, so the two coexist:
 * providers that need the richer treatment keep it, providers that don't get this.
 */

import type { AgentEvent, HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState } from './types.js';

function startTool(
  agentId: number,
  agent: AgentState,
  event: Extract<AgentEvent, { kind: 'toolStart' }>,
  provider: HookProvider,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const status = provider.formatToolStatus(event.toolName, event.input);

  agent.activeToolIds.add(event.toolId);
  agent.activeToolNames.set(event.toolId, event.toolName);
  agent.activeToolStatuses.set(event.toolId, status);

  cancelWaitingTimer(agentId, waitingTimers);
  agent.isWaiting = false;
  agent.permissionSent = false;
  agent.hadToolsInTurn = true;
  agent.lastDataAt = Date.now();

  agents.broadcast({
    type: 'agentToolStart',
    id: agentId,
    toolId: event.toolId,
    status,
    toolName: event.toolName,
  });
  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
}

function endTool(
  agentId: number,
  agent: AgentState,
  toolId: string,
  agents: AgentStateStore,
): void {
  // Guard on membership rather than broadcasting unconditionally: Codex ends an
  // apply_patch twice (patch_apply_end plus the tool-call output), and a second
  // agentToolDone for a tool the webview already dropped is noise.
  if (!agent.activeToolIds.has(toolId)) return;

  agent.activeToolIds.delete(toolId);
  agent.activeToolNames.delete(toolId);
  agent.activeToolStatuses.delete(toolId);
  agent.lastDataAt = Date.now();

  agents.broadcast({ type: 'agentToolDone', id: agentId, toolId });
}

function endTurn(
  agentId: number,
  agent: AgentState,
  awaitingInput: boolean,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  agent.activeToolIds.clear();
  agent.activeToolNames.clear();
  agent.activeToolStatuses.clear();

  // Always sent, even with nothing tracked: a permission bubble or sub-character
  // left over from the turn would otherwise never clear.
  agents.broadcast({ type: 'agentToolsClear', id: agentId });

  agent.isWaiting = true;
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;

  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting', awaitingInput });
}

/**
 * Apply one parsed transcript event to an agent.
 *
 * Events are treated as observations, not commands: an end for an unknown tool is
 * ignored rather than trusted, because chunked file reads can deliver records out
 * of order.
 */
export function applyTranscriptEvent(
  agentId: number,
  agent: AgentState,
  event: AgentEvent,
  provider: HookProvider,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  switch (event.kind) {
    case 'toolStart':
      return startTool(agentId, agent, event, provider, agents, waitingTimers);

    case 'toolEnd':
      return endTool(agentId, agent, event.toolId, agents);

    case 'turnEnd':
      return endTurn(
        agentId,
        agent,
        event.awaitingInput === true,
        agents,
        waitingTimers,
        permissionTimers,
      );

    case 'permissionRequest':
      if (agent.permissionSent) return;
      agent.permissionSent = true;
      agents.broadcast({ type: 'agentToolPermission', id: agentId });
      return;

    case 'subagentStart':
      agents.broadcast({
        type: 'subagentToolStart',
        id: agentId,
        parentToolId: event.parentToolId,
        toolId: event.toolId,
        status: provider.formatToolStatus(event.toolName, event.input),
      });
      return;

    case 'subagentEnd':
      agents.broadcast({
        type: 'subagentToolDone',
        id: agentId,
        parentToolId: event.parentToolId,
        toolId: event.toolId,
      });
      return;

    // sessionStart/sessionEnd are handled by adoption and the stale-agent check;
    // subagentTurnEnd and progress have no office-visible effect on this path.
    case 'sessionStart':
    case 'sessionEnd':
    case 'subagentTurnEnd':
    case 'progress':
      return;
  }
}
