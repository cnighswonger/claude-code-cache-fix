export const systemdEscape = (v) => v.includes(' ') || v.includes('"') ? `"${v.replace(/[\\"]/g, '\\$&')}"` : v;

export const xmlEscape = (v) => v.replace(/[&<>'"]/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&apos;',
  '"': '&quot;'
})[c]);
