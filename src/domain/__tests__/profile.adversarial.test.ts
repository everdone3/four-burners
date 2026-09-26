// Adversarial review of src/domain/coach/profile.ts: messy real-world coach replies and dictated answers.
// Each describe block below pins a defect that was found by attacking the parser, plus guard cases around it.
import { describe, expect, it } from 'vitest';
import { applyAboutMePatch, parseAboutMe, parsePeople, profileLine, renderAboutMeBlock, type PersonDraft } from '../coach/profile';
import { EMPTY_PROFILE_FIELDS, type ProfileFields, type TravelRhythm } from '../types';

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

function edit(block: string, label: string, value: string): string {
  return block
    .split('\n')
    .map((l) => (l.startsWith(`${label}:`) ? `${label}: ${value}` : l))
    .join('\n');
}

function pairs(people: PersonDraft[]): [string, number][] {
  return people.map((p) => [p.name, p.cadenceDays]);
}

// ---------------------------------------------------------------------------------------------
// parseAboutMe

describe('parseAboutMe adversarial: placeholders never wipe or overwrite a field', () => {
  it('treats bracketed, abbreviated, and "not given" style placeholders as empty', () => {
    const current = profile();
    const reply = [
      'ABOUT ME',
      'Life: [blank]',
      'Family people: [none]',
      'Family win: n.a.',
      'Friends people: None given',
      'Friends win: (not provided)',
      'Health focus: Not mentioned',
      'Health win: You skipped this',
      'Work focus: (left blank)',
      'Work win: Not answered',
      'Travel: <Rarely | A trip or two a month | Most weeks | More away than home>',
      'Crunch: ...',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual([]);
    expect(r.patch).toEqual({});
    expect(applyAboutMePatch(current, r.patch)).toEqual(current);
  });

  it('treats "unchanged", "same as before", and "no change" as keep-current, not as new text', () => {
    const current = profile();
    let block = renderAboutMeBlock(current);
    block = edit(block, 'Life', 'Unchanged');
    block = edit(block, 'Family people', '(same as before)');
    block = edit(block, 'Family win', 'No change.');
    block = edit(block, 'Friends people', 'Same');
    block = edit(block, 'Health focus', '*Unchanged*');
    block = edit(block, 'Work win', 'Keep as is');
    const r = parseAboutMe(block, current);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual([]);
    expect(r.patch).toEqual({});
  });

  it('strips a trailing "(unchanged)" style annotation instead of saving it into the profile', () => {
    const current = profile();
    let block = renderAboutMeBlock(current);
    block = edit(block, 'Life', `${current.lifeContext} (unchanged)`);
    block = edit(block, 'Health win', 'Three workouts a week, travel weeks included. (revised)');
    const r = parseAboutMe(block, current);
    expect(r.changedFields).toEqual(['burners.health.winning']);
    expect(r.patch.burners?.health.winning).toBe('Three workouts a week, travel weeks included.');
  });

  it('does not treat real sentences that start like a placeholder as empty', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life: None of my family lives nearby.',
      'Health focus: I skipped the gym for a year and want back in.',
      'Work win: Same-day follow up on everything.',
      'Crunch: Not sure yet, first deal season in this role.',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.changedFields).toEqual(['lifeContext', 'burners.health.matters', 'burners.work.winning', 'crunch']);
    expect(r.patch.lifeContext).toBe('None of my family lives nearby.');
  });
});

