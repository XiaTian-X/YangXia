// 方案库：课程 + 设置存在这个浏览器里（localStorage，只在本机、只给自己看）；也可以导出、导入课程 JSON。
import type { Course, PlaybackSettings } from "@yangxia/course-core";
import { useState } from "preact/hooks";

const KEY = "yangxia.sequencer.schemes";

export interface Scheme {
  name: string;
  savedAt: string;
  course: Course;
  settings: PlaybackSettings;
}

function load(): Scheme[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Scheme[]) : [];
  } catch {
    return [];
  }
}

function save(list: Scheme[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

interface Props {
  course: Course | null;
  settings: PlaybackSettings;
  onLoad: (s: Scheme) => void;
  onExportCourse: () => void;
}

export function Library({ course, settings, onLoad, onExportCourse }: Props) {
  const [list, setList] = useState<Scheme[]>(load);
  const [msg, setMsg] = useState("");
  const update = (next: Scheme[]) => {
    setList(next);
    setMsg(save(next) ? "" : "这个浏览器不让保存（可能是隐私模式），请改用\"导出课程 JSON\"");
  };
  return (
    <div>
      <div class="row" style={{ marginBottom: 10 }}>
        <button class="btn small" disabled={!course} onClick={() => course && update([
          { name: course.name, savedAt: new Date().toISOString(), course, settings },
          ...list.filter((x) => x.name !== course.name),
        ])}>保存到本机</button>
        <button class="btn small" disabled={!course} onClick={onExportCourse}>导出课程 JSON</button>
      </div>
      {msg && <div class="issue warning">{msg}</div>}
      {list.length === 0 && <p class="note">还没有保存的方案。</p>}
      {list.map((s) => (
        <div class="scheme" key={s.name}>
          <div>
            <div>{s.name}</div>
            <div class="note">{new Date(s.savedAt).toLocaleString("zh-CN")}</div>
          </div>
          <div class="row">
            <button class="btn small" onClick={() => onLoad(s)}>载入</button>
            <button class="btn small danger" onClick={() => update(list.filter((x) => x !== s))}>删除</button>
          </div>
        </div>
      ))}
    </div>
  );
}
