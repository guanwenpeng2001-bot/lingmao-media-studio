import React from 'react';
import { Keyboard, X } from 'lucide-react';
import { useApp } from '../state/AppContext';

const SHORTCUTS = [
  { keys: 'Ctrl / Cmd + Z', desc: '画布撤销（支持 50 步）' },
  { keys: 'Ctrl / Cmd + Shift + Z', desc: '画布重做' },
  { keys: 'Space + 左键拖拽', desc: '无限画布平移' },
  { keys: 'Ctrl / Cmd + 滚轮', desc: '无限画布无极缩放' },
  { keys: 'Delete / Backspace', desc: '删除选中节点（含下游引用确认）' },
  { keys: 'Shift + 1', desc: '画布自适应全图视口' },
  { keys: '?', desc: '打开 / 关闭快捷键面板' },
];

export const ShortcutsModal: React.FC = () => {
  const { shortcutsModalOpen, setShortcutsModalOpen } = useApp();
  if (!shortcutsModalOpen) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
      onClick={() => setShortcutsModalOpen(false)}
    >
      <div
        role="dialog"
        aria-label="快捷键指南"
        className="w-full max-w-[440px] rounded-modal border border-line-default bg-elevated p-5 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-line-subtle">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-ai" />
            <h3 className="text-sm font-semibold text-ink-primary">工作台快捷键</h3>
          </div>
          <button
            type="button"
            onClick={() => setShortcutsModalOpen(false)}
            className="rounded p-1 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between text-xs">
              <span className="text-ink-secondary">{s.desc}</span>
              <kbd className="rounded-sm border border-line-default bg-subtle px-2 py-0.5 font-mono text-[11px] text-ink-primary">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