describe('parseAboutMe adversarial: label variants', () => {
  it('maps labels with extra words instead of gluing them onto the previous field', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life right now: Married, Charlotte',
      'Family (who matters): Sarah weekly',
      'Family win (end of quarter): Dinners',
      'Health focus areas: Running',
      'Work focus / role: Acquisitions',
      'Your Work win: Deep work',
      'Winning with friends: I reach out first',
      'Travel rhythm: Most weeks',
      'Crunch pattern: Late nights',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    const next = applyAboutMePatch(current, r.patch);
    expect(next.burners.family).toEqual({ matters: 'Sarah weekly', winning: 'Dinners' });
    expect(next.burners.health.matters).toBe('Running');
    expect(next.burners.work).toEqual({ matters: 'Acquisitions', winning: 'Deep work' });
    expect(next.burners.friends.winning).toBe('I reach out first');
    expect(next.travel).toBe('weekly');
    expect(next.crunch).toBe('Late nights');
  });

  it('accepts a dash between the label and the value (em dash, en dash, spaced hyphen)', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life \u2014 Married, Charlotte',
      '**Family win** \u2013 Dinners at home',
      'Health win - Three workouts',
      'Work win\u2014Deep work',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    const next = applyAboutMePatch(current, r.patch);
    expect(next.lifeContext).toBe('Married, Charlotte');
    expect(next.burners.family.winning).toBe('Dinners at home');
    expect(next.burners.health.winning).toBe('Three workouts');
    expect(next.burners.work.winning).toBe('Deep work');
  });

  it('keeps an unknown label line as a continuation, and a lowercase "work - life" line is not a label', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'ABOUT ME',
      'Life: Married, two kids, and trying to keep',
      'work - life balance on travel weeks.',
      'Family win: Dinners',
      'Family dinners: four a week when home.',
      'Health win: Workouts',
      'END ABOUT ME',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.patch.lifeContext).toBe('Married, two kids, and trying to keep work - life balance on travel weeks.');
    expect(r.patch.burners?.family.winning).toBe('Dinners Family dinners: four a week when home.');
    expect(r.patch.burners?.family.matters).toBeUndefined();
  });

  it('reads heading-style labels with the value on the following lines', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'Here you go.',
      '',
      '# ABOUT ME',
      '',
      '## Life',
      'Married to Sarah, two kids.',
      '',
      '## Family people',
      '',
      'Sarah weekly',
      '',
      '**Family win**',
      'Dinner at home',
      '',
      '### Health focus:',
      'Running',
      '',
      '## Suggested actions',
      '- Health: Run Tuesday',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.patch.lifeContext).toBe('Married to Sarah, two kids.');
    expect(r.patch.burners?.family).toEqual({ matters: 'Sarah weekly', winning: 'Dinner at home' });
    expect(r.patch.burners?.health).toEqual({ matters: 'Running' });
    expect(r.warnings).toEqual([]);
  });

  it('reads a reply that follows the onboarding ASK (Life, Rhythm, Family, Friends, Health, Work) without gluing Rhythm onto Life', () => {
    const current = profile({ travel: null });
    const reply = [
      'Two gaps: Friends has no clear win, and travel weeks collide with bedtime.',
      '',
      'About me:',
      'Life: Married to Sarah, two kids, Charlotte base.',
      'Rhythm: On the road most weeks; closings take over a few times a year.',
      'Family: Sarah and the kids first, home for dinner when in town.',
      'Friends: Jake, Priya, Marcus, Elena.',
      'Health: Running and lifting, protect the knee.',
      'Work: Lead acquisitions, never at the cost of bedtime.',
      '',
      'Suggested actions:',
      '- Family: Put bedtime on the travel calendar',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.patch.lifeContext).toBe('Married to Sarah, two kids, Charlotte base.');
    expect(r.patch.travel).toBe('weekly');
    expect(r.patch.burners?.family.matters).toBe('Sarah and the kids first, home for dinner when in town.');
    expect(r.patch.burners?.work.matters).toBe('Lead acquisitions, never at the cost of bedtime.');
  });

  it('a fully bolded "Label: value" line keeps its value', () => {
    const reply = 'ABOUT ME\n**Life: The context for this quarter**\n## Travel: Most weeks\n**Family win: Dinners**\n**Health win: Workouts**\nEND ABOUT ME';
    const r = parseAboutMe(reply, profile({ travel: null }));
    expect(r.patch.lifeContext).toBe('The context for this quarter');
    expect(r.patch.travel).toBe('weekly');
    expect(r.patch.burners?.family.winning).toBe('Dinners');
  });

  it('a plain "Crunch:" or a bold "**Crunch**" with nothing after it does not swallow prose after a blank line', () => {
    const current = profile();
    for (const label of ['Crunch:', '**Crunch**', '**Crunch:**', 'Crunch']) {
      const reply = `ABOUT ME\nLife: A\nHealth win: B\nWork win: C\n${label}\n\nI left Crunch empty since you skipped it.`;
      const r = parseAboutMe(reply, current);
      expect(r.patch.crunch, label).toBeUndefined();
      expect(r.patch.lifeContext, label).toBe('A');
    }
  });
});

