// 内置语音能说的话。内置合成器只有一组固定音节（见 apps/sequencer 的语音合成），
// 所以语音只能用这里的词表和组合规则；词表外的话（如"别把气停住""左侧"）只能出现在字幕和画面上。
// 词表和读法照原版编排器移植（numberToTokenKeys / buildVoicePhraseWaveform）。

export const ATOMIC_TOKENS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "呼", "吸", "深吸气", "慢呼气", "下一项",
  "开始", "最后三次", "本组完成", "全部完成", "休息", "准备",
] as const;

/** 合成器里每个词元对应的音节（apps/sequencer 的语音合成按这里拼）。 */
export const TOKEN_SYLLABLES: Record<string, string[]> = {
  "1": ["yi1"], "2": ["er4"], "3": ["san1"], "4": ["si4"], "5": ["wu3"],
  "6": ["liu4"], "7": ["qi1"], "8": ["ba1"], "9": ["jiu3"], "10": ["shi2"],
  "10_short": ["shi2_short"], "百": ["bai3"], "0": ["ling2"],
  "呼": ["hu1"], "吸": ["xi1"],
  "深吸气": ["shen1", "xi1", "qi4"], "慢呼气": ["man4", "hu1", "qi4"], "下一项": ["xia4", "yi1", "xiang4"],
  "第": ["di4"], "组": ["zu3"], "秒": ["miao3"], "下": ["xia4"],
  "开始": ["kai1", "shi3"], "最后三次": ["zui4", "hou4", "san1", "ci4"],
  "本组完成": ["ben3", "zu3", "wan2", "cheng2"], "全部完成": ["quan2", "bu4", "wan2", "cheng2"],
  "休息": ["xiu1", "xi0"], "准备": ["zhun3", "bei4"],
};

/** 1–999 的读法（"十二"读作 10_short + 2）。超出范围返回 null。 */
export function numberTokens(num: number): string[] | null {
  const n = Math.floor(num);
  if (!Number.isFinite(n) || n <= 0 || n > 999) return null;
  if (n <= 10) return [String(n)];
  if (n < 20) return ["10_short", String(n - 10)];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? [String(tens), "10"] : [String(tens), "10_short", String(ones)];
  }
  const hundreds = Math.floor(n / 100);
  const rem = n % 100;
  const keys = [String(hundreds), "百"];
  if (rem === 0) return keys;
  if (rem < 10) return [...keys, "0", String(rem)];
  if (rem < 20) {
    keys.push("1", "10_short");
    if (rem % 10 > 0) keys.push(String(rem % 10));
    return keys;
  }
  return [...keys, ...(numberTokens(rem) ?? [])];
}

/** 一句话拆成词元；说不出来（不在词表和组合规则里）返回 null。 */
export function voiceTokens(text: string): string[] | null {
  if (!text) return null;
  if ((ATOMIC_TOKENS as readonly string[]).includes(text)) return [text];
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^(\d+)$/))) return numberTokens(Number(m[1]));
  if ((m = text.match(/^(\d+)秒$/))) {
    const n = numberTokens(Number(m[1]));
    return n && [...n, "秒"];
  }
  if ((m = text.match(/^(\d+)，(呼|吸)$/))) {
    // 报数和呼吸口令落在同一拍（v4 阶段 8）
    const n = numberTokens(Number(m[1]));
    return n && [...n, m[2]];
  }
  if ((m = text.match(/^(\d+)，(本组完成|全部完成)$/))) {
    const n = numberTokens(Number(m[1]));
    return n && [...n, m[2]];
  }
  if ((m = text.match(/^休息 (\d+) 秒$/))) {
    const n = numberTokens(Number(m[1]));
    return n && ["休息", ...n, "秒"];
  }
  if (text === "准备下一组") return ["准备", "下", "1", "组"];
  if (text === "准备下一项") return ["准备", "下一项"];
  return null;
}

export function canSpeak(text: string): boolean {
  return voiceTokens(text) !== null;
}

/** 没有真实波形时估算一句话的时长（秒）：每个音节约 0.26 秒，减去拼接重叠。 */
export function estimateVoiceSeconds(text: string): number {
  const tokens = voiceTokens(text);
  if (!tokens) return 0;
  const syllables = tokens.reduce((n, t) => n + (TOKEN_SYLLABLES[t]?.length ?? 1), 0);
  return syllables * 0.26 - Math.max(0, syllables - 1) * 0.014;
}

/** 自己录报数声时，固定口令按这个顺序列（"下一项"单独不会说，只在"准备下一项"里）。 */
export const RECORD_WORDS = [
  "准备", "开始", "呼", "吸", "深吸气", "慢呼气", "最后三次", "本组完成", "全部完成", "准备下一组", "准备下一项",
] as const;

export interface RecordUnits {
  /** 固定口令，整句录。 */
  words: string[];
  /** 数字，一个数录一段；没录的数可以用录过的 1–10 拼。 */
  numbers: string[];
  /** 带数字的话（"30秒""休息 60 秒"），整句录。 */
  counted: string[];
}

const byNumber = (a: string, b: string) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]) || a.localeCompare(b);

/**
 * 自己录报数声要录哪些：按句录，不按字。"12，本组完成""3，吸"这种拆成数字和口令分开录，录了就能拼起来。
 * 不给课程（texts 为空）时列 1–10 和全部固定口令。说不出来的话（不在词表里）不列。
 */
export function recordUnits(texts: Iterable<string | null | undefined>): RecordUnits {
  const words = new Set<string>();
  const numbers = new Set<string>();
  const counted = new Set<string>();
  let any = false;
  for (const text of texts) {
    if (!text || !canSpeak(text)) continue;
    any = true;
    const m = text.match(/^(\d+)，(本组完成|全部完成|呼|吸)$/);
    if (m) {
      numbers.add(String(Number(m[1])));
      words.add(m[2]);
    } else if (/^\d+$/.test(text)) numbers.add(String(Number(text)));
    else if (/\d/.test(text)) counted.add(text);
    else words.add(text);
  }
  if (!any) return { words: [...RECORD_WORDS], numbers: Array.from({ length: 10 }, (_, i) => String(i + 1)), counted: [] };
  const order = RECORD_WORDS as readonly string[];
  const rank = (w: string) => (order.includes(w) ? order.indexOf(w) : order.length);
  return {
    words: [...words].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    numbers: [...numbers].sort(byNumber),
    counted: [...counted].sort(byNumber),
  };
}
