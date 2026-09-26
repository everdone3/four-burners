import { describe, expect, it } from 'vitest';
import fixtures from './replyFixtures.json';
import { PACKET_END, PACKET_HEADER } from '../coach/constants';
import { REDACTED } from '../coach/redact';
import { actionKey, cleanAction, parseSuggestedActions, type ParsedAction } from '../coach/replies';
import type { BurnerId } from '../types';

// Special characters are built from code points so this file stays plain ASCII.
const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const EM = ch(0x2014);
const EN = ch(0x2013);
const BAR = ch(0x2015);
const NBSP = ch(0xa0);
const NNBSP = ch(0x202f);
const ZWSP = ch(0x200b);
const WJ = ch(0x2060);
const BOM = ch(0xfeff);
const LSEP = ch(0x2028);
const PSEP = ch(0x2029);
const BULLET = ch(0x2022);
const WHITE_BULLET = ch(0x25e6);
const SMALL_SQUARE = ch(0x25aa);
const BALLOT_CHECKED = ch(0x2611);
const BALLOT_EMPTY = ch(0x2610);
const CHECK_BUTTON = ch(0x2705);
const ELLIPSIS = ch(0x2026);
const LSQUO = ch(0x2018);
const RSQUO = ch(0x2019);
const LDQUO = ch(0x201c);
const RDQUO = ch(0x201d);
const POINT_RIGHT = ch(0x1f449);
const FIRE = ch(0x1f525);
const TARGET = ch(0x1f3af);
const PHONE = ch(0x1f4de);
const WOMAN_RUNNING_MEDIUM = ch(0x1f3c3, 0x1f3fd, 0x200d, 0x2640, 0xfe0f);
const FAMILY_ZWJ = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const KEYCAP_1 = `1${ch(0xfe0f, 0x20e3)}`;
const KEYCAP_2 = `2${ch(0xfe0f, 0x20e3)}`;
const DASHES = /[\u2013\u2014]/;

interface Fixture {
  name: string;
  reply: string;
  expected: string[];
}

const FIXTURES = fixtures as Fixture[];

function expectedFor(f: Fixture): ParsedAction[] {
  const m = /\[burners: ([^\]]+)\]$/.exec(f.name);
  const burners = m ? m[1].split(',').map((b) => b.trim()) : [];
  if (f.expected.length) expect(burners).toHaveLength(f.expected.length);
  return f.expected.map((text, i) => {
    const b = burners[i];
    return b && b !== 'none' ? { text, burner: b as BurnerId } : { text };
  });
}

const texts = (reply: string) => parseSuggestedActions(reply).actions.map((a) => a.text);
const act = (text: string, burner?: BurnerId): ParsedAction => (burner ? { text, burner } : { text });

/** A realistic packet (shape from docs/coach-design.md) that ends with the shared sentinel. */
const PACKET = [
  PACKET_HEADER,
  'Be my executive coach: candid, direct, warm, clearly in my corner. Plain text: no markdown.',
  'If END OF PACKET is missing, say the paste was cut off.',
  'End with 2 or 3 actions, each with a day or trigger, nothing after:',
  'Suggested actions:',
  '- Burner: action',
  '',
  'TYPE: weekly review, Sep 14 to 20, 2026 | Q3, 10d left',
  'LAST WK ACTIONS: 2/3 done; open: Text Jake about golf (Friends)',
  'FAMILY (High): behind, pace 60%, active 2/4',
  'WINS: Friday dinner happened',
  'MISSES: late Sundays',
  'ASK: Coach my week against my intents. Then Suggested actions.',
  PACKET_END,
].join('\n');

// ---------------------------------------------------------------------------------------------------

