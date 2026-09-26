import { describe, expect, it } from 'vitest';
import {
  TRAVEL_LABELS,
  applyAboutMePatch,
  parseAboutMe,
  parsePeople,
  profileIsEmpty,
  profileLine,
  renderAboutMeBlock,
  travelLabel,
  type PersonDraft,
} from '../coach/profile';
import { EMPTY_PROFILE_FIELDS, type ProfileFields, type TravelRhythm } from '../types';

const EM = '\u2014';
const EN = '\u2013';
const HAS_DASH = /[\u2013\u2014]/;

function profile(over: Partial<ProfileFields> = {}): ProfileFields {
  return {
    lifeContext: 'Married to Sarah, two kids, 9 and 12. Home base is Charlotte.',
    burners: {
      family: { matters: 'Sarah, every week. Maya and Luke, every week.', winning: 'Home for dinner most nights I am in town.' },
      friends: { matters: 'Jake, every two weeks. Priya and Marcus, monthly.', winning: 'I reached out before they had to.' },
      health: { matters: 'Running and lifting keep me sane.', winning: 'Three workouts a week, even on travel weeks.' },
      work: { matters: 'I lead acquisitions for Summit Wealth.', winning: 'Deep work four mornings a week. Out by 6:30 when home.' },
    },
    travel: 'weekly',
    crunch: 'A few times a year a closing takes over for two or three weeks.',
    ...over,
  };
}

const LABELS = [
  'Life',
  'Family people',
  'Family win',
  'Friends people',
  'Friends win',
  'Health focus',
  'Health win',
  'Work focus',
  'Work win',
  'Travel',
  'Crunch',
];

/** Replace one labeled line in a rendered block. */
function edit(block: string, label: string, value: string): string {
  return block
    .split('\n')
    .map((l) => (l.startsWith(`${label}:`) ? `${label}: ${value}` : l))
    .join('\n');
}

function names(people: PersonDraft[]): string[] {
  return people.map((p) => p.name);
}

function cadences(people: PersonDraft[]): Record<string, number> {
  return Object.fromEntries(people.map((p) => [p.name, p.cadenceDays]));
}

// ---------------------------------------------------------------------------------------------

describe('travelLabel', () => {
  it('maps each rhythm to its display label and null to empty', () => {
    for (const [t, label] of Object.entries(TRAVEL_LABELS)) expect(travelLabel(t as TravelRhythm)).toBe(label);
    expect(travelLabel(null)).toBe('');
  });
});

describe('renderAboutMeBlock', () => {
  it('renders exactly the 11 labeled lines in order between the markers', () => {
    const lines = renderAboutMeBlock(profile()).split('\n');
    expect(lines).toHaveLength(13);
    expect(lines[0]).toBe('ABOUT ME');
    expect(lines[12]).toBe('END ABOUT ME');
    expect(lines.slice(1, 12).map((l) => l.split(':')[0])).toEqual(LABELS);
    expect(lines[1]).toBe('Life: Married to Sarah, two kids, 9 and 12. Home base is Charlotte.');
    expect(lines[10]).toBe('Travel: Most weeks');
    expect(lines[9]).toBe('Work win: Deep work four mornings a week. Out by 6:30 when home.');
  });

  it('renders empty values as the bare label with nothing after the colon', () => {
    const block = renderAboutMeBlock(EMPTY_PROFILE_FIELDS);
    expect(block).toBe(['ABOUT ME', ...LABELS.map((l) => `${l}:`), 'END ABOUT ME'].join('\n'));
  });

  it('collapses newlines and whitespace runs so every value stays on one line', () => {
    const p = profile({ lifeContext: 'Line one.\n\nLine   two.\r\n\tLine three.  ' });
    const lines = renderAboutMeBlock(p).split('\n');
    expect(lines).toHaveLength(13);
    expect(lines[1]).toBe('Life: Line one. Line two. Line three.');
  });

  it('sanitizes em and en dashes: digit ranges read "to", other dashes become commas', () => {
    const p = profile({
      lifeContext: `Home is Charlotte ${EM} for now`,
      crunch: `Closings run 2${EN}3 weeks, late nights${EM}early flights`,
    });
    const block = renderAboutMeBlock(p);
    expect(block).not.toMatch(HAS_DASH);
    expect(block).toContain('Life: Home is Charlotte, for now');
    expect(block).toContain('Crunch: Closings run 2 to 3 weeks, late nights, early flights');
  });

  it('caps each value at 400 characters at a word boundary with "..."', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const line = renderAboutMeBlock(profile({ crunch: long }))
      .split('\n')
      .find((l) => l.startsWith('Crunch:'))!;
    const value = line.slice('Crunch: '.length);
    expect(value.length).toBeLessThanOrEqual(400);
    expect(value.endsWith('...')).toBe(true);
    const kept = value.slice(0, -3);
    expect(long.startsWith(`${kept} `)).toBe(true);
  });

  it('renders a null travel as an empty Travel line', () => {
    expect(renderAboutMeBlock(profile({ travel: null }))).toContain('\nTravel:\n');
  });
});

