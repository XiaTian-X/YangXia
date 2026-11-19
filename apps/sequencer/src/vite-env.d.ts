/// <reference types="vite/client" />

declare module "virtual:yangxia-figures" {
  /** gzip 后的 motions.json（base64）；构建时没有动图数据就是空字符串。 */
  export const motionsGz: string;
  /** gzip 后的动画引擎 wasm（base64）。 */
  export const wasmGz: string;
  /** 第三方组件的版权和许可全文。 */
  export const notices: string;
}
