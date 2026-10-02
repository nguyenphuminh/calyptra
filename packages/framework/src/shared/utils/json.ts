/** Converts bigints to decimal strings so a value can be stored or sent as JSON. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}
