// Step-by-step recipes for the Shortcuts you build on your iPhone (Shortcuts can't be installed by a web app).
// Shown in Settings > Shortcuts and Siri and summarized in the README. No em dashes.

export interface Recipe {
  id: string;
  title: string;
  /** What you say to Siri, when it applies. */
  siri?: string;
  summary: string;
  steps: string[];
}

/** The request every recipe uses. */
export const REQUEST_STEPS = [
  'Add "Get Contents of URL". Tap the URL and paste your Shortcuts address (above).',
  'Tap the arrow (Show More). Method: POST.',
  'Headers: Add new header. Key: Authorization. Value: Bearer, a space, then your token.',
  'Request Body: JSON. Add the fields listed in the recipe (all as Text unless it says Number).',
];

/** The reply every recipe ends with: Siri reads it out. */
export const REPLY_STEPS = ['Add "Get Dictionary Value": Get Value for key message in Contents of URL.', 'Add "Show Result" with that Dictionary Value. Siri reads it out.'];

/** How to send "at": the phone's own time, so entries land on the day you are living wherever you are. */
export const AT_FIELD = 'at = Current Date. Tap the Current Date token > Date Format: ISO 8601, with Include Time on.';

export const RECIPES: Recipe[] = [
  {
    id: 'one-goal',
    title: 'Log one goal by voice',
    siri: 'Hey Siri, log date night',
    summary: 'One small Shortcut per goal you log often. Siri runs a Shortcut by its name.',
    steps: [
      'Shortcuts app > + (new Shortcut). Name it what you will say, like "Log date night".',
      ...REQUEST_STEPS,
      'Fields: action = log. goal = Date night (any part of the goal\'s name works). ' + AT_FIELD,
      'Number goals (miles, pages): first add "Ask for Input" (Number, "How many?") and add the field value = Provided Input.',
      ...REPLY_STEPS,
    ],
  },
  {
    id: 'any-goal',
    title: 'Log any goal from a list',
    siri: 'Hey Siri, Burner log',
    summary: 'Pick the goal from a list, then the amount.',
    steps: [
      'New Shortcut named "Burner log".',
      ...REQUEST_STEPS,
      'Fields: action = goals.',
      'Add "Get Dictionary Value": Get Value for key items in Contents of URL. Then "Choose from List" (prompt "Which goal?").',
      'Add "Ask for Input": Number, prompt "How many? 1 for habits", default answer 1.',
      'Add a second "Get Contents of URL" set up the same way, with fields: action = log, goal = Chosen Item, value = Provided Input. ' + AT_FIELD,
      ...REPLY_STEPS,
    ],
  },
  {
    id: 'touch',
    title: 'Log a connection with someone',
    siri: 'Hey Siri, Reached out',
    summary: 'Pick the person and how you connected.',
    steps: [
      'New Shortcut named "Reached out".',
      ...REQUEST_STEPS,
      'Fields: action = people. Then "Get Dictionary Value" for key items, and "Choose from List" (prompt "Who?").',
      'Add "Choose from Menu" with options Call, Text, In person, Other.',
      'In every option add the same "Get Contents of URL" with fields: action = touch, person = Chosen Item, type = the option\'s name. ' + AT_FIELD,
      'After the menu: ' + REPLY_STEPS.join(' '),
      'To skip the list for one person, make a Shortcut like "Called Mom" with person = Mom and type = call.',
    ],
  },
  {
    id: 'health',
    title: 'Send Apple Health every evening',
    summary: 'A daily automation that sends today\'s numbers to the Health goals you linked below.',
    steps: [
      'Shortcuts app > Automation > + > Time of Day: 9:30 PM, Daily, Run Immediately. Then New Blank Automation.',
      'Steps: "Find Health Samples" where Type is Steps and Start Date is today, with Group By: Day (this merges iPhone and Apple Watch so steps are not counted twice). Then "Calculate Statistics": Sum of Health Samples.',
      'Exercise minutes: the same with Type Exercise Minutes (Group By: Day), then "Calculate Statistics": Sum.',
      'Workouts: "Find Workouts" (or "Find Health Samples" with Type Workouts) where Start Date is today. Then "Count" Items.',
      'Sleep (optional): "Find Health Samples" where Type is Sleep Analysis, Start Date is in the last 1 day, and Value is not In Bed and not Awake (so Core, Deep and REM all count). "Get Details of Health Sample": Duration. "Calculate Statistics": Sum. Check the result with "Show Result" once: send it as sleepHours, sleepMinutes or sleepSeconds to match its unit.',
      ...REQUEST_STEPS,
      'Fields (Number, using each Statistics result): steps, activeMinutes, workouts, sleepHours. Plus action = health, date = Current Date with Date Format Custom yyyy-MM-dd. ' + AT_FIELD,
      'Optional: "Show Notification" with the message, to see what was applied. Sending again the same day replaces that day\'s numbers, never doubles them.',
    ],
  },
];