describe('profileLine', () => {
  it('joins the life, win, travel, and crunch parts with pipes', () => {
    expect(profileLine(profile())).toBe(
      'Life: Married to Sarah, two kids, 9 and 12. Home base is Charlotte. | Family: Home for dinner most nights I am in town. | ' +
        'Friends: I reached out before they had to. | Health: Three workouts a week, even on travel weeks. | ' +
        'Work: Deep work four mornings a week. Out by 6:30 when home. | Travel: Most weeks | ' +
        'Crunch: A few times a year a closing takes over for two or three weeks.',
    );
  });

  it('skips empty parts and returns "" for an empty or missing profile', () => {
    expect(profileLine(undefined)).toBe('');
    expect(profileLine(EMPTY_PROFILE_FIELDS)).toBe('');
    const p: ProfileFields = {
      ...EMPTY_PROFILE_FIELDS,
      burners: { ...EMPTY_PROFILE_FIELDS.burners, health: { matters: 'x', winning: 'Sleep by 10:30' } },
      travel: 'rare',
    };
    expect(profileLine(p)).toBe('Health: Sleep by 10:30 | Travel: Rarely');
  });

  it('cuts at the cap on a word boundary and sanitizes dashes', () => {
    const p = profile({ lifeContext: `Busy season ${EM} ${'really '.repeat(80)}busy` });
    const line = profileLine(p, 120);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith('...')).toBe(true);
    expect(line).not.toMatch(HAS_DASH);
    expect(line.startsWith('Life: Busy season, really really')).toBe(true);
    expect(line).not.toMatch(/\breall\.\.\.$/);
    expect(profileLine(profile()).length).toBeLessThanOrEqual(450);
  });
});

