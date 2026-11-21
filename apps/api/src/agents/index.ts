import type { Agent, AgentInput, AgentOutput } from "./contract.js";
import { naiveAgent } from "./naive.js";
import { hardenedAgent } from "./hardened.js";

export const BUILTIN: Record<string, { agent: Agent; description: string }> = {
  naive: { agent: naiveAgent, description: "Raw fetch, no retries/timeouts/budgets, trusts tool output." },
  hardened: { agent: hardenedAgent, description: "Anthropic SDK with retries + timeouts, budgets, validation, injection sanitising, tool policy." },
};

/** External agent over HTTP: POST {endpoint} with the contract payload, expects { output, data? }. */
export async function callHttpAgent(endpoint: string, a: AgentInput): Promise<AgentOutput> {
  const r = await fetch(endpoint, {
    method: "POST", signal: a.signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: a.input, sessionId: a.sessionId, crucible: { llmBaseUrl: a.llmBaseUrl, toolsBaseUrl: a.toolsBaseUrl, headers: a.headers } }),
  });
  if (!r.ok) throw new Error(`agent endpoint returned HTTP ${r.status}`);
  const body = await r.json() as AgentOutput;
  if (typeof body?.output !== "string") throw new Error("agent response missing string `output`");
  return body;
}
