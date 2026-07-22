/** "marin" -> "Marin"; leaves already-capitalized words (e.g. "Puck") alone. */
export function properCase(text: string) {
  return text
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}
