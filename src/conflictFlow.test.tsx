import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import App from './App';
import {
  CHANNEL_NAME,
  GENESIS_REVISION_ID,
  HEAD_STORAGE_KEY,
  REVISIONS_STORAGE_KEY,
  Revision,
} from './lib/revisionStore';
import { Plan } from './lib/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 以 React 可感知的方式写入受控 input/textarea 的值 */
function setControlValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * 多标签页分叉冲突流程的组件测试：
 * 冲突态入口（编辑锁定、只读的「无类路由」仍可打开且浮于冲突弹窗之上）、
 * 关闭无类路由弹窗后回退到原冲突、选择本页/外部版本后正常解除锁定。
 */

// ---------------------------------------------------------------------------
// BroadcastChannel 替身：保留全部实例，测试中可模拟「其他标签页」投递修订
// ---------------------------------------------------------------------------
interface FakeChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  close: () => void;
  postMessage: (data: unknown) => void;
}

let fakeChannels: FakeChannel[] = [];

class FakeBroadcastChannel {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private closed = false;

  constructor(public name: string) {
    fakeChannels.push(this as unknown as FakeChannel);
  }

  postMessage(): void {
    // 本测试只有单个 App 实例：自身的广播不需要回流。
  }

  close(): void {
    this.closed = true;
  }

  /** 测试辅助：模拟其他标签页广播一条消息到本实例 */
  _deliver(data: unknown): void {
    if (this.closed || !this.onmessage) return;
    this.onmessage(new MessageEvent('message', { data }));
  }
}

// ---------------------------------------------------------------------------
// 测试夹具：本页与外部标签页在同一创世修订上分叉
// ---------------------------------------------------------------------------
const localPlan: Plan = {
  version: 1,
  roots: [{ id: 'r1', name: '本地根', cidr: '10.10.0.0/16' }],
  allocations: [
    { id: 'a1', name: '本地子网', kind: 'subnet', prefix: 24, cidr: '10.10.0.0/24' },
  ],
};

const remotePlan: Plan = {
  version: 1,
  roots: [{ id: 'r2', name: '外部分叉根', cidr: '172.20.0.0/16' }],
  allocations: [
    { id: 'a2', name: '外部分叉子网', kind: 'subnet', prefix: 24, cidr: '172.20.0.0/24' },
  ],
};

function revision(id: string, parents: string[], clientId: string, plan: Plan): Revision {
  return { id, parentRevisionIds: parents, clientId, plan };
}

const genesis = revision(GENESIS_REVISION_ID, [], 'client-local', {
  version: 1,
  roots: [],
  allocations: [],
});
const localRev = revision('rev-local-1', [GENESIS_REVISION_ID], 'client-local', localPlan);
const remoteRev = revision('rev-remote-1', [GENESIS_REVISION_ID], 'client-other-tab', remotePlan);

