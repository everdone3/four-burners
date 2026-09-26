// Small shared UI pieces.
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion, spring } from '../motion';

// ---------- Bottom sheet ----------

export function Sheet({
  open,
  onClose,
  title,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40">
          <motion.div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            aria-labelledby={labelledBy}
            className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] max-w-xl flex-col rounded-t-[28px] border-t border-line bg-surface pb-safe"
            initial={reduced ? { opacity: 0 } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : { y: '100%' }}
            transition={spring}
            drag={reduced ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-white/20" />
            {title && <h2 className="px-6 pt-4 pb-2 font-display text-xl font-semibold">{title}</h2>}
            <div className="overflow-y-auto overscroll-contain px-6 pt-2 pb-4">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ---------- Toasts ----------

interface Toast {
  id: number;
  message: string;
  actions?: { label: string; run: () => void }[];
  duration: number;
}

const ToastCtx = createContext<(t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const show = useCallback((t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => {
    const id = nextId.current++;
    const toast = { duration: 5000, ...t, id };
    setToasts((xs) => [...xs.slice(-1), toast]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), toast.duration);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-[calc(max(env(safe-area-inset-bottom),16px)+88px)]" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.96 }}
              transition={spring}
              className="pointer-events-auto relative flex min-h-13 w-full max-w-md items-center gap-1 overflow-hidden rounded-2xl border border-white/10 bg-[#141416]/95 py-1.5 pr-1.5 pl-4 shadow-[0_10px_40px_-8px_rgba(0,0,0,0.9)] backdrop-blur-xl"
            >
              <span className="flex-1 text-[15px]">{t.message}</span>
              {t.actions?.map((a) => (
                <button
                  key={a.label}
                  className="min-h-11 rounded-xl px-3.5 text-[15px] font-bold text-ember active:bg-white/10"
                  onClick={() => {
                    a.run();
                    setToasts((xs) => xs.filter((x) => x.id !== t.id));
                  }}
                >
                  {a.label}
                </button>
              ))}
              {t.actions?.length ? (
                <motion.span
                  aria-hidden
                  className="absolute bottom-0 left-0 h-[2px] w-full origin-left"
                  style={{ background: "linear-gradient(90deg, #ff6a2b, #ffd27a)", boxShadow: "0 0 8px #ff8a3d" }}
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: t.duration / 1000, ease: "linear" }}
                />
              ) : null}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- Buttons and inputs ----------

export function PrimaryButton({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`min-h-13 rounded-2xl bg-white px-5 text-[17px] font-semibold text-black transition active:scale-[0.98] disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`min-h-12 rounded-2xl border border-line bg-raised px-4 text-[16px] font-medium transition active:scale-[0.98] active:bg-white/10 disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium tracking-wide text-dim uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-2xl border border-line bg-raised px-4 py-3.5 text-[16px] text-white placeholder:text-faint outline-none focus:border-white/30';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  // Unique per instance, so several selectors on one screen each animate their own highlight.
  const uid = useId();
  return (
    <div className="flex rounded-2xl border border-line bg-raised p-1" role="radiogroup">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={`relative min-h-11 flex-1 rounded-xl px-2 text-[15px] font-medium transition disabled:opacity-35 ${active ? 'text-black' : 'text-dim'}`}
          >
            {active && <motion.span layoutId={`seg-${uid}`} className="absolute inset-0 rounded-xl bg-white" transition={spring} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
