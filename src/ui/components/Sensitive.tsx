// Work confidentiality UI: the sensitive-terms editor and the gentle warning shown while typing.
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { cleanTerms, findSensitive, termProblem } from '@/domain/coach/redact';
import { useSettings } from '@/data/hooks';
import { saveSettings } from '@/data/repo';
import { inputClass } from './ui';

/** A subtle line under a text field when it contains a sensitive term. Redaction still happens either way. */
export function SensitiveWarning({ text }: { text: string }) {
  const settings = useSettings();
  const found = settings ? findSensitive(text, settings.sensitiveTerms) : [];
  return (
    <AnimatePresence>
      {found.length > 0 && (
        <motion.p
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="flex items-center gap-1.5 overflow-hidden text-[13px] text-amber-200/90"
          role="status"
        >
          <span aria-hidden>🔒</span>
          Mentions {found.map((t) => `"${t}"`).join(', ')}. It stays on your phone and is redacted from coach packets.
        </motion.p>
      )}
    </AnimatePresence>
  );
}

export function SensitiveTermsEditor({ terms }: { terms: string[] }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    const incoming = text.split(',').map((t) => t.trim()).filter(Boolean);
    const bad = incoming.map(termProblem).find(Boolean) ?? null;
    setProblem(bad);
    const ok = incoming.filter((t) => !termProblem(t));
    if (ok.length) await saveSettings({ sensitiveTerms: cleanTerms([...terms, ...ok]) });
    if (!bad) setText('');
  };
  return (
    <div>
      <p className="mb-3 text-[14px] text-dim">
        Company, client, or deal names. They are replaced with [redacted] in everything you copy for Claude, even inside your notes and wins.
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        {terms.length === 0 && <span className="text-[14px] text-faint">No terms yet.</span>}
        {terms.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full bg-white/[0.06] py-1 pr-1 pl-3 text-[14px]" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)' }}>
            {t}
            <button
              onClick={() => void saveSettings({ sensitiveTerms: terms.filter((x) => x !== t) })}
              className="grid h-7 w-7 place-items-center rounded-full text-faint active:bg-white/10"
              aria-label={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void add();
        }}
      >
        <input
          className={inputClass}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a name (commas for several)"
          autoCapitalize="words"
          autoComplete="off"
        />
        <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-2xl bg-ember/15 px-4 text-[16px] font-bold text-ember disabled:opacity-30">
          Add
        </button>
      </form>
      {problem && <p className="mt-2 text-[13px] text-amber-200">{problem}</p>}
    </div>
  );
}
