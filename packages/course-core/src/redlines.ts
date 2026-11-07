// 红线规则：来自模板 manifest 的 redlines（模板 content/params/红线词.md）。和模板 tools/redlines.py 判断一致，
// 由两边共用的"校验样例"保证。
export interface RedlineCase {
  age: string;
  scope: "正文" | "字幕和图";
  text: string;
  blocked: boolean;
}

export interface RedlineRules {
  banned: Record<string, string[]>;
  whitelist: Record<string, string[]>;
  required_all: string[];
  required: Record<string, string[]>;
  cases: RedlineCase[];
}

/** text 里命中的禁用词。字幕、画面、语音不用白名单（useWhitelist=false）。 */
export function redlineHits(rules: RedlineRules, age: string, text: string, useWhitelist: boolean): string[] {
  let body = text;
  if (useWhitelist) for (const phrase of rules.whitelist[age] ?? []) body = body.split(phrase).join("");
  return (rules.banned[age] ?? []).filter((w) => body.includes(w));
}

export function failedRedlineCases(rules: RedlineRules): RedlineCase[] {
  return rules.cases.filter((c) => redlineHits(rules, c.age, c.text, c.scope === "正文").length > 0 !== c.blocked);
}
