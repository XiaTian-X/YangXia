// 跟练画面（HUD）：一帧怎么画。照原版 drawHudCanvasOnce 原样移植，改成纯函数：
// 输入画面状态和画布，不读播放器；实时播放和离线导出视频共用。去掉了原版的透明背景模式。
import { barTarget, type TimelineEvent } from "@yangxia/course-core";

export const HUD_WIDTH = 1280;
export const HUD_HEIGHT = 720;

export interface HudState {
  bgMode: "dark" | "green" | "magenta" | "black";
  layoutMode: "overlay" | "center";
  tagText: string;
  repText: string;
  phaseText: string;
  breathText: string;
  voiceText: string;
  dotIdx: number;
  totalDots: number;
  barCurrent: number;
  barTarget: number;
  setProgress: number;
  pulseScale: number;
  state: "prep" | "action" | "rest";
  isLastThree: boolean;
}

export function initialHud(): HudState {
  return { bgMode: "dark", layoutMode: "overlay", tagText: "养夏 · 跟练编排器", repText: "READY", phaseText: "导入课程后点\"开始跟练\"",
    breathText: "🌬️ 领呼待命", voiceText: "", dotIdx: 0, totalDots: 3, barCurrent: 0.15, barTarget: 0.15, setProgress: 0,
    pulseScale: 1, state: "action", isLastThree: false };
}

/** 到了一个事件：画面文字、进度、脉冲照原版 renderEventToUI 更新。 */
export function applyEvent(s: HudState, ev: TimelineEvent): void {
  s.tagText = ev.tag;
  s.repText = ev.display;
  s.phaseText = ev.label;
  s.breathText = ev.breathText;
  s.dotIdx = ev.dotIdx;
  s.totalDots = ev.totalDots;
  s.setProgress = ev.setProgress;
  s.state = ev.state;
  s.isLastThree = ev.isLastThree;
  s.pulseScale = ev.isCountJumpBeat ? 1.26 : 1.06;
}

/** 每帧的平滑：脉冲回落、进度条追目标值。cur / next 是当前和下一个事件，t 是课程时间。 */
export function stepHud(s: HudState, cur?: TimelineEvent, next?: TimelineEvent, t?: number): void {
  s.pulseScale += (1.0 - s.pulseScale) * 0.18;
  if (cur && t !== undefined) s.barTarget = barTarget(cur, next, t);
  s.barCurrent += (s.barTarget - s.barCurrent) * 0.24;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}


