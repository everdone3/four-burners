// Adversarial review of src/domain/coach/replies.ts: new realistic Claude replies (markdown source and
// rendered iOS copies), one regression test per defect found, and ReDoS probes on pathological input.
import { describe, expect, it } from 'vitest';
import { PACKET_END, PACKET_HEADER } from '../coach/constants';
import { REDACTED } from '../coach/redact';
import { actionKey, cleanAction, parseSuggestedActions, type ParsedAction, type ParsedReply } from '../coach/replies';
import type { BurnerId } from '../types';

// Special characters are built from code points so this file stays plain ASCII.
const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const EM = ch(0x2014);
const EN = ch(0x2013);
const NBSP = ch(0xa0);
const RSQUO = ch(0x2019);
const BULLET = ch(0x2022);
const WHITE_BULLET = ch(0x25e6);
const POINT_RIGHT = ch(0x1f449);
const RUNNER = ch(0x1f3c3);
const PHONE = ch(0x1f4de);
const MUSCLE = ch(0x1f4aa);
const RAISED_HANDS = ch(0x1f64c);
const TARGET = ch(0x1f3af);
const DASHES = /[\u2013\u2014]/;

const act = (text: string, burner?: BurnerId): ParsedAction => (burner ? { text, burner } : { text });
const parse = (reply: string): ParsedReply => parseSuggestedActions(reply);

/** The real shared preamble from docs/coach-design.md, followed by a weekly body and the END line. */
const REAL_PACKET = [
  PACKET_HEADER,
  'Be my executive coach: candid, direct, warm, clearly in my corner. Ground every point in my numbers and words; do not recap. Under 180 words plus actions. Plain text: no markdown, filler, generic motivation, em or en dashes. At most one question.',
  'Judge each burner by its intent: light activity on a Low burner is on track.',
  'Crunch days (travel, deals) have lower expectations built in: do not pile on; suggest the smallest move that keeps a burner lit.',
  'If a goal is behind or slipping, remind me of its why, in my words.',
  `Work: habits and priorities only. Never ask about clients, deals, or firms, or guess what ${REDACTED} hides.`,
  'pace = % of where my intent expects me by now. active x/y = active days vs expected.',
  'If END OF PACKET is missing, say the paste was cut off.',
  'End with 2 or 3 actions, each with a day or trigger, nothing after:',
  'Suggested actions:',
  '- Burner: action',
  '',
  'TYPE: weekly review, Sep 14 to 20, 2026 | Q3, 10d left',
  'ME: Dad of two, runner, leads deals for a wealth firm.',
  'DAYS (energy 1 to 5): Mon 3, Tue 2, Wed 2 crunch, Thu 4, Fri 3',
  'WEEK: check-ins 5/5, streak 9d (best 14), energy 2.8 (prior wk 3.4), progress 61, consistency 70',
  'LAST WK ACTIONS: 2/3 done; open: Text Jake about golf (Friends)',
  'FAMILY (High): behind, pace 60%, active 2/4',
  'Date night: wk 0/1, pace 50% BEHIND | why: how we stay a team | when: Fridays',
  'HEALTH (Steady): on track, pace 95%, active 3/3',
  'WINS: Friday dinner happened',
  'MISSES: late Sundays',
  'ASK: Coach my week against my intents: what held up, the one pattern that matters most, and what to let go. Then Suggested actions.',
  PACKET_END,
].join('\n');

// ---------------------------------------------------------------------------------------------------

