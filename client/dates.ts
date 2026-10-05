export const DEFAULT_ZONE = 'Australia/Sydney';
export function parts(date: string | Date, zone = DEFAULT_ZONE) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));
  return Object.fromEntries(values.map((p) => [p.type, p.value]));
}
export function dayKey(date: string | Date, zone = DEFAULT_ZONE) {
  const p = parts(date, zone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(day: string, count: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function monday(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -(weekday === 0 ? 6 : weekday - 1));
}
export function fmt(date: string | Date, options: Intl.DateTimeFormatOptions, zone = DEFAULT_ZONE) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, ...options }).format(new Date(date));
}
export function dateLabel(day: string, options: Intl.DateTimeFormatOptions) {
  return fmt(`${day}T12:00:00Z`, options, 'UTC');
}
export function time(date: string, zone = DEFAULT_ZONE) {
  return fmt(date, { hour: 'numeric', minute: '2-digit' }, zone).toLowerCase();
}
export function minutes(date: string, zone = DEFAULT_ZONE) {
  const p = parts(date, zone);
  return Number(p.hour) * 60 + Number(p.minute);
}
export function duration(start: string, end: string) {
  return (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
}
export function hoursLabel(hours: number) {
  return `${Number(hours.toFixed(1))}h`;
}
export function inputDate(date: string, zone = DEFAULT_ZONE) {
  const p = parts(date, zone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function zonedIso(value: string, zone = DEFAULT_ZONE) {
  const desired = new Date(`${value}:00Z`).getTime();
  if (!Number.isFinite(desired)) throw new Error('Please enter a valid date and time.');
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(guess), zone);
    const observed = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`).getTime();
    guess += desired - observed;
  }
  if (inputDate(new Date(guess).toISOString(), zone) !== value)
    throw new Error(
      'This time falls in a daylight-saving clock change. Please choose another time.',
    );
  return new Date(guess).toISOString();
}
