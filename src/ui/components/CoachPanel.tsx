// The copy-and-paste coaching loop, reusable on any screen:
// preview the exact packet (with its length), copy it for Claude, open Claude, come back, paste the reply,
// save it to the week or quarter, and turn suggested actions into weekly actions with one tap each.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { BURNER_LABELS, type BurnerId, type CoachReply, type LocalDate, type PacketKind } from '@/domain';
import type { BuiltPacket } from '@/domain/coach/packets';
import { actionKey, parseSuggestedActions, type ParsedAction } from '@/domain/coach/replies';
import { findSensitive } from '@/domain/coach/redact';
import { addActionFromReply, deleteCoachReply, saveCoachReply } from '@/data/repo';
import { useSettings } from '@/data/hooks';
import { CLAUDE_SCHEME_LINK, CLAUDE_UNIVERSAL_LINK, coach, copyText } from '@/coach/channel';
import { PENDING_EVENT, clearPending, isPending, markCopied, readPending } from '@/coach/session';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { MiniFlame, MoltenButton } from './sizzle';
import { GhostButton, PrimaryButton, Sheet, inputClass, useToast } from './ui';

export function packetLengthLabel(chars: number): string {
  const tokens = Math.round(chars / 4 / 10) * 10;
  return `${chars.toLocaleString()} characters, about ${tokens.toLocaleString()} tokens`;
}

const DRAFT_KEY = (kind: string, scope: string) => `fb-coach-draft-${kind}-${scope}`;