describe('profileIsEmpty', () => {
  it('is true for missing, empty, and whitespace-only profiles, false once anything is set', () => {
    expect(profileIsEmpty(undefined)).toBe(true);
    expect(profileIsEmpty(EMPTY_PROFILE_FIELDS)).toBe(true);
    expect(profileIsEmpty({ ...EMPTY_PROFILE_FIELDS, lifeContext: '   \n ' })).toBe(true);
    expect(profileIsEmpty({ ...EMPTY_PROFILE_FIELDS, travel: 'monthly' })).toBe(false);
    expect(profileIsEmpty({ ...EMPTY_PROFILE_FIELDS, crunch: 'Deal season' })).toBe(false);
    expect(profileIsEmpty(profile())).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('parseAboutMe', () => {
  it('round trip: an unchanged block parses ok with no changes', () => {
    const current = profile();
    const r = parseAboutMe(renderAboutMeBlock(current), current);
    expect(r.ok).toBe(true);
    expect(r.isPacketEcho).toBe(false);
    expect(r.changedFields).toEqual([]);
    expect(r.patch).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it('round trip: edited lines become a patch with only the changed fields', () => {
    const current = profile();
    let block = renderAboutMeBlock(current);
    block = edit(block, 'Family win', 'Home for dinner most nights. Two date nights a month.');
    block = edit(block, 'Health focus', 'Running, lifting, and a cranky left knee.');
    block = edit(block, 'Travel', 'More away than home');
    const r = parseAboutMe(`Here is the tightened version.\n\n${block}\n\nSuggested actions:\n- Family: Book a sitter`, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual(['burners.family.winning', 'burners.health.matters', 'travel']);
    expect(r.patch).toEqual({
      burners: {
        family: { winning: 'Home for dinner most nights. Two date nights a month.' },
        health: { matters: 'Running, lifting, and a cranky left knee.' },
      },
      travel: 'mostly_away',
    });
    const next = applyAboutMePatch(current, r.patch);
    expect(next.burners.family).toEqual({ matters: current.burners.family.matters, winning: 'Home for dinner most nights. Two date nights a month.' });
    expect(next.burners.health.winning).toBe(current.burners.health.winning);
    expect(next.travel).toBe('mostly_away');
    expect(next.lifeContext).toBe(current.lifeContext);
  });

  it('reads markdown-decorated replies (bold, bullets, headings, code fences, intro prose)', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'Here is your revised About me:',
      '',
      '```',
      '## **ABOUT ME** (revised)',
      '- **Life:** Married to Sarah, two kids.',
      '* **Family people**: Sarah, every week',
      '1. *Family win:* _Home for dinner_',
      '2) > Friends people: "Jake, every two weeks"',
      '\u2022 __Health focus:__ Running keeps me **sane**',
      '**Travel:** Most weeks',
      '**END ABOUT ME**',
      '```',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    const next = applyAboutMePatch(current, r.patch);
    expect(next.lifeContext).toBe('Married to Sarah, two kids.');
    expect(next.burners.family).toEqual({ matters: 'Sarah, every week', winning: 'Home for dinner' });
    expect(next.burners.friends.matters).toBe('Jake, every two weeks');
    expect(next.burners.health.matters).toBe('Running keeps me sane');
    expect(next.travel).toBe('weekly');
  });

  it('handles CRLF, zero-width characters, non-breaking spaces, and full-width colons', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      '\uFEFFABOUT ME',
      'Life\uFF1A Home\u00A0base is\u200B Charlotte',
      'Health win: Three workouts a week',
      'Work win\uFF1ADeep work before 10',
      'Crunch: Late nights',
      'END ABOUT ME',
    ].join('\r\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.patch.lifeContext).toBe('Home base is Charlotte');
    expect(r.patch.burners?.work.winning).toBe('Deep work before 10');
    expect(r.patch.crunch).toBe('Late nights');
    expect(r.changedFields).toEqual(['lifeContext', 'burners.health.winning', 'burners.work.winning', 'crunch']);
  });

  it('warns when the reply is cut off and keeps fields that never arrived', () => {
    const current = profile();
    const block = edit(renderAboutMeBlock(current), 'Life', 'Married, two kids, Charlotte.');
    const cut = block.split('\n').slice(0, 7).join('\n') + '\nHealth win: Three work';
    const r = parseAboutMe(cut, current);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('Reply may be cut off.');
    expect(r.changedFields).toEqual(['lifeContext', 'burners.health.winning']);
    const next = applyAboutMePatch(current, r.patch);
    expect(next.burners.work).toEqual(current.burners.work);
    expect(next.crunch).toBe(current.crunch);
    expect(next.travel).toBe(current.travel);
  });

  it('uses the last block with 3 or more labels when several are pasted', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life: First draft',
      'Health win: Draft health',
      'Work win: Draft work',
      'END ABOUT ME',
      '',
      'Actually, a tighter version:',
      'ABOUT ME',
      'Life: Second draft',
      'Health win: Final health',
      'Crunch: Final crunch',
      'END ABOUT ME',
      '',
      'About me',
      'Life: stray mention',
      'That is all.',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.patch.lifeContext).toBe('Second draft');
    expect(r.patch.crunch).toBe('Final crunch');
    expect(r.patch.burners?.health.winning).toBe('Final health');
    expect(r.patch.burners?.work).toBeUndefined();
  });

  it('keeps the current wording when a value contains a redaction token, and warns', () => {
    const current = profile();
    let block = renderAboutMeBlock(current);
    block = edit(block, 'Work focus', 'I lead acquisitions for [redacted], relationships first.');
    block = edit(block, 'Work win', 'Deep work for [REDACTED 2] four mornings a week.');
    block = edit(block, 'Crunch', 'Closings for (Redacted) take two weeks.');
    block = edit(block, 'Health win', 'Three workouts a week, every week.');
    const r = parseAboutMe(block, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual(['burners.health.winning']);
    expect(r.warnings).toEqual([
      'Kept your wording for Work focus (the coach saw a redacted name).',
      'Kept your wording for Work win (the coach saw a redacted name).',
      'Kept your wording for Crunch (the coach saw a redacted name).',
    ]);
    const next = applyAboutMePatch(current, r.patch);
    expect(next.burners.work).toEqual(current.burners.work);
    expect(next.crunch).toBe(current.crunch);
  });

  it('treats an echoed redacted value that otherwise matches the current wording as unchanged', () => {
    const current = profile();
    const block = edit(renderAboutMeBlock(current), 'Work focus', 'I lead acquisitions for [redacted].');
    const r = parseAboutMe(block, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('flags a pasted packet as an echo, with the new or the old header wording', () => {
    const current = profile();
    const packet = ['FOUR BURNERS COACH v1', 'Be my executive coach.', 'TYPE: onboarding', renderAboutMeBlock(current), 'ASK: Tighten it.', 'END OF PACKET'].join('\n');
    const r = parseAboutMe(packet, current);
    expect(r).toEqual({ ok: false, patch: {}, changedFields: [], warnings: [], isPacketEcho: true });

    const old = packet.replace('FOUR BURNERS COACH v1', 'FOUR BURNERS COACHING PACKET');
    expect(parseAboutMe(old, current).isPacketEcho).toBe(true);

    const cutPacket = packet.split('\n').slice(0, 6).join('\n');
    expect(parseAboutMe(cutPacket, current).isPacketEcho).toBe(true);
  });

  it('parses the reply after END OF PACKET when a whole conversation is pasted', () => {
    const current = profile();
    const packet = ['FOUR BURNERS COACH v1', renderAboutMeBlock(current), 'END OF PACKET'].join('\n');
    const reply = edit(renderAboutMeBlock(current), 'Friends win', 'I reach out first, every time.');
    const r = parseAboutMe(`${packet}\n\nClaude:\nTwo gaps first.\n\n${reply}`, current);
    expect(r.isPacketEcho).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual(['burners.friends.winning']);
  });

  it('parses 5 or more unmarked labels with a warning, but not fewer', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const five = ['Life: A', 'Family win: B', 'Friends win: C', 'Health win: D', 'Work win: E'].join('\n');
    const r = parseAboutMe(five, current);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['Markers missing, check before replacing.']);
    expect(r.changedFields).toHaveLength(5);

    const four = five.split('\n').slice(0, 4).join('\n');
    const r4 = parseAboutMe(four, current);
    expect(r4.ok).toBe(false);
    expect(r4.patch).toEqual({});
    expect(r4.changedFields).toEqual([]);
  });

  it('never wipes a field: missing, empty, and placeholder values keep the current one', () => {
    const current = profile();
    const reply = [
      'ABOUT ME',
      'Life:',
      'Family people: none',
      'Family win: N/A',
      'Friends win: (blank)',
      'Health focus: TBD',
      'Health win: not provided.',
      'Work focus: unknown',
      'Work win: <text>',
      'Travel:',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual([]);
    expect(r.patch).toEqual({});
    expect(applyAboutMePatch(current, r.patch)).toEqual(current);
  });

  it('maps travel keywords to the enum, most specific first', () => {
    const cases: [string, TravelRhythm][] = [
      ['Rarely', 'rare'],
      ['Seldom, maybe twice a year', 'rare'],
      ['Hardly at all', 'rare'],
      ['A trip or two a month', 'monthly'],
      ['A few trips a quarter', 'monthly'],
      ['Every other week', 'monthly'],
      ['Most weeks', 'weekly'],
      ['Weekly, Monday to Thursday', 'weekly'],
      ['More away than home', 'mostly_away'],
      ['Mostly away', 'mostly_away'],
      ['Constantly on the road', 'mostly_away'],
      ['mostly_away', 'mostly_away'],
    ];
    const current = { ...profile(), travel: null };
    for (const [text, want] of cases) {
      const block = edit(renderAboutMeBlock(current), 'Travel', text);
      const r = parseAboutMe(block, current);
      expect(r.patch.travel, text).toBe(want);
      expect(r.changedFields).toEqual(['travel']);
    }
  });

  it('keeps the current travel and warns when the answer is not recognized', () => {
    const current = profile();
    const r = parseAboutMe(edit(renderAboutMeBlock(current), 'Travel', 'It depends on the season'), current);
    expect(r.ok).toBe(true);
    expect('travel' in r.patch).toBe(false);
    expect(r.warnings).toEqual(['Could not read Travel ("It depends on the season"), kept your current answer.']);
  });

  it('does not report travel as changed when it maps to the current value', () => {
    const current = profile({ travel: 'weekly' });
    const r = parseAboutMe(edit(renderAboutMeBlock(current), 'Travel', 'Weekly'), current);
    expect(r.changedFields).toEqual([]);
  });

  it('accepts label aliases from the design doc', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life context: L',
      'Family: F people',
      'Winning at home: F win',
      'Friends who matter: Fr people',
      'Friends winning: Fr win',
      'Health: H focus',
      'Health winning: H win',
      'Work big picture: W focus',
      'Work winning: W win',
      'Time on the road: Rarely',
      'Deal season: C',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    const next = applyAboutMePatch(current, r.patch);
    expect(next).toEqual({
      lifeContext: 'L',
      burners: {
        family: { matters: 'F people', winning: 'F win' },
        friends: { matters: 'Fr people', winning: 'Fr win' },
        health: { matters: 'H focus', winning: 'H win' },
        work: { matters: 'W focus', winning: 'W win' },
      },
      travel: 'rare',
      crunch: 'C',
    });
    expect(r.changedFields).toHaveLength(11);
  });

  it('appends wrapped continuation lines and ignores prose before the first label and after a blank line', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'I kept your words where I could.',
      'Life: Married to Sarah, two kids,',
      'home base is Charlotte.',
      'Work win: Deep work four mornings a week.',
      'Out by 6:30 when home.',
      'Crunch: Two or three weeks of late nights.',
      '',
      'Let me know if this feels right.',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.patch.lifeContext).toBe('Married to Sarah, two kids, home base is Charlotte.');
    expect(r.patch.burners?.work.winning).toBe('Deep work four mornings a week. Out by 6:30 when home.');
    expect(r.patch.crunch).toBe('Two or three weeks of late nights.');
    expect(r.warnings).toEqual([]);
  });

  it('joins bulleted sub-lines with semicolons so the people line still parses', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life: Charlotte',
      'Family people:',
      '- Sarah, every week',
      '- Dad and my sister Katie, every two weeks',
      'Family win: Dinners',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    const matters = r.patch.burners?.family.matters ?? '';
    expect(matters).toBe('Sarah, every week; Dad and my sister Katie, every two weeks');
    expect(cadences(parsePeople(matters, 'family').people)).toEqual({ Sarah: 7, Dad: 14, 'Katie (sister)': 14 });
  });

  it('sanitizes dashes, strips wrapping quotes, and caps parsed values at 600 characters', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const reply = [
      'ABOUT ME',
      `Life: "Home is Charlotte ${EM} for now"`,
      `Health win: 3${EN}4 workouts a week`,
      `Crunch: ${long}`,
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.patch.lifeContext).toBe('Home is Charlotte, for now');
    expect(r.patch.burners?.health.winning).toBe('3 to 4 workouts a week');
    const crunch = r.patch.crunch ?? '';
    expect(crunch.length).toBeLessThanOrEqual(600);
    expect(crunch.endsWith('...')).toBe(true);
    expect(JSON.stringify(r.patch)).not.toMatch(HAS_DASH);
  });

  it('stops at Suggested actions when END ABOUT ME is missing, so action lines never overwrite fields', () => {
    const current = profile();
    const block = renderAboutMeBlock(current)
      .split('\n')
      .filter((l) => l !== 'END ABOUT ME')
      .join('\n');
    const reply = `${edit(block, 'Crunch', 'Two weeks of closings, twice a year.')}\nSuggested actions:\n- Health: Run Tuesday and Thursday\n- Work: Block two mornings`;
    const r = parseAboutMe(reply, current);
    expect(r.changedFields).toEqual(['crunch']);
    expect(r.patch.crunch).toBe('Two weeks of closings, twice a year.');
    expect(r.warnings).toEqual([]);
  });

  it('ignores repeated labels after the block when no end marker was given', () => {
    const current = profile();
    const block = renderAboutMeBlock(current)
      .split('\n')
      .filter((l) => l !== 'END ABOUT ME')
      .join('\n');
    const r = parseAboutMe(`${block}\n\n- Health: Run Tuesday before the office\n- Work: Protect Friday mornings`, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('recognizes start markers only on their own line', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const body = ['Life: A', 'Health win: B', 'Work win: C'].join('\n');
    const prose = parseAboutMe(`Here is your revised About me:\n${body}`, current);
    expect(prose.ok).toBe(false);
    for (const marker of ['ABOUT ME:', '**ABOUT ME**', 'About me (revised)', '### About Me']) {
      const r = parseAboutMe(`${marker}\n${body}\nEND ABOUT ME`, current);
      expect(r.ok, marker).toBe(true);
      expect(r.changedFields, marker).toEqual(['lifeContext', 'burners.health.winning', 'burners.work.winning']);
    }
    const endVariant = parseAboutMe(`ABOUT ME\n${body}\n*End of About me*`, current);
    expect(endVariant.warnings).toEqual([]);
  });

  it('returns ok false with no patch for replies without a profile', () => {
    for (const text of ['', 'Great start. Suggested actions:\n- Health: Walk after lunch', 'ABOUT ME\nLife: only one\nEND ABOUT ME']) {
      const r = parseAboutMe(text, profile());
      expect(r.ok).toBe(false);
      expect(r.isPacketEcho).toBe(false);
      expect(r.patch).toEqual({});
      expect(r.changedFields).toEqual([]);
    }
  });

  it('does not treat an echoed, truncated long value as a change', () => {
    const long = Array.from({ length: 90 }, (_, i) => `part${i}`).join(' ');
    const current = profile({ lifeContext: long });
    const block = renderAboutMeBlock(current);
    expect(block.split('\n')[1].endsWith('...')).toBe(true);
    const r = parseAboutMe(edit(block, 'Crunch', 'Shorter crunch line.'), current);
    expect(r.changedFields).toEqual(['crunch']);
    expect(r.patch.lifeContext).toBeUndefined();
  });

  it('does not count values that differ only by whitespace, dash style, or line breaks as changes', () => {
    const current = profile({ lifeContext: `Home base:\nCharlotte ${EM} for now`, crunch: `2${EN}3 weeks` });
    const r = parseAboutMe(renderAboutMeBlock(current), current);
    expect(r.changedFields).toEqual([]);
  });

  it('does not let trailing prose leak into an empty last field when the end marker is missing', () => {
    const current = profile();
    const reply = 'ABOUT ME\nLife: A\nHealth win: B\nWork win: C\nCrunch:\n\nI left Crunch empty since you skipped it.';
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual(['lifeContext', 'burners.health.winning', 'burners.work.winning']);
    expect(r.patch.crunch).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });
});

describe('applyAboutMePatch', () => {
  it('deep-merges burners without mutating the input and keeps unrelated fields', () => {
    const current = profile();
    const snapshot = JSON.parse(JSON.stringify(current));
    const patch = { burners: { work: { winning: 'New work win' } }, crunch: 'New crunch' } as unknown as Partial<ProfileFields>;
    const next = applyAboutMePatch(current, patch);
    expect(current).toEqual(snapshot);
    expect(next.burners.work).toEqual({ matters: current.burners.work.matters, winning: 'New work win' });
    expect(next.burners.family).toEqual(current.burners.family);
    expect(next.crunch).toBe('New crunch');
    expect(next.travel).toBe('weekly');
    expect(next.burners).not.toBe(current.burners);
    expect(applyAboutMePatch(current, {})).toEqual(current);
  });
});

// ---------------------------------------------------------------------------------------------

describe('parsePeople', () => {
  it('parses the family placeholder answer', () => {
    const r = parsePeople('Sarah, every week. Maya and Luke, every week. Mom, every week. Dad and my sister Katie, every two weeks.', 'family');
    expect(r.people.map((p) => [p.name, p.cadenceDays])).toEqual([
      ['Sarah', 7],
      ['Maya', 7],
      ['Luke', 7],
      ['Mom', 7],
      ['Dad', 14],
      ['Katie (sister)', 14],
    ]);
    expect(r.people.every((p) => p.burner === 'family' && p.include === true)).toBe(true);
    expect(r.leftovers).toEqual([]);
  });

  it('parses the friends placeholder answer', () => {
    const r = parsePeople('Jake, every two weeks. Priya and Marcus, monthly. Elena, every couple of months.', 'friends');
    expect(r.people.map((p) => [p.name, p.cadenceDays])).toEqual([
      ['Jake', 14],
      ['Priya', 30],
      ['Marcus', 30],
      ['Elena', 60],
    ]);
    expect(r.people.every((p) => p.burner === 'friends')).toBe(true);
  });

  it('defaults to weekly for family and monthly for friends when no cadence is spoken', () => {
    expect(cadences(parsePeople('Sarah and the kids', 'family').people)).toEqual({ Sarah: 7, 'The kids': 7 });
    expect(cadences(parsePeople('Jake, Priya', 'friends').people)).toEqual({ Jake: 30, Priya: 30 });
  });

  it('maps cadence phrases to CADENCE_OPTIONS days', () => {
    const cases: [string, number][] = [
      ['daily', 3],
      ['every day', 3],
      ['every few days', 3],
      ['a few times a week', 3],
      ['twice a week', 3],
      ['weekly', 7],
      ['every week', 7],
      ['once a week', 7],
      ['every Sunday', 7],
      ['on weekends', 7],
      ['every two weeks', 14],
      ['every 2 weeks', 14],
      ['every other week', 14],
      ['twice a month', 14],
      ['biweekly', 14],
      ['monthly', 30],
      ['once a month', 30],
      ['every month', 30],
      ['every couple of months', 60],
      ['every two months', 60],
      ['quarterly', 90],
      ['a few times a year', 90],
      ['every few months', 90],
      ['once a year', 90],
      ['every week or two', 7],
      ['every 2-3 weeks', 14],
      ['every six weeks', 30],
      ['twice weekly', 3],
      ['a couple times a month', 14],
    ];
    for (const [phrase, days] of cases) {
      const r = parsePeople(`Jake, ${phrase}.`, 'friends');
      expect(names(r.people), phrase).toEqual(['Jake']);
      expect(r.people[0].cadenceDays, phrase).toBe(days);
      expect(r.leftovers, phrase).toEqual([]);
    }
  });

  it('turns relations into readable names', () => {
    expect(names(parsePeople('my sister Katie', 'family').people)).toEqual(['Katie (sister)']);
    expect(names(parsePeople('Katie, my sister', 'family').people)).toEqual(['Katie (sister)']);
    expect(names(parsePeople('my mom', 'family').people)).toEqual(['Mom']);
    expect(names(parsePeople('my brother-in-law Tom, monthly', 'family').people)).toEqual(['Tom (brother-in-law)']);
    expect(names(parsePeople('my best friend Jake', 'friends').people)).toEqual(['Jake (best friend)']);
    expect(names(parsePeople('my Aunt Linda, a few times a year', 'family').people)).toEqual(['Aunt Linda']);
    expect(names(parsePeople('Mom, my sister', 'family').people)).toEqual(['Mom', 'Sister']);
  });

  it('splits names on commas, and, ampersands, plus, and slashes', () => {
    const r = parsePeople('Mom & Dad, Maya, Luke, and Grandma plus Aunt Jo / Uncle Ray, weekly', 'family');
    expect(names(r.people)).toEqual(['Mom', 'Dad', 'Maya', 'Luke', 'Grandma', 'Aunt Jo', 'Uncle Ray']);
    expect(r.people.every((p) => p.cadenceDays === 7)).toBe(true);
  });

  it('sends fragments over 4 words to leftovers instead of making people', () => {
    const r = parsePeople('Jake, weekly. Honestly I just want to be home more. The guys from my old soccer team.', 'friends');
    expect(names(r.people)).toEqual(['Jake']);
    expect(r.leftovers).toEqual(['I just want to be home more', 'The guys from my old soccer team']);
  });

  it('keeps a group as one entry', () => {
    const r = parsePeople('The college group chat, every week. Elena.', 'friends');
    expect(cadences(r.people)).toEqual({ 'The college group chat': 7, Elena: 30 });
  });

  it('dedupes by name, case-insensitively, keeping the first mention', () => {
    const r = parsePeople('Mom, every week. my mom, monthly. JAKE and jake. Katie. My sister Katie, monthly.', 'family');
    // Katie's first mention has no cadence phrase; the spoken "monthly" later applies to her (design:
    // "A cadence phrase applies to every name in its clause"), so the merge keeps it over the default.
    expect(r.people.map((p) => [p.name, p.cadenceDays])).toEqual([
      ['Mom', 7],
      ['JAKE', 7],
      ['Katie', 30],
    ]);
  });

  it('applies a cadence spoken as its own sentence to the names just before it', () => {
    const r = parsePeople('Jake and Priya. Every two weeks. Elena.', 'friends');
    expect(cadences(r.people)).toEqual({ Jake: 14, Priya: 14, Elena: 30 });
  });

  it('splits a run-on clause that has several cadences', () => {
    expect(cadences(parsePeople('Mom every week, Dad every two weeks and Grandma quarterly', 'family').people)).toEqual({
      Mom: 7,
      Dad: 14,
      Grandma: 90,
    });
    expect(cadences(parsePeople('Weekly: Sarah and Maya, monthly: Aunt Jo', 'family').people)).toEqual({
      Sarah: 7,
      Maya: 7,
      'Aunt Jo': 30,
    });
  });

  it('handles lowercase dictation and line breaks', () => {
    const r = parsePeople('mom and dad, every week\nmy sister katie monthly\nmary ann', 'family');
    expect(cadences(r.people)).toEqual({ Mom: 7, Dad: 7, 'Katie (sister)': 30, 'Mary Ann': 7 });
  });

  it('strips spoken lead-ins, qualifiers, and closers', () => {
    const r = parsePeople(
      "I want to see Jake, ideally every two weeks or so. I'd like to call my mom every Sunday. Priya too, at least monthly. That's about it.",
      'friends',
    );
    expect(r.people.map((p) => [p.name, p.cadenceDays])).toEqual([
      ['Jake', 14],
      ['Mom', 7],
      ['Priya', 30],
    ]);
    expect(r.leftovers).toEqual([]);
  });

  it('handles plural relations: groups drop the label, singular-able ones carry it', () => {
    expect(cadences(parsePeople('my kids Maya and Luke, every day', 'family').people)).toEqual({ Maya: 3, Luke: 3 });
    expect(names(parsePeople('my sisters Katie and Anna, monthly', 'family').people)).toEqual(['Katie (sister)', 'Anna (sister)']);
    expect(names(parsePeople('my parents', 'family').people)).toEqual(['Parents']);
  });

  it('copes with bullets, numbering, dashes, parentheses, and titles', () => {
    const r = parsePeople(`1. Jake ${EM} every two weeks\n2. Priya (monthly)\n- Dr. Patel, quarterly\n\u2022 Elena - every couple of months`, 'friends');
    expect(r.people.map((p) => [p.name, p.cadenceDays])).toEqual([
      ['Jake', 14],
      ['Priya', 30],
      ['Dr Patel', 90],
      ['Elena', 60],
    ]);
    expect(r.leftovers).toEqual([]);
  });

  it('returns nothing for empty or name-free input', () => {
    expect(parsePeople('', 'family')).toEqual({ people: [], leftovers: [] });
    expect(parsePeople('   \n. ;', 'friends')).toEqual({ people: [], leftovers: [] });
    expect(parsePeople('Every week.', 'family')).toEqual({ people: [], leftovers: [] });
  });

  it('parses semicolon clauses and keeps spoken order', () => {
    const r = parsePeople('Luke, daily; Maya, daily; Sarah', 'family');
    expect(r.people.map((p) => [p.name, p.cadenceDays])).toEqual([
      ['Luke', 3],
      ['Maya', 3],
      ['Sarah', 7],
    ]);
  });
});
