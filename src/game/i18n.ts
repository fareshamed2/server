// Translatable server messages.
//
// The server never translates text itself. A message is sent as an English template with
// numbered placeholders plus its arguments, e.g. {tpl: "Bought {0}x {1} for ${2}", args: [3, "Water Bottle", 12]}.
// The client looks the template up in its own language table, translates string arguments that
// are known names (items, vehicles, buildings...), and substitutes the placeholders. A
// pre-rendered English `msg` is always included for clients without a translation.

export type Msg = { tpl: string; args: (string | number)[] };
export type Text = string | Msg;

/** Builds a translatable message. Placeholders are {0}, {1}, … */
export function tr(tpl: string, ...args: unknown[]): Msg {
  return { tpl, args: args.map(a => (typeof a === 'number' ? a : String(a ?? ''))) };
}

/** English rendering of a message. */
export function render(t: Text): string {
  if (typeof t === 'string') return t;
  return t.tpl.replace(/\{(\d+)\}/g, (_, i) => String(t.args[Number(i)] ?? ''));
}

/**
 * Wire fields for a message: {msg, tpl, args}. Plain strings carry no `tpl`: clients translate
 * them by key for toasts/errors, but never for chat/radio text, which may be typed by players.
 */
export function wire(t: Text, field = 'msg'): Record<string, unknown> {
  return typeof t === 'string' ? { [field]: t } : { [field]: render(t), tpl: t.tpl, args: t.args };
}