describe('reply fixtures (replyFixtures.json)', () => {
  it('has all 25 fixtures', () => {
    expect(FIXTURES).toHaveLength(25);
  });

  for (const f of FIXTURES) {
    it(f.name, () => {
      const r = parseSuggestedActions(f.reply);
      expect(r.actions).toStrictEqual(expectedFor(f));
      expect(r.isPacketEcho).toBe(false);
      if (f.expected.length) expect(r.source).not.toBe('none');
      else expect(r.source).toBe('none');
      for (const a of r.actions) expect(a.text).not.toMatch(DASHES);
    });
  }

  it('reports the expected source per fixture family', () => {
    const src = (i: number) => parseSuggestedActions(FIXTURES[i].reply).source;
    expect(src(0)).toBe('heading'); // Suggested actions:
    expect(src(3)).toBe('heading'); // Try this week:
    expect(src(4)).toBe('fallback'); // no heading, loose list
    expect(src(8)).toBe('weak-heading'); // Next week:
    expect(src(9)).toBe('fallback'); // Keep it small:
    expect(src(12)).toBe('heading'); // inline heading
    expect(src(14)).toBe('weak-heading'); // For next week:
    expect(src(17)).toBe('weak-heading'); // ## This week's focus
    expect(src(20)).toBe('fallback'); // partial paste, list only
  });

  it('whole-chat fixture also works with the packet end sentinel', () => {
    const f = FIXTURES.find((x) => x.name.startsWith('Whole chat copied'));
    expect(f).toBeDefined();
    const fixture = f as Fixture;
    const expected = expectedFor(fixture);
    // Sentinel variant 1: the full packet sits above the fixture text.
    const withPacket = parseSuggestedActions(`${PACKET}\n\n${fixture.reply}`);
    expect(withPacket.actions).toStrictEqual(expected);
    expect(withPacket.isPacketEcho).toBe(false);
    // Sentinel variant 2: the fixture's own packet part ends with the sentinel line.
    const cut = fixture.reply.indexOf('Steady week.');
    expect(cut).toBeGreaterThan(0);
    const inline = `${fixture.reply.slice(0, cut)}${PACKET_END}\n\n${fixture.reply.slice(cut)}`;
    expect(parseSuggestedActions(inline).actions).toStrictEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('packet echo and the END OF PACKET sentinel', () => {
  it('flags the packet pasted back on its own', () => {
    expect(parseSuggestedActions(PACKET)).toStrictEqual({ actions: [], source: 'none', isPacketEcho: true });
  });

  it('flags the packet followed by only a short remark', () => {
    const r = parseSuggestedActions(`${PACKET}\n\nThanks!`);
    expect(r.isPacketEcho).toBe(true);
    expect(r.actions).toEqual([]);
  });

  it('flags a cut-off packet (no sentinel) and never offers the template line', () => {
    const cutOff = PACKET.slice(0, PACKET.indexOf('TYPE:'));
    const r = parseSuggestedActions(cutOff);
    expect(r).toStrictEqual({ actions: [], source: 'none', isPacketEcho: true });
  });

  it('parses only what follows the last sentinel', () => {
    const reply = `${PACKET}\n\nSolid week.\n\nSuggested actions:\n- Health: Run Tuesday before the office\n- Family: Call Mom on Sunday`;
    const twice = `${PACKET}\n\nSuggested actions:\n- Friends: Old action from the first chat\n\n${reply}`;
    for (const text of [reply, twice]) {
      const r = parseSuggestedActions(text);
      expect(r.isPacketEcho).toBe(false);
      expect(r.source).toBe('heading');
      expect(r.actions).toStrictEqual([act('Run Tuesday before the office', 'health'), act('Call Mom on Sunday', 'family')]);
    }
  });

  it('is not an echo when real prose follows, even with no list', () => {
    const r = parseSuggestedActions(`${PACKET}\n\nThis was a strong week and I would keep the same plan going.`);
    expect(r.isPacketEcho).toBe(false);
    expect(r.actions).toEqual([]);
  });

  it('uses the sentinel even without the header (bottom half of the chat copied)', () => {
    const r = parseSuggestedActions(`ASK: Coach my week.\n${PACKET_END}\n\nSuggested actions:\n- Call Mom on Sunday`);
    expect(r.isPacketEcho).toBe(false);
    expect(texts(`ASK: Coach my week.\n${PACKET_END}\n\n- Old list item one\n\nSuggested actions:\n- Call Mom on Sunday`)).toEqual([
      'Call Mom on Sunday',
    ]);
  });

  it('tolerates a quoted or indented sentinel line', () => {
    const r = parseSuggestedActions(`${PACKET_HEADER}\nstuff\n>   ${PACKET_END}   \n\nNext steps:\n- Call Mom on Sunday`);
    expect(r.actions).toStrictEqual([act('Call Mom on Sunday')]);
  });

  it('a header in the middle of the text is not an echo, and the template line is never an action', () => {
    // Drop the final sentinel line (the preamble line that mentions END OF PACKET stays).
    const text = `Here is what I sent you:\n${PACKET.slice(0, PACKET.lastIndexOf(PACKET_END))}ASK: more`;
    const r = parseSuggestedActions(text);
    expect(r.isPacketEcho).toBe(false);
    expect(r.actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R2 normalization', () => {
  it('handles NBSP after rendered bullets, BOM, zero-width and other Unicode spaces', () => {
    const reply = `${BOM}Suggested actions${NBSP}\n${BULLET}${NBSP}Family:${NNBSP}Dinner at home Tuesday\n${BULLET}${NBSP}Health: Run${ZWSP} Thursday${WJ} before work`;
    expect(parseSuggestedActions(reply).actions).toStrictEqual([
      act('Dinner at home Tuesday', 'family'),
      act('Run Thursday before work', 'health'),
    ]);
  });

  it('handles CR-only, CRLF, and Unicode line and paragraph separators', () => {
    expect(texts('Actions:\r- Call Mom Sunday\r- Run Tuesday early')).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
    expect(texts(`Actions:${LSEP}- Call Mom Sunday${PSEP}- Run Tuesday early`)).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
  });

  it('expands tabs so tab-indented sub-bullets are children', () => {
    expect(texts('Suggested actions:\n-\tHealth: Run Tuesday early\n\t-\tkeep it slow and easy\n-\tCall Mom Sunday')).toEqual([
      'Run Tuesday early',
      'Call Mom Sunday',
    ]);
  });

  it('removes blockquote markers', () => {
    const r = parseSuggestedActions('> Suggested actions:\n> - Health: Run Tuesday early\n> > - Family: Call Mom Sunday');
    expect(r.actions).toStrictEqual([act('Run Tuesday early', 'health'), act('Call Mom Sunday', 'family')]);
  });

  it('treats code fences (with a language tag) as blank and keeps their content', () => {
    expect(texts('Copy this:\n\n```text\nNext steps:\n- Call Mom Sunday\n```\n~~~\n~~~')).toEqual(['Call Mom Sunday']);
  });

  it('a horizontal rule ends a list and is never an item', () => {
    expect(texts('Suggested actions:\n- Call Mom Sunday\n---\n- Sneaky second list item')).toEqual(['Call Mom Sunday']);
    expect(texts('- Call Mom Sunday\n- Run Tuesday early\n\n* * *\n\n___')).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
  });

  it('parses only the last 400 lines', () => {
    const filler = Array.from({ length: 450 }, (_, i) => `Note line ${i} about the week.`).join('\n');
    expect(parseSuggestedActions(`Suggested actions:\n- Call Mom Sunday\n${filler}`).actions).toEqual([]);
    const shortFiller = filler.split('\n').slice(0, 300).join('\n');
    expect(texts(`${shortFiller}\nSuggested actions:\n- Call Mom Sunday`)).toEqual(['Call Mom Sunday']);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R3 list items', () => {
  it('does not read italics, negative numbers, years, or rules as items', () => {
    const reply = '*Run Tuesday before work*\n-5 lbs by the end of the month\n2026. It was a good year\n---';
    expect(parseSuggestedActions(reply)).toStrictEqual({ actions: [], source: 'none', isPacketEcho: false });
  });

  it('accepts (n), keycap, plus, and dash markers', () => {
    expect(texts('Suggested actions:\n(1) Call Mom Sunday\n(2) Run Tuesday early')).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
    expect(texts(`Suggested actions:\n${KEYCAP_1} Book the sitter Friday\n${KEYCAP_2} Run Tuesday early`)).toEqual([
      'Book the sitter Friday',
      'Run Tuesday early',
    ]);
    expect(texts('Actions:\n+ Call Mom Sunday\n+ Run Tuesday early')).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
    expect(texts(`Actions:\n${EN} Call Mom Sunday\n${EM} Run Tuesday early`)).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
  });

  it('offers checked and unchecked boxes alike', () => {
    const reply = `Next steps:\n${BALLOT_CHECKED} Health: Run Tuesday early\n${CHECK_BUTTON} Family: Call Mom Sunday\n${BALLOT_EMPTY} Work: Clear the inbox Friday\n[x] Book the sitter Friday\n[ ] Text Jake about golf\n* [X] Plan Saturday with the kids`;
    expect(parseSuggestedActions(reply).actions).toStrictEqual([
      act('Run Tuesday early', 'health'),
      act('Call Mom Sunday', 'family'),
      act('Clear the inbox Friday', 'work'),
      act('Book the sitter Friday'),
      act('Text Jake about golf'),
    ]);
  });

  it('strips ZWJ and skin-tone emoji as one glyph and keeps inline emoji', () => {
    const reply = `Next steps:\n${WOMAN_RUNNING_MEDIUM} Run Tuesday before work\n${FAMILY_ZWJ} Pancakes with the kids ${FIRE} Sunday`;
    expect(texts(reply)).toEqual(['Run Tuesday before work', `Pancakes with the kids ${FIRE} Sunday`]);
  });

  it('a single emoji-led line counts under a heading, not on its own', () => {
    const headed = parseSuggestedActions(`Suggested actions\n${POINT_RIGHT} Call Mom on Sunday`);
    expect(headed.actions).toStrictEqual([act('Call Mom on Sunday')]);
    expect(headed.source).toBe('heading');
    expect(parseSuggestedActions(`${FIRE} Big week. Keep it going.`).actions).toEqual([]);
    expect(parseSuggestedActions(`Good week.\n\n${PHONE} Call Mom on Sunday`).actions).toEqual([]);
  });

  it('an emoji-led heading line is a heading, not an item', () => {
    const r = parseSuggestedActions(`${TARGET} Next week:\n${POINT_RIGHT} Call Mom Sunday\n${POINT_RIGHT} Run Tuesday before work`);
    expect(r.actions.map((a) => a.text)).toEqual(['Call Mom Sunday', 'Run Tuesday before work']);
    expect(r.source).toBe('weak-heading');
  });

  it('never reads a mid-text [...] or a redaction placeholder as a checkbox', () => {
    const reply = `Suggested actions:\n- Work: Prep the ${REDACTED} deck before Monday\n- ${REDACTED} follow-up call on Tuesday\n- Review notes [...] before Friday`;
    expect(parseSuggestedActions(reply).actions).toStrictEqual([
      act(`Prep the ${REDACTED} deck before Monday`, 'work'),
      act(`${REDACTED} follow-up call on Tuesday`),
      act('Review notes [...] before Friday'),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R4 grouping', () => {
  it('a numbering restart after a blank line starts a new block', () => {
    const list = '1. Call Mom Sunday\n2. Run Tuesday early\n\n1. Book the sitter Friday\n2. Text Jake about golf';
    expect(texts(`Suggested actions:\n${list}`)).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
    expect(texts(list)).toEqual(['Book the sitter Friday', 'Text Jake about golf']);
  });

  it('markdown auto-numbering (1. 1. 1.) in a loose list stays one block', () => {
    expect(texts('1. Call Mom Sunday\n\n1. Run Tuesday early\n\n1. Book the sitter Friday')).toEqual([
      'Call Mom Sunday',
      'Run Tuesday early',
      'Book the sitter Friday',
    ]);
  });

  it('a different marker family after a blank line starts a new block', () => {
    expect(texts('- Call Mom Sunday\n\n1. Run Tuesday early\n2. Book the sitter Friday')).toEqual([
      'Run Tuesday early',
      'Book the sitter Friday',
    ]);
  });

  it('joins a hard wrap and drops indented elaboration', () => {
    const reply = 'Suggested actions:\n- Walk 20 minutes after lunch on Tuesday\n  and Thursday\n- Call Mom Sunday.\n  she mentioned the garden\n- Book the sitter\n  Date night slipped twice';
    expect(texts(reply)).toEqual(['Walk 20 minutes after lunch on Tuesday and Thursday', 'Call Mom Sunday', 'Book the sitter']);
  });

  it('an unindented line ends the block even when it starts lowercase (no lazy continuation)', () => {
    expect(texts('Suggested actions:\n- Call Mom Sunday\n- Run Tuesday early\nand that is all for this week, you have got this')).toEqual([
      'Call Mom Sunday',
      'Run Tuesday early',
    ]);
  });

  it('keeps a loose numbered list with indented paragraphs as one block', () => {
    const reply = 'Suggested actions:\n\n1. **Book the sitter.**\n\n   Date night slipped twice.\n\n2. **Run Tuesday before work.**\n\n   Mornings survive travel.';
    const r = parseSuggestedActions(reply);
    expect(r.actions.map((a) => a.text)).toEqual(['Book the sitter', 'Run Tuesday before work']);
    expect(r.source).toBe('heading');
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R5 nesting', () => {
  it('applies the label rule to grandchildren and carries the burner down', () => {
    const reply = 'Suggested actions:\n- **Health**\n  - Pick one:\n    - Run Tuesday before work\n    - Swim Thursday at lunch\n- Family: Call Mom Sunday\n  - she misses you';
    expect(parseSuggestedActions(reply).actions).toStrictEqual([
      act('Run Tuesday before work', 'health'),
      act('Swim Thursday at lunch', 'health'),
      act('Call Mom Sunday', 'family'),
    ]);
  });

  it('inherits only from exactly one capitalized burner name', () => {
    expect(parseSuggestedActions('Actions:\n- Pick one for Health or Work:\n  - Walk after lunch Tuesday').actions).toStrictEqual([
      act('Walk after lunch Tuesday'),
    ]);
    expect(parseSuggestedActions('Actions:\n- Pick something that will work:\n  - Walk after lunch Tuesday').actions).toStrictEqual([
      act('Walk after lunch Tuesday'),
    ]);
    expect(parseSuggestedActions('Actions:\n- Health: pick one:\n  - Walk after lunch Tuesday').actions).toStrictEqual([
      act('Walk after lunch Tuesday', 'health'),
    ]);
  });

  it('treats secondary glyphs after a primary marker as children in rendered copies', () => {
    const reply = `Suggested actions\n${BULLET} Health: Run Tuesday early\n${WHITE_BULLET} Keep it easy and short\n${SMALL_SQUARE} Really easy\n${BULLET} Family: Call Mom Sunday`;
    expect(parseSuggestedActions(reply).actions).toStrictEqual([act('Run Tuesday early', 'health'), act('Call Mom Sunday', 'family')]);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R6 to R8 headings and block choice', () => {
  it('negative headings are never action headings', () => {
    for (const heading of ['What worked last week:', 'Wins this week:', 'Questions for next week:', '**What I noticed:**']) {
      const r = parseSuggestedActions(`${heading}\n- Early runs before the office\n- Dinner at home twice`);
      expect(r.actions, heading).toEqual([]);
      expect(r.source, heading).toBe('none');
    }
  });

  it("'Quick wins' is the allowed exception", () => {
    const r = parseSuggestedActions('Quick wins:\n- Call Mom Sunday\n- Book the sitter Friday');
    expect(r.source).toBe('heading');
    expect(r.actions).toHaveLength(2);
  });

  it('a negative list after a weak-headed list does not win', () => {
    const r = parseSuggestedActions('Next week:\n- Call Mom Sunday\n\nPatterns I noticed:\n- Late Sundays hurt Mondays');
    expect(r.actions).toStrictEqual([act('Call Mom Sunday')]);
    expect(r.source).toBe('weak-heading');
  });

  it('strong beats weak, the last strong block wins, and question-only blocks are skipped', () => {
    expect(texts('Suggested actions:\n- Call Mom Sunday\n\nFor next week:\n- Run Tuesday early')).toEqual(['Call Mom Sunday']);
    expect(texts('Suggested actions:\n- Call Mom Sunday\n\nSecond reply.\n\nSuggested actions:\n- Run Tuesday early')).toEqual([
      'Run Tuesday early',
    ]);
    const r = parseSuggestedActions('Suggested actions:\n- Try a walking call instead?\n\nFor next week:\n- Run Tuesday early');
    expect(r.actions).toStrictEqual([act('Run Tuesday early')]);
    expect(r.source).toBe('weak-heading');
  });

  it('splits an inline strong heading on semicolons and ordered inline enumerators, never on commas', () => {
    expect(texts('Suggested actions: 1) call Mom Sunday 2) run Tuesday at 7. then stretch (3) book the sitter, Friday')).toEqual([
      'Call Mom Sunday',
      'Run Tuesday at 7. then stretch',
      'Book the sitter, Friday',
    ]);
    expect(texts('Next steps: walk at 10:30 daily; call Mom Sunday')).toEqual(['Walk at 10:30 daily', 'Call Mom Sunday']);
  });

  it('ignores the inline remainder when a list follows the heading', () => {
    expect(texts('**Suggested actions:** here are three\n- Call Mom Sunday\n- Run Tuesday early')).toEqual([
      'Call Mom Sunday',
      'Run Tuesday early',
    ]);
  });

  it('a weak heading never uses its inline remainder', () => {
    expect(parseSuggestedActions('This week: rest and recover as much as you can.').actions).toEqual([]);
  });

  it('allows one short intro line between a heading and its list, not two', () => {
    const one = parseSuggestedActions('Suggested actions:\nPick two that fit the week.\n- Call Mom Sunday\n- Run Tuesday early');
    expect(one.source).toBe('heading');
    const two = parseSuggestedActions('Suggested actions:\nPick two.\nOr all of them.\n- Call Mom Sunday\n- Run Tuesday early');
    expect(two.source).toBe('fallback');
    expect(two.actions).toHaveLength(2);
  });

  it('a long lead-in ending with a colon and a strong keyword is a weak heading', () => {
    const r = parseSuggestedActions('Here are three small things you could try over the next seven days:\n- Call Mom Sunday\n- Run Tuesday early');
    expect(r.source).toBe('weak-heading');
  });

  it('a bare keyword line is a heading only when a list follows within one blank line', () => {
    expect(parseSuggestedActions('Next steps\n\n- Call Mom Sunday\n- Run Tuesday early').source).toBe('heading');
    expect(parseSuggestedActions('Next steps\n\nAll good.\n\n- Call Mom Sunday\n- Run Tuesday early').source).toBe('fallback');
  });

  it('reads markdown heading variants', () => {
    expect(parseSuggestedActions('## Suggested actions ##\n- Call Mom Sunday').source).toBe('heading');
    expect(parseSuggestedActions('Suggested actions\n=================\n- Call Mom Sunday').source).toBe('heading');
    expect(parseSuggestedActions('*Recommended actions (any order)*\n- Call Mom Sunday').source).toBe('heading');
    expect(parseSuggestedActions(`__Things to try__:\n- Call Mom Sunday`).source).toBe('heading');
    expect(parseSuggestedActions(`${LDQUO}The plan${RDQUO}:\n- Call Mom Sunday`).source).toBe('weak-heading');
  });

  it('fallback skips question lists and uses the last list before them', () => {
    const r = parseSuggestedActions('- Call Mom Sunday\n- Run Tuesday early\n\nThoughts:\n- Is Friday realistic?\n- Can you skip Monday?');
    expect(r.actions.map((a) => a.text)).toEqual(['Call Mom Sunday', 'Run Tuesday early']);
    expect(r.source).toBe('fallback');
  });

  it('fallback stops on a pronoun-led list instead of looking further back', () => {
    expect(texts('- Call Mom Sunday\n- Run Tuesday early\n\nSo:\n- It was a hard week\n- You still ran twice\n- Call Mom Sunday')).toEqual([]);
  });

  it('fallback stops on a negative lead-in even if it is long', () => {
    expect(texts('Here is what I noticed across the last three weeks of your logs:\n- Runs dropped after travel\n- Dinner at home held')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R9 and R10 cleaning', () => {
  it('keeps the period of a trailing a.m., p.m., or etc.', () => {
    expect(texts('Actions:\n- Health: Run at 6 a.m.\n- Call Mom at 7 p.m..\n- Pack snacks, water, etc.')).toEqual([
      'Run at 6 a.m.',
      'Call Mom at 7 p.m.',
      'Pack snacks, water, etc.',
    ]);
  });

  it('respects Dr., St., a.m., and decimals when splitting long items', () => {
    expect(
      cleanAction('- Book the follow-up with Dr. Patel for Thursday before the St. Louis trip at 6 a.m. Friday, and bring the labs. It matters.'),
    ).toBe('Book the follow-up with Dr. Patel for Thursday before the St. Louis trip at 6 a.m. Friday, and bring the labs');
    expect(cleanAction('- Run 2.5 miles on Tuesday and Thursday mornings before the office, then stretch for ten minutes. It adds up fast.')).toBe(
      'Run 2.5 miles on Tuesday and Thursday mornings before the office, then stretch for ten minutes',
    );
    expect(cleanAction('- Plan B is fine too. Try the short loop on Tuesday and the long one on Saturday with the kids and dog along.')).toBe(
      'Plan B is fine too',
    );
  });

  it('leaves intra-word hyphens, negative numbers, and digit ranges alone', () => {
    expect(cleanAction('- Do the check-in after the red-eye, a 30-minute walk and a two-line text')).toBe(
      'Do the check-in after the red-eye, a 30-minute walk and a two-line text',
    );
    expect(cleanAction('- Block 8 - 10 on Monday')).toBe('Block 8-10 on Monday');
    expect(cleanAction(`- Block 8${EN}10 on Monday`)).toBe('Block 8-10 on Monday');
    expect(cleanAction(`- Block 8 ${EN} 10 on Monday`)).toBe('Block 8-10 on Monday');
    expect(cleanAction('- Hold at -5 lbs through Friday')).toBe('Hold at -5 lbs through Friday');
  });

  it('turns every other dash into a comma and never emits an em or en dash', () => {
    expect(cleanAction(`- Run Tuesday ${EN} Thursday counts too`)).toBe('Run Tuesday, Thursday counts too');
    expect(cleanAction('- Run Tuesday -- even short')).toBe('Run Tuesday, even short');
    expect(cleanAction('- Run Tuesday--even short')).toBe('Run Tuesday, even short');
    expect(cleanAction(`- Run Tuesday${BAR}even short`)).toBe('Run Tuesday, even short');
    expect(cleanAction(`- Call Mom Sunday ${EM}`)).toBe('Call Mom Sunday');
    expect(cleanAction(`- Call Mom Sunday, ${EM} no phone`)).toBe('Call Mom Sunday, no phone');
    expect(cleanAction(`- Health ${EM} Run Tuesday`)).toBe('Run Tuesday');
    const heavy = `Actions:\n- A${EM}B${EN}C ${EM} D ${EN} E -- F\n- Tue${EN}Thu ${EM}${EM} walk`;
    for (const a of parseSuggestedActions(heavy).actions) expect(a.text).not.toMatch(DASHES);
  });

  it('keeps redaction placeholders exactly as written', () => {
    const r = parseSuggestedActions(`Suggested actions:\n- Work: Send the ${REDACTED} memo Monday.\n- Family: Ask ${REDACTED} about Sunday`);
    expect(r.actions).toStrictEqual([act(`Send the ${REDACTED} memo Monday`, 'work'), act(`Ask ${REDACTED} about Sunday`, 'family')]);
  });

  it("does not tag 'work out Tuesday' or 'Work-life' as the Work burner", () => {
    expect(parseSuggestedActions('Actions:\n- work out Tuesday and Thursday\n- Work-life check on Sunday night\n- Work out: gym at lunch').actions).toStrictEqual([
      act('Work out Tuesday and Thursday'),
      act('Work-life check on Sunday night'),
      act('Work out: gym at lunch'),
    ]);
  });

  it('reads burner tags once, in any case, with colon, spaced dash, or pipe, and as a suffix', () => {
    expect(parseSuggestedActions('Actions:\n- HEALTH: Three runs: Tue, Thu, Sat\n- friends - Text Jake Monday\n- Family | Pancakes Sunday\n- Run Tuesday early (Health)\n- Clear the inbox Friday [Work].').actions).toStrictEqual([
      act('Three runs: Tue, Thu, Sat', 'health'),
      act('Text Jake Monday', 'friends'),
      act('Pancakes Sunday', 'family'),
      act('Run Tuesday early', 'health'),
      act('Clear the inbox Friday', 'work'),
    ]);
  });

  it('handles bold lead phrases', () => {
    expect(parseSuggestedActions('Actions:\n- **Health:** Run Tuesday early\n- **Family** - Call Mom Sunday\n- **Call Jake.** He misses golf\n- **Protect mornings**: no meetings before 9\n- **Book the sitter** for Friday night').actions).toStrictEqual([
      act('Run Tuesday early', 'health'),
      act('Call Mom Sunday', 'family'),
      act('Call Jake'),
      act('Protect mornings: no meetings before 9'),
      act('Book the sitter for Friday night'),
    ]);
  });

  it('strips leading qualifiers, markdown links, code, strike, and emphasis but not URLs', () => {
    expect(cleanAction('- Bonus: Family: Call Mom Sunday')).toBe('Call Mom Sunday');
    expect(cleanAction('- Optional: run Thursday too')).toBe('Run Thursday too');
    expect(cleanAction('- Read [the sleep guide](https://example.com/a_b) before *Sunday*')).toBe('Read the sleep guide before Sunday');
    expect(cleanAction('- Try `focus mode` on ~~Monday~~ _Tuesday_')).toBe('Try focus mode on Monday Tuesday');
    expect(cleanAction('- Bookmark https://example.com/some_path_here/*x* tonight')).toBe('Bookmark https://example.com/some_path_here/*x* tonight');
    expect(cleanAction('- Rename snake_case_file tonight')).toBe('Rename snake_case_file tonight');
  });

  it('removes wrapping quotes and trailing punctuation, and capitalizes a lowercase first word', () => {
    expect(cleanAction('- "Call Mom Sunday."')).toBe('Call Mom Sunday');
    expect(cleanAction(`- ${LDQUO}call Mom Sunday${RDQUO}`)).toBe('Call Mom Sunday');
    expect(cleanAction(`- ${LSQUO}Walk after lunch${RSQUO};`)).toBe('Walk after lunch');
    expect(cleanAction('- Call Mom Sunday...')).toBe('Call Mom Sunday');
    expect(cleanAction(`- Call Mom Sunday${ELLIPSIS}`)).toBe('Call Mom Sunday');
    expect(cleanAction('- iPhone stays in the kitchen')).toBe('iPhone stays in the kitchen');
    expect(cleanAction('- call Mom')).toBe('Call Mom');
  });

  it('cuts items over 120 characters at a word boundary with an ellipsis', () => {
    const long = `- ${'Walk around the reservoir loop with the kids and the dog after dinner on Tuesday and Thursday '.repeat(2)}`;
    const out = cleanAction(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('...')).toBe(true);
    expect(out).toMatch(/^Walk around the reservoir loop/);
    expect(out.slice(0, -3)).not.toMatch(/\s$/);
  });

  it('cleanAction handles raw lines with markers and checkboxes', () => {
    expect(cleanAction('1. **Book the sitter for Friday.** Date night slipped twice.')).toBe('Book the sitter for Friday');
    expect(cleanAction('- [x] Health: Walk 20 minutes on travel days')).toBe('Walk 20 minutes on travel days');
    expect(cleanAction(`${BULLET}${NBSP}call Mom ${EM} Sunday`)).toBe('Call Mom, Sunday');
    expect(cleanAction(`${POINT_RIGHT} Book the sitter`)).toBe('Book the sitter');
    expect(cleanAction(`- **${FIRE} Book the sitter**`)).toBe('Book the sitter');
    expect(cleanAction('')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------

describe('R11 validity, R12 dedupe, cap of 5', () => {
  it('drops questions, one-word items, labels, and meta lines even under a strong heading', () => {
    const reply = 'Suggested actions:\n- Pick two:\n- Suggested actions\n- Rest\n- ???\n- 12:30\n- Health:\n- Any of these\n- Here are three\n- Call Mom Sunday\n- Try a walking call instead?\n- Walk more?)';
    expect(texts(reply)).toEqual(['Call Mom Sunday']);
  });

  it('dedupes by key and keeps the first occurrence, taking a later burner', () => {
    // Punctuation and case do not matter for the key; an existing burner is never overwritten.
    const reply = 'Actions:\n- Call Mom Sunday\n- Family: call mom sunday.\n- Health: Run Tuesday\n- Work: run tuesday!\n- Walk after lunch';
    expect(parseSuggestedActions(reply).actions).toStrictEqual([
      act('Call Mom Sunday', 'family'),
      act('Run Tuesday', 'health'),
      act('Walk after lunch'),
    ]);
  });

  it('caps at 5 after dedupe, in reply order', () => {
    const items = Array.from({ length: 8 }, (_, i) => `- Action number ${i + 1} for the week`).join('\n');
    expect(texts(`Suggested actions:\n- Action number 1 for the week\n${items}`)).toEqual([
      'Action number 1 for the week',
      'Action number 2 for the week',
      'Action number 3 for the week',
      'Action number 4 for the week',
      'Action number 5 for the week',
    ]);
  });

  it('actionKey lowercases, straightens quotes, drops the burner tag and punctuation', () => {
    expect(actionKey(`Health: Call Mom${RSQUO}s cell, Sunday!`)).toBe('call moms cell sunday');
    expect(actionKey("call mom's cell Sunday")).toBe('call moms cell sunday');
    expect(actionKey('Run Tuesday (Health)')).toBe('run tuesday');
    expect(actionKey('  Lights out by 10:30   ON weeknights.  ')).toBe('lights out by 1030 on weeknights');
    expect(actionKey('Work out Tuesday')).toBe('work out tuesday');
    expect(actionKey(`Prep the ${REDACTED} deck`)).toBe('prep the redacted deck');
    expect(actionKey(`Tue ${EM} Thu`)).toBe('tue thu');
    expect(actionKey('')).toBe('');
  });

  it('parsed actions always match their own key (UI can hide already-added chips)', () => {
    for (const f of FIXTURES) {
      for (const a of parseSuggestedActions(f.reply).actions) expect(actionKey(a.text)).toBe(actionKey(a.text.toUpperCase()));
    }
  });
});

// ---------------------------------------------------------------------------------------------------

describe('robustness and performance', () => {
  it('never throws on empty or non-string input', () => {
    const empty = { actions: [], source: 'none', isPacketEcho: false };
    for (const input of ['', '   ', '\n\n\n', '-', '1.', '[ ]', '```', undefined, null, 42]) {
      expect(parseSuggestedActions(input as unknown as string)).toStrictEqual(empty);
    }
    expect(actionKey(undefined as unknown as string)).toBe('');
    expect(cleanAction(null as unknown as string)).toBe('');
  });

  it('parses 5,000 lines in under 50 ms', () => {
    parseSuggestedActions(FIXTURES[0].reply); // warm up
    const body = Array.from({ length: 5000 }, (_, i) =>
      i % 7 === 0 ? `- Observation ${i}: energy **up** at 10:30 -- fine` : i % 5 === 0 ? `Note ${i}: this week went well.` : `Line ${i} of a very long pasted chat, with words.`,
    ).join('\n');
    const reply = `${body}\n\nSuggested actions:\n- Health: Run Tuesday early\n- Family: Call Mom Sunday`;
    expect(reply.split('\n').length).toBeGreaterThanOrEqual(5000);
    const t0 = performance.now();
    const r = parseSuggestedActions(reply);
    const ms = performance.now() - t0;
    expect(r.actions).toStrictEqual([act('Run Tuesday early', 'health'), act('Call Mom Sunday', 'family')]);
    expect(ms).toBeLessThan(50);
  });

  it('stays fast on pathological long lines', () => {
    const nasty = [
      '**a'.repeat(40000),
      '['.repeat(100000),
      `- ${'* '.repeat(50000)}`,
      `- ${'a - '.repeat(30000)}`,
      `- ${'_a'.repeat(50000)}`,
      `- ${'.'.repeat(100000)}`,
      `Suggested actions: ${'1) 1) '.repeat(20000)}`,
      `${'a'.repeat(100000)}. B`,
    ];
    for (const line of nasty) {
      const t0 = performance.now();
      expect(() => parseSuggestedActions(`${line}\n${line}`)).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(200);
    }
    const t0 = performance.now();
    parseSuggestedActions(Array.from({ length: 5000 }, (_, i) => `${'  '.repeat(i % 40)}- item ${i}`).join('\n'));
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('is deterministic', () => {
    for (const f of FIXTURES) expect(parseSuggestedActions(f.reply)).toStrictEqual(parseSuggestedActions(f.reply));
  });
});
