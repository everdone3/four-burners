// A shared "add a note" sheet. Plain textarea so iOS dictation works; optional private flag.
// Private notes are never included in anything copied for Claude.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { GhostButton, PrimaryButton, Sheet, inputClass } from './ui';
import { SensitiveWarning } from './Sensitive';

export interface NoteRequest {
  title: string;
  initial?: string;
  initialPrivate?: boolean;
  placeholder?: string;
  onSave: (note: string, isPrivate: boolean) => void | Promise<void>;
}

const Ctx = createContext<(r: NoteRequest) => void>(() => {});
export const useNotePrompt = () => useContext(Ctx);

export function NotePromptProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<NoteRequest | null>(null);
  const [text, setText] = useState('');
  const [priv, setPriv] = useState(false);
  const open = useCallback((r: NoteRequest) => {
    setText(r.initial ?? '');
    setPriv(!!r.initialPrivate);
    setReq(r);
  }, []);
  const close = () => setReq(null);

  return (
    <Ctx.Provider value={open}>
      {children}
      <Sheet open={!!req} onClose={close} title={req?.title}>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await req?.onSave(text.trim(), priv);
            close();
          }}
        >
          <textarea
            autoFocus
            rows={3}
            className={`${inputClass} resize-none`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={req?.placeholder ?? 'A short note'}
            autoCapitalize="sentences"
          />
          <SensitiveWarning text={text} />
          <PrivateToggle value={priv} onChange={setPriv} />
          <div className="flex gap-3">
            <GhostButton type="button" onClick={close}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" className="flex-1">
              Save note
            </PrimaryButton>
          </div>
        </form>
      </Sheet>
    </Ctx.Provider>
  );
}

export function PrivateToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="flex min-h-12 w-full items-center gap-3 rounded-2xl border px-4 text-left transition"
      style={{ borderColor: value ? 'rgba(255,174,59,0.5)' : 'rgba(255,255,255,0.09)', background: value ? 'rgba(255,174,59,0.08)' : 'transparent' }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={value ? '#ffae3b' : '#a8a8b3'} strokeWidth="2">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d={value ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} />
      </svg>
      <span className="flex-1">
        <span className="block text-[15px] font-medium">{value ? 'Private note' : 'Mark private'}</span>
        <span className="block text-[13px] text-faint">Private notes are never shared with your coach.</span>
      </span>
    </button>
  );
}