export function drawHud(ctx: CanvasRenderingContext2D, s: HudState, W = HUD_WIDTH, H = HUD_HEIGHT): void {
    ctx.clearRect(0, 0, W, H);
    if (s.bgMode === 'magenta') {
      ctx.fillStyle = '#FF00FF';
      ctx.fillRect(0, 0, W, H);
    } else if (s.bgMode === 'green') {
      ctx.fillStyle = '#00FF00';
      ctx.fillRect(0, 0, W, H);
    } else if (s.bgMode === 'black') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
    } else if (s.bgMode === 'dark') {
      const bgGrad = ctx.createLinearGradient(0, 0, W, H);
      bgGrad.addColorStop(0, '#101118');
      bgGrad.addColorStop(1, '#181a24');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
    }

    const isSolidKeyMode = (s.bgMode === 'magenta' || s.bgMode === 'green' || s.bgMode === 'black');
    const cardBgFill = isSolidKeyMode ? '#14151f' : 'rgba(16, 17, 24, 0.88)';
    const cardBorderStroke = isSolidKeyMode ? '#2e3044' : 'rgba(255, 255, 255, 0.15)';

    const accentColor = s.state === 'rest'
      ? '#38bdf8'
      : (s.isLastThree ? '#f59e0b' : '#24c789');
    const accentBright = s.state === 'rest'
      ? '#7dd3fc'
      : (s.isLastThree ? '#fbbf24' : '#3df5b0');

    // 左上角动作序号 + 动作名称 + 组数 + 全局进度胶囊
    const badgeX = 48;
    const badgeY = 42;
    const badgeW = 520;
    const badgeH = 68;

    ctx.save();
    drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 16);
    ctx.fillStyle = cardBgFill;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = cardBorderStroke;
    ctx.stroke();

    drawRoundedRect(ctx, badgeX + 14, badgeY + 16, 8, badgeH - 32, 4);
    ctx.fillStyle = accentColor;
    ctx.fill();

    ctx.fillStyle = '#f3f4f6';
    ctx.font = '700 22.5px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.tagText, badgeX + 34, badgeY + 25, badgeW - 96);

    ctx.fillStyle = accentBright;
    ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.min(100, Math.max(0, Math.round(s.setProgress)))}%`, badgeX + badgeW - 18, badgeY + 25);

    const progTrackX = badgeX + 34;
    const progTrackY = badgeY + 48;
    const progTrackW = badgeW - 52;
    drawRoundedRect(ctx, progTrackX, progTrackY, progTrackW, 6, 3);
    ctx.fillStyle = '#272936';
    ctx.fill();

    const fillW = Math.max(6, (progTrackW * Math.min(100, Math.max(0, s.setProgress))) / 100);
    drawRoundedRect(ctx, progTrackX, progTrackY, fillW, 6, 3);
    ctx.fillStyle = accentColor;
    ctx.fill();
    ctx.restore();

    if (s.layoutMode === 'overlay') {
      const cardX = 48;
      const cardY = 384;
      const cardW = 520;
      const cardH = 288;

      ctx.save();
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
      ctx.fillStyle = cardBgFill;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = accentColor;
      ctx.stroke();

      const barX = cardX + 26;
      const barY = cardY + 28;
      const barW = 22;
      const barH = cardH - 56;
      drawRoundedRect(ctx, barX, barY, barW, barH, 11);
      ctx.fillStyle = '#252736';
      ctx.fill();

      const activeBarH = Math.max(16, barH * Math.min(1, Math.max(0.05, s.barCurrent)));
      const activeBarY = barY + (barH - activeBarH);
      const barGrad = ctx.createLinearGradient(0, activeBarY, 0, barY + barH);
      barGrad.addColorStop(0, accentBright);
      barGrad.addColorStop(1, accentColor);
      drawRoundedRect(ctx, barX, activeBarY, barW, activeBarH, 11);
      ctx.fillStyle = barGrad;
      ctx.fill();

      const statusMiniLabel = s.state === 'rest'
        ? '☕ 间歇恢复'
        : (s.isLastThree ? '🔥 最后冲刺' : (s.state === 'prep' ? '⏳ 预备起势' : '⚡ 核心训练'));
      ctx.fillStyle = accentBright;
      ctx.font = '700 15px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(statusMiniLabel, cardX + 68, cardY + 32);

      const dotsStartX = cardX + cardW - 30 - (s.totalDots - 1) * 20;
      const dotsY = cardY + 32;
      for (let i = 0; i < s.totalDots; i++) {
        const dx = dotsStartX + i * 20;
        ctx.beginPath();
        ctx.arc(dx, dotsY, i === s.dotIdx ? 7.5 : 5.5, 0, Math.PI * 2);
        ctx.fillStyle = i === s.dotIdx ? accentBright : '#383a4c';
        ctx.fill();
      }

      const numCenterX = cardX + 275;
      const numCenterY = cardY + 108;
      ctx.save();
      ctx.translate(numCenterX, numCenterY);
      ctx.scale(s.pulseScale, s.pulseScale);
      ctx.fillStyle = accentColor;
      ctx.font = '800 84px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.repText, 0, 0, 300);
      ctx.restore();

      ctx.fillStyle = '#e5e7eb';
      ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.phaseText, cardX + 68, cardY + 186, cardW - 92);

      const pillX = cardX + 68;
      const pillY = cardY + 216;
      const pillW = cardW - 92;
      const pillH = 44;
      drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 12);
      ctx.fillStyle = '#202230';
      ctx.fill();

      ctx.fillStyle = accentBright;
      ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
      const subPillText = s.voiceText
        ? `${s.breathText}   |   🗣️ “${s.voiceText}”`
        : s.breathText;
      ctx.fillText(subPillText, pillX + 16, pillY + 22, pillW - 32);
      ctx.restore();

    } else {
      const cardW = 760;
      const cardH = 420;
      const cardX = (W - cardW) / 2;
      const cardY = (H - cardH) / 2 + 24;

      ctx.save();
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 30);
      ctx.fillStyle = cardBgFill;
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = accentColor;
      ctx.stroke();

      ctx.save();
      ctx.translate(W / 2, cardY + 135);
      ctx.scale(s.pulseScale, s.pulseScale);
      ctx.fillStyle = accentColor;
      ctx.font = '800 126px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.repText, 0, 0, 640);
      ctx.restore();

      ctx.fillStyle = '#f3f4f6';
      ctx.font = '600 29px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.phaseText, W / 2, cardY + 248, 680);

      const hBarW = 560;
      const hBarH = 20;
      const hBarX = (W - hBarW) / 2;
      const hBarY = cardY + 292;
      drawRoundedRect(ctx, hBarX, hBarY, hBarW, hBarH, 10);
      ctx.fillStyle = '#252736';
      ctx.fill();

      const fillW = Math.max(20, hBarW * Math.min(1, Math.max(0.05, s.barCurrent)));
      const barGrad = ctx.createLinearGradient(hBarX, 0, hBarX + fillW, 0);
      barGrad.addColorStop(0, accentColor);
      barGrad.addColorStop(1, accentBright);
      drawRoundedRect(ctx, hBarX, hBarY, fillW, hBarH, 10);
      ctx.fillStyle = barGrad;
      ctx.fill();

      ctx.fillStyle = accentBright;
      ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
      const bottomInfo = s.voiceText
        ? `${s.breathText}   ·   🗣️ “${s.voiceText}”`
        : s.breathText;
      ctx.fillText(bottomInfo, W / 2, cardY + 356, 680);
      ctx.restore();
    }
}
