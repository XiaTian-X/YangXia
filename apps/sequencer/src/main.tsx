import sg500 from "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2?url";
import sg700 from "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2?url";
import { render } from "preact";
import { App } from "./ui/App.tsx";
import "./styles.css";

// 数字字体 Space Grotesk（OFL-1.1）：只加载拉丁字符的 woff2，打包时内嵌进单文件，不联网。加载失败就用系统字体
for (const [url, weight] of [[sg500, "500"], [sg700, "700"]] as const) {
  try {
    const face = new FontFace("Space Grotesk", `url(${url}) format("woff2")`, { weight, display: "swap" });
    document.fonts.add(face);
    void face.load().catch(() => undefined);
  } catch {
    // 不支持 FontFace 的浏览器用系统字体
  }
}

render(<App />, document.getElementById("app")!);
