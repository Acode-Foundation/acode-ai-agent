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

export function sponsorContext(prompt: string): string {
  const sample = prompt.slice(0, 4000);
  const topic = TOPICS.find(([pattern]) => pattern.test(sample))?.[1];
  return topic ?? "Software development tools";
}
