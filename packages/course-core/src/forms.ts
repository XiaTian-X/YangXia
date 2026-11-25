// 给网页、安卓渲染表单用的结构化数据：要问什么、能选什么都从训练单和规则层推出来，
// 前端只渲染，不自己挑选项（第一轮审查修复方案第二节）。
import type { Manifest } from "./manifest.ts";
import type { PlansData } from "./plan.ts";

/** "按器材选一个"里的一个选项。 */
export interface ChoiceOption {
  /** 写进档案 choices 的值：训练单原样（动作 ID，或者"（门框划船）"这种原文写法）。 */
  value: string;
  /** 给人看的名字：动作库的中文名；不是动作 ID 的照原文去掉括号。 */
  name: string;
  /** 能不能导出成跟练课程（不是动作 ID 的只能照成品原文做）。 */
  exportable: boolean;
}

/** 训练单里一组"按器材选一个"（trim.kind === "choose"），按 moves 和条件去重。 */
export interface ChoiceGroup {
  key: string;
  options: ChoiceOption[];
  /** 这组只在条件取这个值时用（如 13–17 岁"家长在旁边"）；null 表示一直用。 */
  condition: { name: string; value: boolean } | null;
  /** 用到这组的日子（去重，按出现先后）。 */
  days: string[];
}

/**
 * 这份成品要按器材选的组。档案的 choices 是一个按优先顺序排的列表：导出时每组取 choices 里第一个在这组里的；
 * 所以每一组（含各个条件取值的组）都要至少选中一个，不然导出到用得上它的那一天会报错。
 */
export function choiceGroups(plans: PlansData, manifest: Manifest, productName: string): ChoiceGroup[] {
  const product = plans.products[productName];
  if (!product) return [];
  const groups = new Map<string, ChoiceGroup>();
  for (const r of product.rows) {
    if (r.trim.kind !== "choose") continue;
    const key = `${r.moves.join("|")}#${r.condition ? `${r.condition.name}=${r.condition.value}` : ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        options: r.moves.map((m) => {
          const ex = manifest.exercises.find((e) => e.id === m);
          return { value: m, name: ex ? ex.short || ex.name : m.replace(/^（(.*)）$/, "$1"), exportable: !!ex };
        }),
        condition: r.condition ? { name: r.condition.name, value: r.condition.value } : null,
        days: [],
      };
      groups.set(key, g);
    }
    if (!g.days.includes(r.day)) g.days.push(r.day);
  }
  return [...groups.values()];
}

/** choices 有没有覆盖每一组：返回没覆盖的组。 */
export function uncoveredChoiceGroups(groups: ChoiceGroup[], choices: readonly string[]): ChoiceGroup[] {
  return groups.filter((g) => !g.options.some((o) => choices.includes(o.value)));
}