export function CoachPanel({
  kind,
  scope,
  packet,
  replies,
  actionsWeek,
  existingActionTexts = [],
  intro,
  accent = '#ffb454',
  onReplySaved,
  renderReplyExtras,
}: {
  kind: PacketKind;
  scope: string;
  /** Built before any tap so copying happens instantly inside the gesture. */
  packet: BuiltPacket;
  replies: CoachReply[];
  /** When set, suggested actions can be added to that week's actions. */
  actionsWeek?: LocalDate;
  /** Actions already in that week (chips for them are hidden). */
  existingActionTexts?: string[];
  intro?: string;
  accent?: string;
  onReplySaved?: (reply: CoachReply) => void;
  /** Extra UI under a saved reply (e.g. "Replace my profile" for onboarding). */
  renderReplyExtras?: (reply: CoachReply) => React.ReactNode;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const [manual, setManual] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(() => isPending(kind, scope));
  const mine = useMemo(
    () => replies.filter((r) => r.kind === kind && r.scope === scope && !r.deleted).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [replies, kind, scope],
  );
  const over = packet.chars > packet.budget;

  // Coming back from Claude: open the paste box. Three signals, since iOS standalone apps are inconsistent.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && isPending(kind, scope)) {
        // Bring the paste box to the front: close any copy sheet still open from before.
        setHandoff(false);
        setManual(false);
        setPreview(false);
        setPasteOpen(true);
      }
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('focus', check);
    };
  }, [kind, scope]);

  const copy = () => {
    if (!packet.safe) {
      toast({ message: packet.problems[0] ?? 'This packet cannot be copied yet.', duration: 6000 });
      return;
    }
    // First statement in the tap: start the clipboard write before anything else.
    const pending = coach.deliver(packet);
    void pending.then((r) => {
      if (!r.copied) {
        setManual(true);
        return;
      }
      markCopied({ kind, scope, chars: packet.chars });
      sfx.whoosh();
      haptic('success');
      setPreview(false);
      setHandoff(true);
    });
  };

  return (
    <div className="space-y-3">
      {intro && <p className="text-[15px] text-dim">{intro}</p>}

      <div className="flex items-center justify-between text-[13px]">
        <span className={`font-semibold tabular ${over ? 'text-amber-300' : 'text-faint'}`}>{packetLengthLabel(packet.chars)}</span>
        {packet.stats.redactions > 0 && <span className="text-amber-100">🔒 {packet.stats.redactions} redacted</span>}
      </div>

      {!packet.safe && (
        <p className="rounded-2xl border border-rose-300/30 bg-rose-300/[0.07] px-3.5 py-2.5 text-[14px] text-rose-100">
          Copy is paused: {packet.problems.join(' ')}
        </p>
      )}

      <div className="flex gap-2">
        <MoltenButton className="h-14 flex-1 text-[17px]" onClick={copy} disabled={!packet.safe}>
          Copy for Claude
        </MoltenButton>
        <GhostButton className="h-14 px-4" onClick={() => setPreview(true)}>
          Preview
        </GhostButton>
      </div>
      <p className="text-center text-[12px] text-faint">Copy, open Claude, paste into a new chat, then bring the reply back here.</p>

      {!pasteOpen && (
        <button onClick={() => setPasteOpen(true)} className="min-h-11 w-full rounded-2xl text-[15px] font-semibold" style={{ color: accent, boxShadow: `inset 0 0 0 1px ${accent}44` }}>
          Paste coach reply
        </button>
      )}

      <AnimatePresence initial={false}>
        {pasteOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <PasteReply
              kind={kind}
              scope={scope}
              packetChars={packet.chars}
              accent={accent}
              onCancel={() => setPasteOpen(false)}
              onSaved={(r) => {
                clearPending();
                setPasteOpen(false);
                onReplySaved?.(r);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {mine.map((r) => (
        <ReplyCard key={r.id} reply={r} actionsWeek={actionsWeek} existingActionTexts={existingActionTexts} accent={accent} extras={renderReplyExtras?.(r)} />
      ))}

      <Sheet open={preview} onClose={() => setPreview(false)} title="Exactly what will be copied">
        <PacketDetails packet={packet} />
        <PrimaryButton className="mt-3 w-full" onClick={copy} disabled={!packet.safe}>
          Copy for Claude
        </PrimaryButton>
      </Sheet>

      <Sheet open={manual} onClose={() => setManual(false)} title="Copy it by hand">
        <p className="mb-3 text-[15px] text-dim">The automatic copy was blocked. Press and hold the text, tap Select All, then Copy.</p>
        <textarea
          readOnly
          className={`${inputClass} h-64 text-[13px]`}
          value={packet.text}
          onFocus={(e) => e.currentTarget.select()}
          // Copying by hand (long-press, Copy) counts: coming back should open the paste box.
          onCopy={() => markCopied({ kind, scope, chars: packet.chars })}
        />
        <PrimaryButton
          className="mt-3 w-full"
          onClick={() => {
            void copyText(packet.text).then((ok) => {
              if (ok) {
                setManual(false);
                markCopied({ kind, scope, chars: packet.chars });
                setHandoff(true);
              }
            });
          }}
        >
          Copy again
        </PrimaryButton>
      </Sheet>

      <HandoffSheet open={handoff} chars={packet.chars} onClose={() => setHandoff(false)} onPaste={() => { setHandoff(false); setPasteOpen(true); }} />
    </div>
  );
}

function PacketDetails({ packet }: { packet: BuiltPacket }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-[13px]">
        <span className={`rounded-full px-3 py-1 font-semibold tabular ${packet.chars > packet.budget ? 'bg-amber-300/15 text-amber-200' : 'bg-white/[0.06]'}`}>{packetLengthLabel(packet.chars)}</span>
        {packet.stats.redactions > 0 && <span className="rounded-full bg-amber-300/10 px-3 py-1 text-amber-100">🔒 {packet.stats.redactions} redacted</span>}
        {packet.stats.privateOmitted > 0 && (
          <span className="rounded-full bg-amber-300/10 px-3 py-1 text-amber-100">
            {packet.stats.privateOmitted} private {packet.stats.privateOmitted === 1 ? 'note' : 'notes'} left out
          </span>
        )}
        {packet.stats.trimmed.length > 0 && <span className="rounded-full bg-white/[0.06] px-3 py-1 text-dim">Trimmed: {packet.stats.trimmed.join(', ')}</span>}
      </div>
      <pre className="max-h-[50dvh] overflow-auto rounded-2xl border border-white/[0.08] bg-black/60 p-3.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-white/85 select-text">{packet.text}</pre>
    </div>
  );
}

function HandoffSheet({ open, chars, onClose, onPaste }: { open: boolean; chars: number; onClose: () => void; onPaste: () => void }) {
  const [tapped, setTapped] = useState(false);
  const [stillHere, setStillHere] = useState(false);
  useEffect(() => {
    if (!open) {
      setTapped(false);
      setStillHere(false);
    }
  }, [open]);
  // Soft check: if tapping Open Claude did not take us away within 2 seconds, offer the backup.
  useEffect(() => {
    if (!tapped) return;
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') setStillHere(true);
    }, 2000);
    return () => clearTimeout(t);
  }, [tapped]);

  return (
    <Sheet open={open} onClose={onClose} title="Copied. Now open Claude and paste">
      <div className="space-y-4">
        <a
          href={CLAUDE_UNIVERSAL_LINK}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setTapped(true)}
          className="flex h-15 w-full items-center justify-center gap-2 rounded-full text-[18px] font-bold text-black"
          style={{ backgroundImage: 'linear-gradient(110deg, #ffd27a, #ff9a3c 45%, #ff6a2b)', boxShadow: '0 10px 40px -6px rgba(255,120,40,0.7)' }}
        >
          Open Claude
        </a>
        <ol className="space-y-2.5 text-[15px]">
          {['Start a new chat in your personal Claude app.', 'Press and hold, tap Paste, and send.', "Copy Claude's reply, come back, and paste it here."].map((s, i) => (
            <li key={s} className="flex gap-3">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ember/20 text-[14px] font-bold text-ember">{i + 1}</span>
              <span className="pt-0.5">{s}</span>
            </li>
          ))}
        </ol>
        {stillHere && (
          <p className="text-[14px] text-amber-100">
            Did Claude open? If you see a claude.ai web page instead, tap Done, then open the Claude app from your Home Screen and paste.{' '}
            <a href={CLAUDE_SCHEME_LINK} className="font-semibold text-ember underline">
              Try the app link
            </a>
          </p>
        )}
        <p className="text-[13px] text-faint">{packetLengthLabel(chars)} copied. When you come back, the reply box opens on its own.</p>
        <GhostButton className="w-full" onClick={onPaste}>
          I have the reply
        </GhostButton>
      </div>
    </Sheet>
  );
}

