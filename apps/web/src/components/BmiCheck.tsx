// "重度肥胖"这类按 BMI 推出来的条件：请使用者报身高、体重，在浏览器里当场算，只把"是 / 否"交给服务端。
// 身高体重只在这一页的输入框里，不进请求、不存档案、不进网址。
import { useState } from "preact/hooks";

export function BmiCheck({ line, idPrefix, onResult }: {
  /** BMI 到了这个数算"是"（规则层给的）。 */
  line: number;
  idPrefix: string;
  onResult: (atLeast: boolean) => void;
}) {
  const [h, setH] = useState("");
  const [w, setW] = useState("");
  const [bmi, setBmi] = useState<number | null>(null);
  const hn = Number(h);
  const wn = Number(w);
  const ok = h !== "" && w !== "" && hn >= 100 && hn <= 230 && wn >= 25 && wn <= 300;
  const calc = () => {
    if (!ok) return;
    const v = Math.round((wn / (hn / 100) ** 2) * 10) / 10;
    setBmi(v);
    onResult(v >= line);
  };
  return (
    <div class="stack" style={{ gap: "8px", marginTop: "10px" }}>
      <div class="muted">不知道的可以当场算：填身高、体重，算出来只记"是 / 否"，身高体重不保存、不发给服务器</div>
      <div class="row" style={{ gap: "12px", alignItems: "flex-end" }}>
        <label class="field2" for={`${idPrefix}-h`} style={{ width: "140px" }}>
          身高（厘米）
          <input id={`${idPrefix}-h`} type="number" inputMode="decimal" min={100} max={230} autoComplete="off" value={h}
            onInput={(e) => { setH((e.target as HTMLInputElement).value); setBmi(null); }} />
        </label>
        <label class="field2" for={`${idPrefix}-w`} style={{ width: "140px" }}>
          体重（公斤）
          <input id={`${idPrefix}-w`} type="number" inputMode="decimal" min={25} max={300} autoComplete="off" value={w}
            onInput={(e) => { setW((e.target as HTMLInputElement).value); setBmi(null); }} />
        </label>
        <button type="button" class="btn" disabled={!ok} onClick={calc}>算一下</button>
      </div>
      {bmi !== null && (
        <div class="notice plain" role="status">
          BMI 约 {bmi}：{bmi >= line ? `到了 ${line}，记"是"` : `不到 ${line}，记"否"`}
        </div>
      )}
    </div>
  );
}
