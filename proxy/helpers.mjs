// Escape a value for safe rendering into a systemd `Environment=KEY=VALUE` line.
//
// Per systemd.exec(5) Environment= and systemd.unit(5) Specifier Expansion:
//   - Literal `%` is the specifier-expansion marker; to embed one in a value
//     the unit file must write `%%`. Without escaping, `a%20b` is parsed as
//     a failed `%20` specifier expansion, systemd logs "Invalid slot" and
//     silently drops the variable (empirically reproduced 2026-06-07).
//   - Backslash is a C-string escape inside quoted strings AND inside the
//     Environment= value parser; `\b` becomes byte 0x08 (backspace), `\n`
//     becomes LF, etc. To embed a literal `\` the unit must write `\\`.
//   - `"` requires `\"` (after the backslash escape rule above).
//   - Whitespace requires the whole value to be quoted (`"..."`).
//
// Order matters: escape `%` first (it produces `%%`, neither of which we
// want to re-escape later), then handle `\` and `"` together inside the
// quoting branch.
export const systemdEscape = (v) => {
  const percentEscaped = v.replace(/%/g, '%%');
  const needsQuoting = /[\s"\\]/.test(v);
  if (!needsQuoting) return percentEscaped;
  return `"${percentEscaped.replace(/[\\"]/g, '\\$&')}"`;
};

export const xmlEscape = (v) => v.replace(/[&<>'"]/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&apos;',
  '"': '&quot;'
})[c]);