/** 模拟其他标签页把一条分叉修订广播给 App 持有的频道。 */
function deliverFromOtherTab(rev: Revision): void {
  for (const ch of fakeChannels) {
    if (ch.name === CHANNEL_NAME) {
      (ch as unknown as { _deliver: (d: unknown) => void })._deliver({
        type: 'revision',
        revision: rev,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// DOM 辅助
// ---------------------------------------------------------------------------
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderApp(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<App />);
  });
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const wanted = text.replace(/\s+/g, '');
  const btn = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent?.replace(/\s+/g, '') === wanted,
  );
  if (!btn) throw new Error(`找不到按钮：${text}`);
  return btn as HTMLButtonElement;
}

/** 分配清单面板（TreeView 中也有「调整容量/释放」按钮，需要限定范围） */
function allocationsSection(): HTMLElement {
  const sec = Array.from(document.querySelectorAll('section.panel')).find((s) =>
    s.querySelector('h2')?.textContent?.includes('分配清单'),
  );
  if (!sec) throw new Error('找不到分配清单面板');
  return sec as HTMLElement;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

// ---------------------------------------------------------------------------
describe('多标签页分叉冲突流程', () => {
  beforeEach(() => {
    fakeChannels = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.sessionStorage.setItem('ipv4-subnet-planner/client-id', 'client-local');
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    // 预置本页已有修订（genesis → local），App 启动后恢复到 local head。
    window.localStorage.setItem(
      REVISIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, revisions: [genesis, localRev] }),
    );
    window.localStorage.setItem(HEAD_STORAGE_KEY, localRev.id);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('冲突态入口：弹出冲突弹窗、编辑操作锁定、无类路由入口可打开并浮于冲突界面之上', () => {
    renderApp();

    // 冲突前：本页规划正常展示
    expect(document.body.textContent).toContain('本地子网');

    // 收到外部标签页在同一基础上的分叉修订
    act(() => {
      deliverFromOtherTab(remoteRev);
    });

    // 冲突弹窗与锁定横幅出现
    const conflictBackdrop = document.querySelector('.conflict-backdrop');
    expect(conflictBackdrop).not.toBeNull();
    expect(document.body.textContent).toContain('检测到分叉更新');
    expect(document.querySelector('.lock-banner')).not.toBeNull();
    expect(document.querySelector('.layout.locked')).not.toBeNull();

    // 分配清单在锁定期间重新开放交互（仅只读入口）
    expect(document.querySelector('.panel-unlocked-readonly')).not.toBeNull();

    // 会修改规划的操作继续锁定：调整容量 / 释放 / DHCP 池 / 反向 DNS / 静态主机
    const panel = allocationsSection();
    expect(buttonByText('调整容量', panel).disabled).toBe(true);
    expect(buttonByText('释放', panel).disabled).toBe(true);
    expect(buttonByText('DHCP 池', panel).disabled).toBe(true);
    expect(buttonByText('反向 DNS', panel).disabled).toBe(true);
    expect(buttonByText('静态主机', panel).disabled).toBe(true);

    // 工具栏编辑入口同样锁定
    expect(buttonByText('导入 JSON').disabled).toBe(true);
    expect(buttonByText('载入示例').disabled).toBe(true);
    expect(buttonByText('清空').disabled).toBe(true);

    // 「无类路由」按钮标注可用（disabled 未置、提示冲突期可用）
    const csrEntry = buttonByText('无类路由', panel);
    expect(csrEntry.disabled).toBe(false);
    expect(csrEntry.title).toContain('只读');

    // 打开 Option 121 弹窗
    click(csrEntry);

    const csrBackdrop = document.querySelector('.csr-backdrop');
    expect(csrBackdrop).not.toBeNull();
    expect(document.body.textContent).toContain('DHCP 类无静态路由（Option 121）');

    // 弹窗可正常交互：输入合法路由行后产生 RFC 3442 编码结果
    const textarea = csrBackdrop!.querySelector('textarea') as HTMLTextAreaElement;
    setControlValue(textarea, '0.0.0.0/0,10.10.0.1\n');
    expect(csrBackdrop!.textContent).toContain('Option 121');
    // /0 默认路由编码：前缀 00 + 无目标字节 + 下一跳 0A 0A 00 01
    expect(csrBackdrop!.textContent).toContain('000A0A0001');

    // 两个背板同时存在；Option 121 弹窗以 .csr-backdrop（z-index 320）
    // 浮于冲突弹窗 .conflict-backdrop（z-index 300）之上，层级契约见样式契约测试。
    expect(csrBackdrop!.classList.contains('csr-backdrop')).toBe(true);
    expect(conflictBackdrop!.classList.contains('conflict-backdrop')).toBe(true);
  });

  it('关闭回退：关闭无类路由弹窗后冲突仍保留、编辑仍锁定', () => {
    renderApp();
    act(() => {
      deliverFromOtherTab(remoteRev);
    });

    click(buttonByText('无类路由', allocationsSection()));
    expect(document.querySelector('.csr-backdrop')).not.toBeNull();

    // 关闭弹窗（底部关闭按钮）
    click(buttonByText('关闭', document.querySelector('.csr-backdrop')!));

    // Option 121 弹窗消失，但冲突弹窗、锁定横幅仍在
    expect(document.querySelector('.csr-backdrop')).toBeNull();
    const conflictBackdrop = document.querySelector('.conflict-backdrop');
    expect(conflictBackdrop).not.toBeNull();
    expect(document.body.textContent).toContain('检测到分叉更新');
    expect(document.querySelector('.lock-banner')).not.toBeNull();

    // 编辑操作仍被锁定
    const panel = allocationsSection();
    expect(buttonByText('调整容量', panel).disabled).toBe(true);
    expect(buttonByText('释放', panel).disabled).toBe(true);

    // 冲突解决按钮仍可操作
    expect(buttonByText('保留本页').disabled).toBe(false);
    expect(buttonByText('采用外部').disabled).toBe(false);
  });

  it('冲突解决（保留本页）：选择本页版本后解除锁定、规划保持本页内容', () => {
    renderApp();
    act(() => {
      deliverFromOtherTab(remoteRev);
    });

    expect(document.querySelector('.conflict-backdrop')).not.toBeNull();

    click(buttonByText('保留本页'));

    // 冲突与横幅消失、布局解锁
    expect(document.querySelector('.conflict-backdrop')).toBeNull();
    expect(document.querySelector('.lock-banner')).toBeNull();
    expect(document.querySelector('.layout.locked')).toBeNull();

    // 内容仍是本页版本（外部分叉根/子网不出现）
    expect(document.body.textContent).toContain('本地子网');
    expect(document.body.textContent).not.toContain('外部分叉子网');

    // 编辑入口恢复可用
    expect(buttonByText('调整容量', allocationsSection()).disabled).toBe(false);
    expect(buttonByText('释放', allocationsSection()).disabled).toBe(false);
    expect(buttonByText('载入示例').disabled).toBe(false);

    // head 已推进为同时引用两个版本的合并修订
    const headId = window.localStorage.getItem(HEAD_STORAGE_KEY)!;
    const doc = JSON.parse(window.localStorage.getItem(REVISIONS_STORAGE_KEY)!);
    const head = doc.revisions.find((r: Revision) => r.id === headId) as Revision;
    expect(head.parentRevisionIds.sort()).toEqual([localRev.id, remoteRev.id].sort());

    // 解锁后释放操作可正常提交（发布新修订，不再被冲突防线拒绝）
    click(buttonByText('释放', allocationsSection()));
    const headIdAfter = window.localStorage.getItem(HEAD_STORAGE_KEY)!;
    expect(headIdAfter).not.toBe(headId);
    expect(document.body.textContent).not.toContain('本地子网');
  });

  it('冲突解决（采用外部）：选择外部版本后解除锁定并切换到外部规划', () => {
    renderApp();
    act(() => {
      deliverFromOtherTab(remoteRev);
    });

    click(buttonByText('采用外部'));

    // 冲突解除
    expect(document.querySelector('.conflict-backdrop')).toBeNull();
    expect(document.querySelector('.lock-banner')).toBeNull();
    expect(document.querySelector('.layout.locked')).toBeNull();

    // 规划已切换为外部版本
    expect(document.body.textContent).toContain('外部分叉子网');
    expect(document.body.textContent).not.toContain('本地子网');

    // 编辑入口恢复
    expect(buttonByText('释放', allocationsSection()).disabled).toBe(false);
    expect(buttonByText('DHCP 池', allocationsSection()).disabled).toBe(false);

    // 合并修订同时引用两个版本
    const headId = window.localStorage.getItem(HEAD_STORAGE_KEY)!;
    const doc = JSON.parse(window.localStorage.getItem(REVISIONS_STORAGE_KEY)!);
    const head = doc.revisions.find((r: Revision) => r.id === headId) as Revision;
    expect(head.parentRevisionIds.sort()).toEqual([localRev.id, remoteRev.id].sort());
  });
});

// ---------------------------------------------------------------------------
// 样式契约回归：冲突遮罩必须放行点击、Option 121 弹窗必须在冲突界面之上
// ---------------------------------------------------------------------------
describe('冲突锁定样式契约（styles.css）', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

  it('冲突遮罩背板不拦截点击，弹窗本体恢复交互', () => {
    expect(css).toMatch(/\.conflict-backdrop\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.conflict-backdrop\s+\.modal\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('Option 121 背板层级高于冲突弹窗、低于启动遮罩', () => {
    const conflictZ = /\.conflict-backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(css)![1];
    const csrZ = /\.csr-backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(css)![1];
    const bootZ = /\.boot-veil\s*\{[^}]*z-index:\s*(\d+)/.exec(css)![1];
    expect(Number(csrZ)).toBeGreaterThan(Number(conflictZ));
    expect(Number(csrZ)).toBeLessThan(Number(bootZ));
  });

  it('冲突期间布局整体拦截点击，仅分配清单只读面板重新开放', () => {
    expect(css).toMatch(/\.layout\.locked\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(
      /\.layout\.locked\s+\.panel-unlocked-readonly\s*\{[^}]*pointer-events:\s*auto/,
    );
  });
});
