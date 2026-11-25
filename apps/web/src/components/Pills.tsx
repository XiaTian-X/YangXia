// 一组互斥的按钮（是 / 否、几选一）：aria-pressed 表示选中，不预选。
export function Pills({ label, value, options, onChange, tone }: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (v: string) => void;
  /** 选中"是"时的颜色：默认绿，warn 橙。 */
  tone?: Record<string, "warn" | "danger">;
}) {
  return (
    <div class="pills" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" class={`pill ${tone?.[o.value] ?? ""}`} aria-pressed={value === o.value} disabled={o.disabled}
          onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
