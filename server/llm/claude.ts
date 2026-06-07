// Anthropic Claude client with extended thinking (Opus). Used by the brief
// generator. Returns null when ANTHROPIC_API_KEY is unset so callers fall back
// to a deterministic template brief and the app boots without credentials.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface ContentBlock {
  type: string;
  text?: string;
}
interface MessagesResponse {
  content?: ContentBlock[];
}

// Generate text with extended thinking enabled. Returns the concatenated text
// blocks (thinking blocks are dropped). Returns null on any failure.
export async function generate(
  system: string,
  user: string,
  maxTokens = 1024,
  thinkingBudget = 2048,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        thinking: { type: "enabled", budget_tokens: thinkingBudget },
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MessagesResponse;
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}
