export const EXPIRY_OPTIONS = [
  { label: 'Never', value: 'never' },
  { label: '1 day', value: '1' },
  { label: '7 days', value: '7' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '1 year', value: '365' },
  { label: 'Specific date', value: 'custom' },
] as const;
export function localDateInput(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function expiryPayload(mode: string, date: string, time: string, now = Date.now()) {
  if (mode === 'never') return { expiresInDays: null };
  if (mode !== 'custom') return { expiresInDays: Number(mode) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Choose an expiry date and time.');
  const selected = new Date(`${date}T${time}:00`);
  if (!Number.isFinite(selected.getTime()) || localDateInput(selected) !== date || `${String(selected.getHours()).padStart(2,'0')}:${String(selected.getMinutes()).padStart(2,'0')}` !== time) throw new Error('Choose a valid date and local time.');
  if (selected.getTime() <= now) throw new Error('Choose an expiry in the future.');
  if (selected.getTime() > now + 3650 * 86_400_000) throw new Error('Choose an expiry within 10 years.');
  return { expiresAt: selected.toISOString() };
}
