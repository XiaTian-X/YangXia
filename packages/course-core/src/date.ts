// 纯日历日计算（YYYY-MM-DD，基于 UTC 免疫夏令时与进程时区差异）与按 IANA 时区格式化。
// 所有业务模块共享此工具：不直接用 new Date("YYYY-MM-DDT00:00:00")，也不在未指定时区时混比 UTC 毫秒与本地 0 点。
export const DAY_MS = 86_400_000;
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验是否为合法的 IANA 时区名（如 Asia/Shanghai、UTC、America/New_York）。 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 选出有效时区：显式参数优先于档案中的 timezone；都没写或无效时回退 undefined（进程本地时区）。 */
export function resolveTimeZone(explicit?: string, profile?: { timezone?: unknown } | null): string | undefined {
  if (explicit && isValidTimeZone(explicit)) return explicit;
  if (profile && isValidTimeZone(profile.timezone)) return profile.timezone;
  return undefined;
}

/** YYYY-MM-DD → 相对 1970-01-01 的整数日历天数（纯 UTC，与进程时区和夏令时无关）。 */
export function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 两个 YYYY-MM-DD 之间相差的整数天（a - b）。 */
export function daysBetween(a: string, b: string): number {
  return dayNumber(a) - dayNumber(b);
}

/** YYYY-MM-DD 加减整数天，返回 YYYY-MM-DD（纯 UTC 日历算术，免疫夏令时）。 */
export function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

function zonedParts(instant: Date, timeZone: string): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  let year = "";
  let month = "";
  let day = "";
  let hour = "";
  let minute = "";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value === "24" ? "00" : p.value;
    else if (p.type === "minute") minute = p.value;
  }
  return { year, month, day, hour, minute };
}

/** 将瞬时时间转为指定时区（未传或无效时回退进程本地时区）的 YYYY-MM-DD。 */
export function dateInZone(instant: Date, timeZone?: string): string {
  if (!timeZone || !isValidTimeZone(timeZone)) {
    return `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;
  }
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year}-${month}-${day}`;
}

/** 将瞬时时间转为指定时区（未传或无效时回退进程本地时区）的 HHMM（0000–2359，永不出 24xx）。 */
export function hhmmInZone(instant: Date, timeZone?: string): string {
  if (!timeZone || !isValidTimeZone(timeZone)) {
    return `${String(instant.getHours()).padStart(2, "0")}${String(instant.getMinutes()).padStart(2, "0")}`;
  }
  const { hour, minute } = zonedParts(instant, timeZone);
  return `${hour}${minute}`;
}
