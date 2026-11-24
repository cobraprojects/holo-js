export function findOwnEntry<TEntry>(entries: Readonly<Record<string, TEntry>>, name: string): TEntry | undefined {
  return Object.hasOwn(entries, name) ? entries[name] : undefined
}