describe('parseAboutMe adversarial: normalization', () => {
  it('splits on Unicode line and paragraph separators', () => {
    const r = parseAboutMe('ABOUT ME\u2028Life: A\u2028Family win: B\u2029Health win: C\u2028END ABOUT ME', EMPTY_PROFILE_FIELDS);
    expect(r.ok).toBe(true);
    expect(r.changedFields).toEqual(['lifeContext', 'burners.family.winning', 'burners.health.winning']);
  });

  it('treats small, presentation, and ratio colons as colons', () => {
    const r = parseAboutMe('ABOUT ME\nLife\uFE55 A\nFamily win\uFE13 B\nHealth win\u2236 C\nEND ABOUT ME', EMPTY_PROFILE_FIELDS);
    expect(r.ok).toBe(true);
    expect(r.patch.lifeContext).toBe('A');
    expect(r.patch.burners?.health.winning).toBe('C');
  });

  it('a quoted blank line (">") inside a blockquoted reply ends the value', () => {
    const reply = '> ABOUT ME\n> Life: New life\n>\n> Some prose that should not attach.\n> Family win: New fam\n> Health win: New health\n> END ABOUT ME';
    const r = parseAboutMe(reply, EMPTY_PROFILE_FIELDS);
    expect(r.patch.lifeContext).toBe('New life');
    expect(r.patch.burners?.family.winning).toBe('New fam');
  });
});

describe('parseAboutMe adversarial: block choice', () => {
  it('without markers, a gaps list before the profile does not overwrite fields', () => {
    const current = EMPTY_PROFILE_FIELDS;
    const reply = [
      'Three gaps:',
      '- Family: your win has no number.',
      '- Health: the knee needs a plan.',
      '- Work: no boundary on travel weeks.',
      '',
      'Here is your revised profile:',
      'Life: Married to Sarah, two kids, Charlotte.',
      'Family people: Sarah weekly, Maya and Luke daily.',
      'Family win: Dinner at home 4 nights a week.',
      'Friends win: I reach out first.',
      'Health focus: Running, lifting, cranky knee.',
      'Health win: Three workouts a week.',
      'Work focus: Acquisitions lead.',
      'Work win: Deep work four mornings.',
      '',
      'Suggested actions:',
      '- Family: Book a sitter',
    ].join('\n');
    const r = parseAboutMe(reply, current);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['Markers missing, check before replacing.']);
    const next = applyAboutMePatch(current, r.patch);
    expect(next.burners.family.matters).toBe('Sarah weekly, Maya and Luke daily.');
    expect(next.burners.health.matters).toBe('Running, lifting, cranky knee.');
    expect(next.burners.work.matters).toBe('Acquisitions lead.');
  });

  it('without markers, a "Suggested actions:" line right after the last field is not glued onto it', () => {
    const reply = ['Life: A', 'Family win: B', 'Friends win: C', 'Health win: D', 'Work win: E', 'Suggested actions:', '- Health: Walk after lunch'].join(
      '\n',
    );
    const r = parseAboutMe(reply, EMPTY_PROFILE_FIELDS);
    expect(r.patch.burners?.work.winning).toBe('E');
    expect(r.patch.burners?.health.winning).toBe('D');
  });

  it('a reply cut off in the middle of the next label does not glue the fragment onto the previous field', () => {
    const r = parseAboutMe('ABOUT ME\nLife: A\nFamily win: B\nHealth win: C\nWork wi', EMPTY_PROFILE_FIELDS);
    expect(r.warnings).toContain('Reply may be cut off.');
    expect(r.patch.burners?.health.winning).toBe('C');
  });

  it('the packet pasted back inside a code fence, followed by the reply, parses the reply', () => {
    const current = profile();
    const packet = ['```', 'FOUR BURNERS COACH v1', renderAboutMeBlock(current), 'END OF PACKET', '```'].join('\n');
    const reply = edit(renderAboutMeBlock(current), 'Life', 'New life');
    const r = parseAboutMe(`${packet}\n\n${reply}`, current);
    expect(r.isPacketEcho).toBe(false);
    expect(r.changedFields).toEqual(['lifeContext']);
  });
});

