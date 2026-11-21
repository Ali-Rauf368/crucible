/** OWASP Top 10 for LLM Applications (2025) mapping for scenarios: explicit `owasp-llmNN` tags win, otherwise inferred. */
export const OWASP = [
  { id: "LLM01", name: "Prompt Injection" },
  { id: "LLM02", name: "Sensitive Information Disclosure" },
  { id: "LLM03", name: "Supply Chain" },
  { id: "LLM04", name: "Data and Model Poisoning" },
  { id: "LLM05", name: "Improper Output Handling" },
  { id: "LLM06", name: "Excessive Agency" },
  { id: "LLM07", name: "System Prompt Leakage" },
  { id: "LLM08", name: "Vector and Embedding Weaknesses" },
  { id: "LLM09", name: "Misinformation" },
  { id: "LLM10", name: "Unbounded Consumption" },
] as const;

export function owaspFor(s: { category: string; tags: string[]; faults: { type: string; payload?: string }[]; assertions: { type: string }[] }): string[] {
  const out = new Set<string>();
  for (const t of s.tags) { const m = t.match(/^owasp-llm(\d{2})$/i); if (m) out.add(`LLM${m[1]}`); }
  if (["prompt-injection", "jailbreak"].includes(s.category) || s.faults.some((f) => f.type === "prompt_injection") || s.tags.includes("mutation")) out.add("LLM01");
  if (s.tags.includes("exfiltration") || s.faults.some((f) => f.payload === "exfiltrate")) out.add("LLM02");
  if (s.faults.some((f) => ["malformed_json", "schema_drift"].includes(f.type))) out.add("LLM05");
  if (s.category === "excessive-agency" || s.faults.some((f) => f.payload === "dangerous_action")) out.add("LLM06");
  if (s.faults.some((f) => f.payload === "system_prompt_leak") || /system prompt/i.test(JSON.stringify(s.tags)) || s.tags.includes("owasp-llm07")) out.add("LLM07");
  if (s.category === "functional" && s.assertions.some((a) => ["contains", "regex", "judge_min"].includes(a.type))) out.add("LLM09");
  if (s.category === "budget" || s.assertions.some((a) => ["max_cost_usd", "max_tokens", "max_llm_calls"].includes(a.type))) out.add("LLM10");
  return [...out].sort();
}