describe('new realistic replies', () => {
  const cases: { name: string; reply: string; expected: ParsedAction[]; source: ParsedReply['source'] }[] = [
    {
      name: "'Your moves for next week:' heading with trailing encouragement",
      reply: [
        'Honest read: Health carried the week and Family paid for it. Four late nights, one dinner at home, energy at 2 by Thursday.',
        '',
        "You wrote that dinner is how you stay close to the kids. That's the why to protect.",
        '',
        'Your moves for next week:',
        '- Family: Home for dinner Tuesday and Thursday',
        '- Health: Keep the Saturday long run, even if short',
        '- Work: Leave the laptop at the office Wednesday',
        '',
        "You've got this.",
      ].join('\n'),
      expected: [
        act('Home for dinner Tuesday and Thursday', 'family'),
        act('Keep the Saturday long run, even if short', 'health'),
        act('Leave the laptop at the office Wednesday', 'work'),
      ],
      source: 'heading',
    },
    {
      name: 'rendered copy: NBSP bullets, burner labels with unindented white-bullet children, question at the end',
      reply: [
        'Health is ahead, Family is behind.',
        '',
        'Your moves for next week:',
        `${BULLET}${NBSP}Family`,
        `${WHITE_BULLET}${NBSP}Book the sitter for Friday`,
        `${WHITE_BULLET}${NBSP}Home for dinner Tuesday and Thursday`,
        `${BULLET}${NBSP}Health`,
        `${WHITE_BULLET}${NBSP}Run Tuesday before the office`,
        '',
        'Which of these feels hardest to protect?',
      ].join('\n'),
      expected: [
        act('Book the sitter for Friday', 'family'),
        act('Home for dinner Tuesday and Thursday', 'family'),
        act('Run Tuesday before the office', 'health'),
      ],
      source: 'heading',
    },
    {
      name: 'bold section headings, a tagged observation list before the actions',
      reply: [
        '**What held up**',
        '- Health: 3 of 4 runs, ahead of pace',
        '- Work: stayed at Steady like you planned',
        '',
        '**The pattern that matters**',
        'Late Sundays wreck Mondays. Three of four weeks.',
        '',
        '**Suggested actions:**',
        '- Work: Laptop closed by 8 on Sunday',
        '- Family: Sunday pancakes with the kids, phone upstairs',
      ].join('\n'),
      expected: [act('Laptop closed by 8 on Sunday', 'work'), act('Sunday pancakes with the kids, phone upstairs', 'family')],
      source: 'heading',
    },
    {
      name: 'numbered actions followed by a closing question line',
      reply: [
        'Solid week. The streak held through the red-eye.',
        '',
        'Suggested actions:',
        '1. Family: Call Mom on Sunday afternoon',
        '2. Friends: Text Jake about golf on Monday',
        '',
        'One question: what would make Friday a real stop this week?',
      ].join('\n'),
      expected: [act('Call Mom on Sunday afternoon', 'family'), act('Text Jake about golf on Monday', 'friends')],
      source: 'heading',
    },
    {
      name: 'whole chat copied: the real packet (with its template list) above the reply',
      reply: `${REAL_PACKET}\n\nClaude\n\nGot it: week of Sep 14, Crunch on Wed.\n\nFamily is the burner to rescue.\n\nSuggested actions:\n- Family: Book the sitter for Friday\n- Friends: Text Jake about golf on Monday`,
      expected: [act('Book the sitter for Friday', 'family'), act('Text Jake about golf on Monday', 'friends')],
      source: 'heading',
    },
    {
      name: 'redaction placeholders inside and at the start of actions stay exactly as written',
      reply: [
        `Work is carrying the ${REDACTED} close and that's fine for two weeks.`,
        '',
        'Suggested actions:',
        `- Work: Block 8 to 10 Monday for ${REDACTED} prep`,
        `- ${REDACTED} recap call Tuesday, then stop for the day`,
        `- Family: Tell Sarah the ${REDACTED} dates tonight`,
      ].join('\n'),
      expected: [
        act(`Block 8 to 10 Monday for ${REDACTED} prep`, 'work'),
        act(`${REDACTED} recap call Tuesday, then stop for the day`),
        act(`Tell Sarah the ${REDACTED} dates tonight`, 'family'),
      ],
      source: 'heading',
    },
    {
      name: 'markdown H3 without a colon, numbered items with bold burner leads and colons in the text',
      reply: [
        '### Your moves for next week',
        '',
        '1. **Family:** Home by 6:30 on Tuesday and Thursday',
        '2. **Health:** Three runs: Tue, Thu, Sat',
        '3. **Work:** Decline one recurring meeting',
        '',
        'Proud of how you handled Denver. Keep going.',
      ].join('\n'),
      expected: [
        act('Home by 6:30 on Tuesday and Thursday', 'family'),
        act('Three runs: Tue, Thu, Sat', 'health'),
        act('Decline one recurring meeting', 'work'),
      ],
      source: 'heading',
    },
    {
      name: 'rendered numbered list whose sub-bullets lost their indent',
      reply: [
        'Your moves for next week:',
        `1.${NBSP}Family: Book the sitter for Friday`,
        `${WHITE_BULLET}${NBSP}Date night slipped twice`,
        `2.${NBSP}Health: Run Tuesday and Thursday`,
        `${WHITE_BULLET}${NBSP}Mornings survive travel`,
        `3.${NBSP}Work: Decline one recurring meeting`,
        '',
        'You know how to do this.',
      ].join('\n'),
      expected: [
        act('Book the sitter for Friday', 'family'),
        act('Run Tuesday and Thursday', 'health'),
        act('Decline one recurring meeting', 'work'),
      ],
      source: 'heading',
    },
    {
      name: 'bold heading, a pick-two intro line, bold burner leads, closing remark',
      reply: [
        '**Suggested actions:**',
        'Pick the two that fit the week.',
        '',
        '- **Family:** Book the sitter for Friday',
        '- **Health:** Run Tuesday and Thursday before the office',
        '- **Work:** Leave the laptop at the office one night',
        '',
        'Whichever you pick, tell me Sunday how it went.',
      ].join('\n'),
      expected: [
        act('Book the sitter for Friday', 'family'),
        act('Run Tuesday and Thursday before the office', 'health'),
        act('Leave the laptop at the office one night', 'work'),
      ],
      source: 'heading',
    },
    {
      name: 'mid-quarter check-in heading for the next 7 days',
      reply: [
        'You have 10 days left and two goals are still realistic.',
        '',
        'Suggested actions for the next 7 days:',
        '- Health: Two runs, Tuesday and Saturday',
        '- Family: Book the sitter for Friday',
        '- Work: Shrink the pipeline goal to 3 calls',
      ].join('\n'),
      expected: [
        act('Two runs, Tuesday and Saturday', 'health'),
        act('Book the sitter for Friday', 'family'),
        act('Shrink the pipeline goal to 3 calls', 'work'),
      ],
      source: 'heading',
    },
    {
      name: 'a question slipped in as the last list item',
      reply: 'Suggested actions:\n- Family: Book the sitter for Friday\n- Health: Run Tuesday before work\n- Which of these feels hardest?',
      expected: [act('Book the sitter for Friday', 'family'), act('Run Tuesday before work', 'health')],
      source: 'heading',
    },
    {
      name: 'an emoji-led sign-off after a blank line below a dash list',
      reply: `Suggested actions:\n- Family: Book the sitter for Friday\n- Health: Run Tuesday before work\n\n${RAISED_HANDS} Rooting for you.`,
      expected: [act('Book the sitter for Friday', 'family'), act('Run Tuesday before work', 'health')],
      source: 'heading',
    },
    {
      name: 'reply pasted as a blockquote',
      reply: '> **Suggested actions:**\n> - Family: Book the sitter for Friday\n> - Health: Run Tuesday before work',
      expected: [act('Book the sitter for Friday', 'family'), act('Run Tuesday before work', 'health')],
      source: 'heading',
    },
    {
      name: 'two replies in one paste: the revised list wins',
      reply: [
        'Suggested actions:',
        '- Family: Old one from first chat',
        '- Health: Old run plan',
        '',
        'Okay, revised for the travel week.',
        '',
        'Your moves for next week:',
        '- Family: FaceTime the kids Wednesday',
        '- Health: Hotel gym 20 minutes Tuesday',
      ].join('\n'),
      expected: [act('FaceTime the kids Wednesday', 'family'), act('Hotel gym 20 minutes Tuesday', 'health')],
      source: 'heading',
    },
    {
      name: 'day-labelled items keep their colons and stay untagged',
      reply: 'Your moves for next week:\n- Tuesday: run before the office\n- Friday: date night, sitter booked by Wednesday\n- Sunday: laptop closed by 8',
      expected: [act('Tuesday: run before the office'), act('Friday: date night, sitter booked by Wednesday'), act('Sunday: laptop closed by 8')],
      source: 'heading',
    },
    {
      name: 'indented italic why lines are elaboration',
      reply: 'Suggested actions:\n- Family: Book the sitter for Friday\n  _Why: date night is how you stay a team._\n- Health: Run Tuesday before work',
      expected: [act('Book the sitter for Friday', 'family'), act('Run Tuesday before work', 'health')],
      source: 'heading',
    },
    {
      name: 'en dash tags and an en dash range',
      reply: `Suggested actions:\n- Family ${EN} Book the sitter for Friday\n- Health ${EN} Run 3${EN}4 miles Tuesday`,
      expected: [act('Book the sitter for Friday', 'family'), act('Run 3-4 miles Tuesday', 'health')],
      source: 'heading',
    },
    {
      name: 'loose emoji list under a weak heading (blank lines between items)',
      reply: `For next week:\n\n${POINT_RIGHT} Book the sitter for Friday\n\n${RUNNER} Two runs before 7 on Tuesday and Thursday\n\n${PHONE} Call Jake on the drive home Wednesday`,
      expected: [
        act('Book the sitter for Friday'),
        act('Two runs before 7 on Tuesday and Thursday'),
        act('Call Jake on the drive home Wednesday'),
      ],
      source: 'weak-heading',
    },
  ];

  it('covers at least 12 new replies', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const c of cases) {
    it(c.name, () => {
      const r = parse(c.reply);
      expect(r.actions).toStrictEqual(c.expected);
      expect(r.source).toBe(c.source);
      expect(r.isPacketEcho).toBe(false);
      for (const a of r.actions) expect(a.text).not.toMatch(DASHES);
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// One block per defect. Each of these failed against the original implementation.

describe('defect: a closing remark with a keyword before a colon replaced the real list', () => {
  const list = '- Family: Book the sitter for Friday\n- Health: Run Tuesday and Thursday before the office';
  const expected = [act('Book the sitter for Friday', 'family'), act('Run Tuesday and Thursday before the office', 'health')];

  it('after a strong-headed list', () => {
    for (const remark of [
      'These actions are deliberately small: travel weeks punish ambition.',
      'If the week blows up, try this: keep only the Friday sitter.',
      "Quick note on the actions: they're small on purpose.",
    ]) {
      const r = parse(`Good week.\n\nSuggested actions:\n${list}\n\n${remark}`);
      expect(r.actions, remark).toStrictEqual(expected);
      expect(r.source, remark).toBe('heading');
    }
  });

  it('after a weak-headed list', () => {
    const r = parse('Next week:\n- Book the sitter for Friday\n- Run Tuesday before work\n\nAll three moves fit around Denver: none needs more than 20 minutes.');
    expect(r.actions).toStrictEqual([act('Book the sitter for Friday'), act('Run Tuesday before work')]);
    expect(r.source).toBe('weak-heading');
  });

  it('after an unheaded (fallback) list, when the remark opens with a pronoun', () => {
    const r = parse('Good week.\n\n- Book the sitter for Friday\n- Run Tuesday before work\n\nThese actions are deliberately small: they fit around Denver.');
    expect(r.actions).toStrictEqual([act('Book the sitter for Friday'), act('Run Tuesday before work')]);
    expect(r.source).toBe('fallback');
  });

  it('a remark before the list never mattered and still does not', () => {
    const r = parse(`Travel week.\n\nThese actions are deliberately small: travel weeks punish ambition.\n\nSuggested actions:\n${list}`);
    expect(r.actions).toStrictEqual(expected);
  });

  it('the inline form still works when there is no list', () => {
    expect(parse('Rest week.\nNext steps: sleep in Saturday; call Mom Sunday.').actions).toStrictEqual([
      act('Sleep in Saturday'),
      act('Call Mom Sunday'),
    ]);
    const r = parse('- You ran three times\n- You skipped Friday dinner\n\nSuggested actions: book the sitter Friday; run Tuesday early.');
    expect(r.actions).toStrictEqual([act('Book the sitter Friday'), act('Run Tuesday early')]);
    expect(r.source).toBe('heading');
  });
});

describe('defect: pronoun-led inline remainders became actions', () => {
  it('drops remark parts and keeps real ones', () => {
    expect(parse("Suggested actions: it's a rest week; you've earned it.")).toStrictEqual({
      actions: [],
      source: 'none',
      isPacketEcho: false,
    });
    expect(parse('Suggested actions: call Mom Sunday; you could also run Tuesday').actions).toStrictEqual([act('Call Mom Sunday')]);
  });
});

describe('defect: an emoji-led closing line was offered as an action', () => {
  const head = `Big week.\n\nYour moves for next week:\n${POINT_RIGHT} Family: Book the sitter for Friday\n${RUNNER} Health: Run Tuesday before work`;
  const expected = [act('Book the sitter for Friday', 'family'), act('Run Tuesday before work', 'health')];

  it('directly after a tight emoji list', () => {
    expect(parse(`${head}\n${MUSCLE} You've got this.`).actions).toStrictEqual(expected);
  });

  it('after a blank line below a tight emoji list', () => {
    expect(parse(`${head}\n\n${MUSCLE} You've got this.`).actions).toStrictEqual(expected);
    expect(parse(`${head}\n\n${RAISED_HANDS} Rooting for you.`).actions).toStrictEqual(expected);
  });

  it('at the end of a loose emoji list', () => {
    const r = parse(`For next week:\n\n${POINT_RIGHT} Book the sitter for Friday\n\n${RUNNER} Two runs before 7 on Tuesday\n\n${MUSCLE} You've got this.`);
    expect(r.actions).toStrictEqual([act('Book the sitter for Friday'), act('Two runs before 7 on Tuesday')]);
  });

  it('inside an unheaded emoji run (fallback)', () => {
    const r = parse(`Big week.\n\n${POINT_RIGHT} Book the sitter for Friday\n${RUNNER} Two runs before 7 on Tuesday\n${RAISED_HANDS} I'm proud of how you handled Denver.`);
    expect(r.actions).toStrictEqual([act('Book the sitter for Friday'), act('Two runs before 7 on Tuesday')]);
    expect(r.source).toBe('fallback');
  });

  it('an emoji-led heading line and emoji actions still work', () => {
    const r = parse(`${TARGET} Next week:\n${POINT_RIGHT} Call Mom Sunday\n${POINT_RIGHT} Run Tuesday before work`);
    expect(r.actions.map((a) => a.text)).toEqual(['Call Mom Sunday', 'Run Tuesday before work']);
  });
});

describe('defect: a bold burner label with no separator was glued into the text', () => {
  it('reads **Family** Book the sitter as a Family tag', () => {
    expect(parse('Suggested actions:\n- **Family** Book the sitter for Friday\n- **Friends** Text Jake Monday about golf').actions).toStrictEqual([
      act('Book the sitter for Friday', 'family'),
      act('Text Jake Monday about golf', 'friends'),
    ]);
  });

  it("leaves '**Work** out Tuesday' as a sentence", () => {
    expect(parse('Suggested actions:\n- **Work** out Tuesday and Thursday at lunch').actions).toStrictEqual([
      act('Work out Tuesday and Thursday at lunch'),
    ]);
  });
});

describe("defect: burner labels carrying the packet's intent suffix ('FAMILY (High)')", () => {
  it('a label parent moves its children up with the burner instead of becoming a junk chip', () => {
    const reply = 'Suggested actions:\n- **Family (High)**\n  - Book the sitter for Friday\n  - Home for dinner Tuesday\n- **Health** (Steady)\n  - Run Tuesday before work';
    expect(parse(reply).actions).toStrictEqual([
      act('Book the sitter for Friday', 'family'),
      act('Home for dinner Tuesday', 'family'),
      act('Run Tuesday before work', 'health'),
    ]);
  });

  it('reads the suffix form as a tag, with colon, dash or pipe', () => {
    const reply = `Suggested actions:\n- Family (High): Book the sitter for Friday\n- HEALTH (Steady): Run Tuesday before work\n- Work (Low) ${EM} Leave at 5 on Thursday\n- **Friends (Low):** Text Jake Monday`;
    expect(parse(reply).actions).toStrictEqual([
      act('Book the sitter for Friday', 'family'),
      act('Run Tuesday before work', 'health'),
      act('Leave at 5 on Thursday', 'work'),
      act('Text Jake Monday', 'friends'),
    ]);
    expect(actionKey('Family (High): Book the sitter for Friday')).toBe('book the sitter for friday');
  });

  it('a lone label with a suffix is not an action', () => {
    expect(parse('Suggested actions:\n- Family (High)\n- Health: Run Tuesday before work').actions).toStrictEqual([
      act('Run Tuesday before work', 'health'),
    ]);
  });
});

describe('defect: bold italic leads leaked asterisks and lost the burner', () => {
  it('treats ***X*** like **X**', () => {
    expect(parse('Suggested actions:\n- ***Family:*** Book the sitter for Friday\n- *Health:* Run Tuesday before work').actions).toStrictEqual([
      act('Book the sitter for Friday', 'family'),
      act('Run Tuesday before work', 'health'),
    ]);
    expect(cleanAction('- ***Book the sitter.*** Date night slipped twice.')).toBe('Book the sitter');
  });
});

describe('defect: a rationale clause after a bold lead was kept', () => {
  it('drops so, because, since, and pronoun-led reasons', () => {
    const reply = [
      'Suggested actions:',
      '- **Book the sitter for Friday** so date night actually happens.',
      '- **Leave the laptop at work Wednesday** because Thursday is the deal close',
      `- **Call Mom Sunday** it${RSQUO}s been three weeks`,
      `- **Run Tuesday and Thursday** ${EM} mornings survive travel.`,
    ].join('\n');
    expect(parse(reply).actions.map((a) => a.text)).toEqual([
      'Book the sitter for Friday',
      'Leave the laptop at work Wednesday',
      'Call Mom Sunday',
      'Run Tuesday and Thursday',
    ]);
  });

  it('keeps bold emphasis inside a sentence that goes on with the action', () => {
    expect(parse('Suggested actions:\n- **Book the sitter** for Friday night\n- **Run** as planned on Tuesday\n- **Block 8** to 10 on Monday').actions.map((a) => a.text)).toEqual([
      'Book the sitter for Friday night',
      'Run as planned on Tuesday',
      'Block 8 to 10 on Monday',
    ]);
  });
});

describe('defect: a cut-off packet above the reply hid the actions', () => {
  const cutOff = REAL_PACKET.slice(0, REAL_PACKET.indexOf('HEALTH (Steady)'));

  it('offers the actions of a reply pasted below a packet with no END line', () => {
    const r = parse(`${cutOff}\nThe paste looks cut off after FAMILY, but here is what I can say.\n\nSuggested actions:\n- Family: Book the sitter for Friday\n- Health: Run Tuesday before work`);
    expect(r).toStrictEqual({
      actions: [act('Book the sitter for Friday', 'family'), act('Run Tuesday before work', 'health')],
      source: 'heading',
      isPacketEcho: false,
    });
  });

  it('still flags the cut-off packet alone, and never offers its template line', () => {
    expect(parse(cutOff)).toStrictEqual({ actions: [], source: 'none', isPacketEcho: true });
    expect(parse(REAL_PACKET)).toStrictEqual({ actions: [], source: 'none', isPacketEcho: true });
  });
});

describe("defect: 'Suggested actions' followed by a negative word was rejected", () => {
  it('keeps the packet heading strong', () => {
    for (const heading of ['Suggested actions based on the pattern:', '**Suggested actions, given the numbers:**', 'Suggested actions to keep what is working:']) {
      const r = parse(`Solid week.\n\n${heading}\n- Work: Laptop closed by 8 on Sunday\n- Family: Pancakes with the kids Sunday morning`);
      expect(r.actions, heading).toStrictEqual([act('Laptop closed by 8 on Sunday', 'work'), act('Pancakes with the kids Sunday morning', 'family')]);
      expect(r.source, heading).toBe('heading');
    }
  });

  it('a last-week recap under that phrase is still rejected', () => {
    expect(parse('Suggested actions from last week:\n- [x] Call Mom on Sunday\n- [ ] Text Jake about golf').actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('ReDoS and pathological input', () => {
  /** Best of 3 runs, so a GC pause cannot fail the test but superlinear behavior still does. */
  function bestMs(input: string): number {
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const r = parseSuggestedActions(input);
      best = Math.min(best, performance.now() - t0);
      expect(Array.isArray(r.actions)).toBe(true);
    }
    return best;
  }

  const rows = (count: number, line: (i: number) => string) => Array.from({ length: count }, (_, i) => line(i)).join('\n');
  const LONG = 100_000;
  const W = 1998;

  // Defect: '[' runs made the markdown link pattern quadratic per item line (about 1 s for 400 lines).
  // Defect: indented lowercase lines were joined into one ever-growing item (hard wrap), so the same pattern
  // ran on a string of hundreds of thousands of characters and never finished.
  const probes: Record<string, string> = {
    'bracket runs in an action block': `Suggested actions:\n${rows(40, () => `- ${'['.repeat(W)}`)}`,
    'hard-wrapped bracket walls': `Suggested actions:\n- a\n${rows(60, () => `  a${'['.repeat(W - 1)}`)}`,
    'hard-wrapped plain walls': `Suggested actions:\n- a\n${rows(60, () => `  b${'c'.repeat(W - 1)}`)}`,
    'space runs': `Suggested actions:\n${rows(40, () => `- a${' '.repeat(W - 2)}b`)}\n${' '.repeat(LONG)}x\n${' '.repeat(LONG)}`,
    'nbsp runs': `Suggested actions:\n${rows(40, () => `- a${NBSP.repeat(W - 2)}b`)}`,
    'asterisk runs': `Suggested actions:\n${rows(40, () => `- ${'*'.repeat(W)}`)}\n${'*'.repeat(LONG)}\n${'**a'.repeat(LONG / 3)}`,
    'spaced asterisks': `Suggested actions:\n${rows(40, () => `- ${'* '.repeat(W / 2)}`)}\n${'* '.repeat(LONG / 2)}x`,
    'dash runs': `Suggested actions:\n${rows(40, () => `- a${'-'.repeat(W - 2)}b`)}\n${'-'.repeat(LONG)}x\n${'- '.repeat(LONG / 2)}x`,
    'spaced dashes and em dashes': `Suggested actions:\n${rows(40, () => `- a${` - ${EM}`.repeat(W / 4)}b`)}`,
    'underscore runs': `Suggested actions:\n${rows(40, () => `- ${'_a '.repeat(W / 3)}`)}\n${'_'.repeat(LONG)}`,
    'bracket and paren mixes': `Suggested actions:\n${rows(40, () => `- ${'[a]('.repeat(W / 4)}`)}\n${'['.repeat(LONG)}\n${'('.repeat(LONG)}:`,
    'closing brackets and checkboxes': `Suggested actions:\n${rows(40, () => `- ${'[ ] '.repeat(W / 4)}`)}\n${']'.repeat(LONG)}`,
    'parentheses in headings': rows(40, () => `Actions ${'('.repeat(W - 10)}:`),
    'burner suffix runs': `Suggested actions:\n${rows(40, () => `- a ${'(Health'.repeat(W / 7)}`)}`,
    'backticks and tildes': `Suggested actions:\n${rows(40, (i) => (i % 2 ? `- a ${'`a'.repeat(W / 2 - 2)}` : `- a ${'~~a'.repeat(W / 3 - 2)}`))}`,
    'hash and quote runs': `${rows(40, (i) => (i % 2 ? '#'.repeat(W) : `${'> '.repeat(W / 2 - 4)}- a b c`))}`,
    'sentence breaks and abbreviations': `Suggested actions:\n${rows(40, (i) => (i % 2 ? `- ${'a. B'.repeat(W / 4)}` : `- ${'Dr. a.m. '.repeat(W / 9)}`))}`,
    'emoji and ZWJ runs': `${rows(40, () => `${POINT_RIGHT.repeat(W / 2)} a`)}\n${rows(40, () => `- ${(ch(0x1f468) + ch(0x200d)).repeat(W / 3)}x`)}`,
    'inline enumerators and semicolons': `Suggested actions: ${'1) 2) 3) '.repeat(LONG / 9)}\nNext steps: ${'a;'.repeat(LONG / 2)}`,
    'comma runs': `Suggested actions:\n${rows(40, () => `- a${', '.repeat(W / 2 - 1)}b`)}`,
    'deep indentation': rows(400, (i) => `${' '.repeat((i % 200) * 4)}- item ${i} here`),
    'one huge line': 'x'.repeat(1_000_000),
    'many blank lines': '\n'.repeat(200_000),
  };

  parseSuggestedActions('Suggested actions:\n- Family: Warm up the parser'); // JIT warm-up

  for (const [name, input] of Object.entries(probes)) {
    it(`stays under 50 ms: ${name}`, () => {
      expect(bestMs(input)).toBeLessThan(50);
    });
  }

  it('hard-wrap joining stops at the line cap, and ordinary wraps still join', () => {
    const r = parse(`Suggested actions:\n- Walk after lunch\n${rows(50, () => `  and ${'x'.repeat(100)}`)}`);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].text.length).toBeLessThanOrEqual(120);
    expect(parse('Suggested actions:\n- Walk 20 minutes after lunch on Tuesday\n  and Thursday').actions).toStrictEqual([
      act('Walk 20 minutes after lunch on Tuesday and Thursday'),
    ]);
  });
});