function PasteReply({
  kind,
  scope,
  packetChars,
  accent,
  onCancel,
  onSaved,
}: {
  kind: PacketKind;
  scope: string;
  packetChars: number;
  accent: string;
  onCancel: () => void;
  onSaved: (r: CoachReply) => void;
}) {
  // Autosave the paste box so an iOS reload mid-paste loses nothing.
  const [text, setTextState] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY(kind, scope)) ?? '';
    } catch {
      return '';
    }
  });
  const setText = (v: string) => {
    setTextState(v);
    try {
      localStorage.setItem(DRAFT_KEY(kind, scope), v);
    } catch {
      // ignore
    }
  };
  const parsed = useMemo(() => parseSuggestedActions(text), [text]);
  const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;
  return (
    <div className="space-y-2.5 rounded-3xl border p-4" style={{ borderColor: `${accent}55`, background: 'rgba(10,10,12,0.9)' }}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold tracking-[0.16em] uppercase" style={{ color: accent }}>
          Paste coach reply
        </span>
        {canReadClipboard && (
          <button
            className="min-h-10 rounded-full px-3 text-[14px] font-semibold"
            style={{ color: accent }}
            onClick={() => {
              navigator.clipboard.readText().then(
                (t) => t && setText(t),
                () => undefined, // permission declined; long-press paste still works
              );
            }}
          >
            Paste
          </button>
        )}
      </div>
      <textarea
        autoFocus
        rows={6}
        className={`${inputClass} resize-y text-[15px]`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Copy Claude's reply in the Claude app, then paste it here"
      />
      {parsed.isPacketEcho ? (
        <p className="text-[13px] text-amber-200">That looks like the packet you sent, not Claude's reply. Copy Claude's answer and paste again.</p>
      ) : (
        parsed.actions.length > 0 && (
          <p className="text-[13px] text-emerald-200">
            Found {parsed.actions.length} suggested {parsed.actions.length === 1 ? 'action' : 'actions'}.
          </p>
        )
      )}
      <div className="flex gap-2">
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton
          className="flex-1"
          disabled={text.trim().length < 10 || parsed.isPacketEcho}
          onClick={async (e) => {
            const x = e.clientX;
            const y = e.clientY;
            const r = await saveCoachReply({ kind, scope, text: text.trim(), actions: parsed.actions.map((a) => a.text), packetChars });
            try {
              localStorage.removeItem(DRAFT_KEY(kind, scope));
            } catch {
              // ignore
            }
            celebrate({ kind: 'log', burner: parsed.actions[0]?.burner ?? 'family', x, y });
            onSaved(r);
          }}
        >
          Save reply
        </PrimaryButton>
      </div>
    </div>
  );
}