describe('parseAboutMe adversarial: travel phrasing', () => {
  const cases: [string, TravelRhythm][] = [
    ['Rarely home', 'mostly_away'],
    ['Hardly ever home', 'mostly_away'],
    ['Almost always home', 'rare'],
    ['Home most weeks', 'rare'],
    ['Mostly home, a trip a quarter', 'rare'],
    ['Two or three nights a week', 'weekly'],
    ['On the road 3 nights a week', 'weekly'],
    ['Frequently', 'weekly'],
    ['Twice a year', 'rare'],
    ['Not much, maybe once a quarter', 'rare'],
    ['No travel', 'rare'],
    ['Never', 'rare'],
    ['A few trips a quarter', 'monthly'],
    ['Once or twice a month', 'monthly'],
    ['Most weeks, home on weekends', 'weekly'],
  ];
  for (const [text, want] of cases) {
    it(`"${text}" maps to ${want}`, () => {
      const current = profile({ travel: null });
      const r = parseAboutMe(edit(renderAboutMeBlock(current), 'Travel', text), current);
      expect(r.patch.travel).toBe(want);
    });
  }

  it('an echoed option list is a placeholder, not a choice', () => {
    const current = profile({ travel: 'rare' });
    const r = parseAboutMe(edit(renderAboutMeBlock(current), 'Travel', 'Rarely | A trip or two a month | Most weeks | More away than home'), current);
    expect(r.changedFields).toEqual([]);
    expect('travel' in r.patch).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// renderAboutMeBlock and profileLine

describe('renderAboutMeBlock adversarial: dash lookalikes', () => {
  it('never emits a dash that NFKC folds into an em or en dash (small and vertical dash forms)', () => {
    for (const d of ['\uFE58', '\uFE31', '\uFE32', '\u2E3A', '\u2014', '\u2013']) {
      const p = profile({ lifeContext: `Home ${d} Charlotte, 2${d}3 trips`, crunch: `late${d}nights` });
      const block = renderAboutMeBlock(p);
      expect(block, d).not.toMatch(HAS_DASH);
      expect(block.normalize('NFKC'), d).not.toMatch(HAS_DASH);
      expect(profileLine(p).normalize('NFKC'), d).not.toMatch(HAS_DASH);
      expect(block, d).toContain('Life: Home, Charlotte, 2 to 3 trips');
    }
  });

  it('round trips stay stable for values that look like markers, labels, or placeholders', () => {
    const values = ['ABOUT ME', 'END ABOUT ME', 'Suggested actions: none', 'Work: busy. Home: Charlotte', '- Family first', '(unchanged)', 'None'];
    for (const v of values) {
      const p = profile({ lifeContext: v, crunch: `Crunch: ${v}` });
      const block = renderAboutMeBlock(p);
      expect(block.split('\n'), v).toHaveLength(13);
      const r = parseAboutMe(block, p);
      expect(r.ok, v).toBe(true);
      expect(r.changedFields, v).toEqual([]);
      expect(renderAboutMeBlock(applyAboutMePatch(p, r.patch)), v).toBe(block);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// parsePeople

describe('parsePeople adversarial', () => {
  it('parses the reviewer sample sentences', () => {
    expect(pairs(parsePeople('Mom and Dad weekly; my sister Katie every other week', 'family').people)).toEqual([
      ['Mom', 7],
      ['Dad', 7],
      ['Katie (sister)', 14],
    ]);
    expect(pairs(parsePeople('the college crew monthly', 'friends').people)).toEqual([['The college crew', 30]]);
    expect(pairs(parsePeople("Sean O'Brien and Mary-Kate, every two weeks", 'friends').people)).toEqual([
      ["Sean O'Brien", 14],
      ['Mary-Kate', 14],
    ]);
    expect(pairs(parsePeople('Sarah (wife) every week', 'family').people)).toEqual([['Sarah (wife)', 7]]);
    expect(parsePeople('', 'family')).toEqual({ people: [], leftovers: [] });
  });

  it('capitalizes lowercase names with apostrophes and hyphens the way they are written', () => {
    expect(pairs(parsePeople("o'brien and mary-kate monthly", 'friends').people)).toEqual([
      ["O'Brien", 30],
      ['Mary-Kate', 30],
    ]);
    expect(pairs(parsePeople("mary-kate o'neil, weekly. d'angelo", 'friends').people)).toEqual([
      ["Mary-Kate O'Neil", 7],
      ["D'Angelo", 30],
    ]);
    expect(pairs(parsePeople('my sister mary-kate, every other week', 'family').people)).toEqual([['Mary-Kate (sister)', 14]]);
    // Written capitalization is kept as typed.
    expect(pairs(parsePeople('Mary-kate, weekly', 'friends').people)).toEqual([['Mary-kate', 7]]);
  });

  it('a later spoken cadence beats the default from an earlier bare mention of the same name', () => {
    const r = parsePeople('Mom, Dad, and Katie. Mom and Dad weekly, Katie every other week.', 'family');
    expect(pairs(r.people)).toEqual([
      ['Mom', 7],
      ['Dad', 7],
      ['Katie', 14],
    ]);
    // Two spoken cadences: the first one still wins.
    expect(pairs(parsePeople('Jake weekly. Jake monthly. jake.', 'friends').people)).toEqual([['Jake', 7]]);
  });

  it('drops trailing words like "more" and "more often" instead of making them the name', () => {
    expect(pairs(parsePeople('I want to call my mom more often', 'family').people)).toEqual([['Mom', 7]]);
    expect(pairs(parsePeople('call my mom more', 'family').people)).toEqual([['Mom', 7]]);
    expect(pairs(parsePeople('my sister Katie more, monthly', 'family').people)).toEqual([['Katie (sister)', 30]]);
    expect(pairs(parsePeople('my mom on the phone, every Sunday', 'family').people)).toEqual([['Mom', 7]]);
  });

  it('reads "Katie my sister" without the comma, and cleans "(my wife)" to "(wife)"', () => {
    expect(pairs(parsePeople('Katie my sister, every other week', 'family').people)).toEqual([['Katie (sister)', 14]]);
    expect(pairs(parsePeople('Dave my college roommate, monthly', 'friends').people)).toEqual([['Dave (college roommate)', 30]]);
    expect(pairs(parsePeople('Sarah (my wife) every week', 'family').people)).toEqual([['Sarah (wife)', 7]]);
  });

  it('drops number-only parentheticals like ages', () => {
    expect(pairs(parsePeople('Maya (12) and Luke (9), every day', 'family').people)).toEqual([
      ['Maya', 3],
      ['Luke', 3],
    ]);
  });

  it('never turns the speaker into a person or a leftover', () => {
    expect(parsePeople('Sarah and I', 'family')).toEqual({ people: [{ name: 'Sarah', burner: 'family', cadenceDays: 7, include: true }], leftovers: [] });
    expect(pairs(parsePeople('me and Sarah, daily', 'family').people)).toEqual([['Sarah', 3]]);
  });

  it("handles someone else's relation: \"his wife Linda\" is Linda, \"her kids\" is a group", () => {
    expect(pairs(parsePeople('my brother Tom and his wife Jen, monthly', 'family').people)).toEqual([
      ['Tom (brother)', 30],
      ['Jen', 30],
    ]);
    expect(pairs(parsePeople('Katie and her kids monthly', 'family').people)).toEqual([
      ['Katie', 30],
      ['Her kids', 30],
    ]);
  });

  it('reads shorthand cadences: wks, mos, 2x a month, once every two weeks', () => {
    const cases: [string, number][] = [
      ['every 2 wks', 14],
      ['every 3 mos', 90],
      ['2x a month', 14],
      ['3x a week', 3],
      ['once every two weeks', 14],
      ['once every month', 30],
    ];
    for (const [phrase, days] of cases) {
      const r = parsePeople(`Jake, ${phrase}`, 'friends');
      expect(pairs(r.people), phrase).toEqual([['Jake', days]]);
      expect(r.leftovers, phrase).toEqual([]);
    }
  });

  it('sends a clause that starts with "but" or "because" to leftovers, not people', () => {
    const r = parsePeople('Mom every Sunday, but honestly it slips', 'family');
    expect(pairs(r.people)).toEqual([['Mom', 7]]);
    expect(r.people.some((p) => /slips/i.test(p.name))).toBe(false);
  });

  it('handles a long rambling dictation without inventing people', () => {
    const text =
      'Okay so obviously Sarah, my wife, every single day, that one is easy. The kids too, Maya and Luke, I want real time with them every day I am home. ' +
      'My mom I try to call every Sunday but honestly it slips. My dad and his wife Linda maybe once a month. ' +
      'My sister Katie every other week or so, she has three kids so it is hard to connect. And my brother-in-law Tom, a few times a year. ' +
      "I guess that's it. Oh and Grandma Rose, every couple of weeks if I can.";
    const r = parsePeople(text, 'family');
    expect(pairs(r.people)).toEqual([
      ['Sarah (wife)', 3],
      ['The kids', 3],
      ['Maya', 3],
      ['Luke', 3],
      ['Dad', 30],
      ['Linda', 30],
      ['Katie (sister)', 14],
      ['Tom (brother-in-law)', 90],
      ['Grandma Rose', 14],
    ]);
    expect(r.people.every((p) => p.name.split(' ').length <= 4)).toBe(true);
    expect(r.leftovers).toContain('My mom I try to call');
  });

  it('stays fast on a very long dictation', () => {
    const text = Array.from({ length: 200 }, (_, i) => `um so like my friend Person${i} and Pal${i}, every ${(i % 4) + 1} weeks or so, if I can`).join('. ');
    const r = parsePeople(text, 'friends');
    expect(r.people).toHaveLength(400);
    expect(r.people[0]).toEqual({ name: 'Person0 (friend)', burner: 'friends', cadenceDays: 7, include: true });
  });
});
