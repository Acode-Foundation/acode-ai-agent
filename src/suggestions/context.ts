// Only these fixed labels can leave the device. Never return substrings of a prompt.
const TOPICS: Array<[RegExp, string]> = [
  [/\b(hosting|deploy|server|cloud|docker)\b/i, "Cloud hosting and deployment"],
  [/\b(database|sql|postgres|sqlite|mongodb)\b/i, "Databases and data storage"],
  [/\b(test|tests|testing|debug(?:ging)?|bugs?|errors?)\b/i, "Software testing and debugging"],
  [/\b(website|frontend|react|vue|html|css)\b/i, "Web development"],
  [/\b(android|ios|flutter|mobile|swift)\b/i, "Mobile app development"],
  [/\b(api|backend|endpoint|authentication)\b/i, "Backend development"],
  [/\b(learn(?:ing)?|tutorial|explain|beginner)\b/i, "Learning programming"],
];

export function sponsorContext(prompt: string, previousPrompts: readonly string[] = []): string[] {
  const topics = new Set<string>();
  // Favor the current task, then the four most recent prompts in this chat.
  for (const text of [prompt, ...previousPrompts.slice(-4).reverse()]) {
    const sample = text.slice(0, 4000);
    for (const [pattern, label] of TOPICS) {
      if (pattern.test(sample)) topics.add(label);
      if (topics.size === 3) return [...topics];
    }
  }
  return topics.size ? [...topics] : ["Software development tools"];
}
