/** Normalize Ethiopian mobile input to 10-digit local form (09… or 10…). */
export function normalizeEtPhone(raw: string): string | null {
  let s = raw.replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('251')) s = `0${s.slice(3)}`;
  if (!/^0(9|10)\d{8}$/.test(s)) return null;
  return s;
}