function ReplyCard({
  reply,
  actionsWeek,
  existingActionTexts,
  accent,
  extras,
}: {
  reply: CoachReply;
  actionsWeek?: LocalDate;
  existingActionTexts: string[];
  accent: string;
  extras?: React.ReactNode;
}) {
  const toast = useToast();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const when = new Date(reply.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // Parse on display so later parser improvements also help old replies.
  const actions: ParsedAction[] = useMemo(() => parseSuggestedActions(reply.text).actions, [reply.text]);
  const taken = new Set([...(reply.addedActions ?? []), ...existingActionTexts].map(actionKey));
  return (
    <div className="rounded-3xl border border-white/[0.08] bg-[#0a0a0c]/90 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-bold tracking-[0.16em] text-dim uppercase">Coach reply · {when}</span>
        <button onClick={() => setOpen((o) => !o)} className="min-h-9 px-2 text-[14px] font-semibold" style={{ color: accent }}>
          {open ? 'Hide' : 'Read'}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap text-white/85">{reply.text}</p>
            <div className="mt-2 flex justify-end">
              <button
                className="min-h-9 px-2 text-[13px] text-faint"
                onClick={async () => {
                  await deleteCoachReply(reply.id);
                  toast({ message: 'Reply removed' });
                }}
              >
                Remove
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {extras}
      {actions.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-[12px] font-bold tracking-[0.16em] uppercase" style={{ color: accent }}>
            Suggested actions
          </div>
          {actions.map((a) => {
            const isAdded = taken.has(actionKey(a.text));
            const sensitive = settings ? findSensitive(a.text, settings.sensitiveTerms) : [];
            return (
              <div key={a.text} className="rounded-2xl bg-white/[0.03] px-3.5 py-2.5">
                <div className="flex items-center gap-3">
                  {a.burner && <MiniFlame burner={a.burner} size={18} />}
                  <span className={`flex-1 text-[15px] ${isAdded ? 'text-dim' : ''}`}>
                    {a.burner && <span className="sr-only">{BURNER_LABELS[a.burner]}: </span>}
                    {a.text}
                  </span>
                  {actionsWeek && (
                    <motion.button
                      whileTap={{ scale: 0.9 }}
                      disabled={isAdded}
                      onClick={async (e) => {
                        const x = e.clientX;
                        const y = e.clientY;
                        await addActionFromReply(reply.id, a.text, actionsWeek, a.burner);
                        celebrate({ kind: 'log', burner: (a.burner ?? 'family') as BurnerId, x, y });
                      }}
                      className="shrink-0 rounded-full px-3 py-1.5 text-[13px] font-bold"
                      style={isAdded ? { color: '#6ee7b7' } : { color: '#000', background: accent }}
                      aria-label={isAdded ? `${a.text} added` : `Add "${a.text}" to actions`}
                    >
                      {isAdded ? '✓ Added' : '+ Add'}
                    </motion.button>
                  )}
                </div>
                {sensitive.length > 0 && <p className="mt-1 text-[12px] text-amber-200/90">🔒 Mentions {sensitive.join(', ')}.</p>}
              </div>
            );
          })}
          {!actionsWeek && (
            <button
              className="text-[13px] text-faint"
              onClick={async () => {
                const ok = await copyText(actions.map((a) => `- ${a.burner ? `${BURNER_LABELS[a.burner]}: ` : ''}${a.text}`).join('\n'));
                toast({ message: ok ? 'Actions copied' : 'Copy was blocked. Press and hold the reply text to copy it.' });
              }}
            >
              Copy actions
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * If the app relaunched onto some other screen after you copied a packet, offer a way back to the
 * screen whose paste box is waiting. Rendered in the page flow (not floating), so it never covers a
 * screen's back button or the Settings gear. Dismissing hides it without cancelling the auto-open.
 */
export function PendingCoachBanner({ routeName }: { routeName: string }) {
  const [pending, setPending] = useState(() => readPending());
  const [hiddenFor, setHiddenFor] = useState<number | null>(null);
  useEffect(() => {
    const check = () => setPending(readPending());
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    window.addEventListener(PENDING_EVENT, check);
    const id = setInterval(check, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener(PENDING_EVENT, check);
      clearInterval(id);
    };
  }, []);
  // Re-read on every navigation so a reply saved on another screen hides it at once.
  useEffect(() => setPending(readPending()), [routeName]);
  const target = !pending
    ? null
    :
    pending.kind === 'weekly' ? { route: 'review', path: 'review' } :
    pending.kind === 'checkin' ? { route: 'checkin', path: 'checkin' } :
    pending.kind === 'quarter_setup' ? { route: 'setup', path: `setup/${pending.scope}` } :
    { route: "about", path: "about" };
  const visible = !!pending && !!target && hiddenFor !== pending.copiedAt && routeName !== target.route && routeName !== "onboarding" && routeName !== "reel";
  // While the banner shows it owns the top safe-area inset; screens below switch to a slim top padding
  // (see .has-banner in index.css) so the gap is not doubled.
  useEffect(() => {
    document.documentElement.classList.toggle("has-banner", visible);
    return () => document.documentElement.classList.remove("has-banner");
  }, [visible]);
  if (!visible || !target || !pending) return null;
  return (
    <div className="relative z-10 flex justify-center px-4" style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}>
      <div className="mt-2 flex w-full max-w-md items-center gap-2 rounded-2xl border border-ember/40 bg-[#141416]/95 py-1.5 pr-1.5 pl-4 shadow-2xl backdrop-blur-xl" role="status">
        <span className="flex-1 text-[14px]">You copied a coach packet. Ready to paste the reply?</span>
        <button onClick={() => { location.hash = `#/${target.path}`; }} className="min-h-10 rounded-xl bg-ember px-3 text-[14px] font-bold text-black">
          Paste
        </button>
        <button onClick={() => setHiddenFor(pending.copiedAt)} className="grid h-10 w-9 place-items-center text-faint" aria-label="Hide this reminder">
          ×
        </button>
      </div>
    </div>
  );
}
