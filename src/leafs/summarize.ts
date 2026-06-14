import Anthropic from '@anthropic-ai/sdk';

/**
 * Leaf capability: turn provided data into a short plain-English brief.
 *
 * Uses Claude Haiku (cheapest) — ~$0.005/run. This is the ONLY part of the slice that
 * spends LLM tokens. `requirementsJson` is the JSON Axion sends:
 * `{ goal, inputs }` where `inputs` is the stage-1 deliverables (e.g. the ETH price).
 */
export async function summarize(requirementsJson: string): Promise<string> {
  let goal = '';
  let inputs = '';
  try {
    const r = JSON.parse(requirementsJson) as { goal?: string; inputs?: string };
    goal = r.goal ?? '';
    inputs = r.inputs ?? '';
  } catch {
    inputs = requirementsJson; // tolerate a plain-text requirement
  }

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    system:
      'You write concise, plain-English market briefs. 2-4 sentences, no preamble, no markdown headers. Only use the data provided; do not invent numbers.',
    messages: [
      {
        role: 'user',
        content: `Goal: ${goal}\n\nData:\n${inputs}\n\nWrite a short plain-English brief.`,
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || '(summarizer returned no text)';
}
