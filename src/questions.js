// Question bank. Two layers:
//  - onboarding (trait layer, "Reader DNA"): asked once, editable, re-asked rarely
//  - checkin (state layer, "right now"): asked every session, kept short
// Every question is closed with an "Other / my own words" escape. `showIf(ctx)` gates branching.
// Vocabulary follows readers' advisory appeal factors (pace, tone, style, character, storyline),
// StoryGraph moods and Whichbook bipolar sliders; the LLM reads the ids, so keep ids meaningful.

const S = (id, label, hint) => ({ id, label, hint });

export const ONBOARDING = [
  {
    id: 'loved_books', layer: 'onboarding', type: 'text',
    text: 'Name 2 to 5 books you genuinely loved (any time in your life). Add a few words on WHY if you can.',
    help: 'Title plus author is enough. Why matters more than what: "could not stop", "felt like a hug", "the prose", "the twist", "the world".',
    placeholder: 'e.g. Piranesi (Clarke) - the strangeness and calm; Pachinko - generations, quiet devastation; ...',
    required: true,
  },
  {
    id: 'abandoned_books', layer: 'onboarding', type: 'text',
    text: 'Books you abandoned or actively disliked, and why.',
    help: 'This is the most valuable answer in the whole interview. Hype letdowns count.',
    placeholder: 'e.g. Dune - too much lore before anything happened; The Alchemist - preachy; ...',
  },
  {
    id: 'doorway', layer: 'onboarding', type: 'single',
    text: 'When a book grabs you, what is usually the door you walk in through?',
    help: 'Nancy Pearl\'s "doorways". Pick the one that is true most often.',
    options: [
      S('story', 'Story', 'What happens next; I turn pages for the plot'),
      S('character', 'Character', 'I need to care about someone; I would follow them anywhere'),
      S('setting', 'Setting / world', 'A place or era I can live inside'),
      S('language', 'Language', 'Sentences I want to reread; voice and style'),
      S('ideas', 'Ideas', 'A book that rearranges how I think'),
    ],
  },
  {
    id: 'pace_baseline', layer: 'onboarding', type: 'single',
    text: 'Your usual pace preference?',
    options: [
      S('fast', 'Fast', 'Short chapters, momentum, things happen'),
      S('intensifying', 'Slow start that accelerates', 'I will forgive a slow setup if it pays off'),
      S('leisurely', 'Leisurely', 'I like to linger; pace is not the point'),
      S('depends', 'Depends on mood', 'Genuinely varies'),
    ],
  },
  {
    id: 'prose_baseline', layer: 'onboarding', type: 'single',
    text: 'Prose you enjoy most?',
    options: [
      S('spare', 'Spare and clean', 'Hemingway, Sally Rooney, thrillers'),
      S('lush', 'Lush and lyrical', 'Rich sentences, imagery, atmosphere'),
      S('witty', 'Witty and conversational', 'Banter, voice, dry humour'),
      S('invisible', 'Invisible', 'I do not notice prose, and I like it that way'),
    ],
  },
  {
    id: 'feel_vs_think', layer: 'onboarding', type: 'single',
    text: 'Which of these is closer to why you read?',
    help: 'Two separate appetites: feeling a lot, and working the mind. Both is a real answer.',
    options: [
      S('feel', 'To feel deeply', 'I want to be moved, even wrecked'),
      S('think', 'To think hard', 'I want to be challenged; effort is pleasure'),
      S('both', 'Both, equally', ''),
      S('escape', 'Mostly to escape', 'Transport me; the rest is optional'),
      S('learn', 'To learn', 'I read mostly to know things'),
    ],
  },
  {
    id: 'fiction_ratio', layer: 'onboarding', type: 'single',
    text: 'Fiction vs nonfiction, over a typical year?',
    options: [
      S('fiction', 'Almost all fiction', ''),
      S('mostly_fiction', 'Mostly fiction, some nonfiction', ''),
      S('half', 'About half and half', ''),
      S('mostly_nonfiction', 'Mostly nonfiction', ''),
    ],
  },
  {
    id: 'genres_love', layer: 'onboarding', type: 'multi',
    text: 'Genres you reach for (pick any). Treated as a soft signal, not a filter.',
    options: [
      S('literary', 'Literary fiction'), S('crime', 'Crime / mystery'), S('thriller', 'Thriller / suspense'),
      S('sff', 'Science fiction'), S('fantasy', 'Fantasy'), S('horror', 'Horror'), S('romance', 'Romance'),
      S('historical', 'Historical fiction'), S('classics', 'Classics'), S('magical_realism', 'Magical realism / weird'),
      S('memoir', 'Memoir / biography'), S('popsci', 'Popular science'), S('history', 'History'), S('psychology', 'Psychology / self-understanding'),
      S('essays', 'Essays'), S('reportage', 'Reportage / true stories'), S('poetry', 'Poetry'), S('graphic', 'Graphic novels'), S('ya', 'YA'), S('humor', 'Humour'),
    ],
  },
  {
    id: 'genres_avoid', layer: 'onboarding', type: 'multi',
    text: 'Genres you almost never enjoy (soft avoid).',
    options: [
      S('literary', 'Literary fiction'), S('crime', 'Crime / mystery'), S('thriller', 'Thriller / suspense'),
      S('sff', 'Science fiction'), S('fantasy', 'Fantasy'), S('horror', 'Horror'), S('romance', 'Romance'),
      S('historical', 'Historical fiction'), S('classics', 'Classics'), S('selfhelp', 'Self-help'), S('business', 'Business'),
      S('ya', 'YA'), S('poetry', 'Poetry'), S('graphic', 'Graphic novels'), S('none', 'Nothing is off the table'),
    ],
  },
  {
    id: 'dealbreakers', layer: 'onboarding', type: 'multi',
    text: 'Hard dealbreakers: content you do not want in a book, full stop.',
    help: 'These become hard filters. Use "Other" for anything specific (phobias, topics you are living through).',
    options: [
      S('sexual_violence', 'Sexual violence'), S('child_harm', 'Harm to children'), S('animal_harm', 'Harm to animals'),
      S('graphic_violence', 'Graphic violence / gore'), S('explicit_sex', 'Explicit sex'), S('suicide_selfharm', 'Suicide / self-harm'),
      S('addiction', 'Addiction'), S('eating_disorders', 'Eating disorders'), S('body_horror', 'Body horror'),
      S('religious_preaching', 'Religious preaching'), S('none', 'No hard dealbreakers'),
    ],
  },
  {
    id: 'turnoffs', layer: 'onboarding', type: 'multi',
    text: 'Soft turn-offs: things that make you roll your eyes or drift away.',
    options: [
      S('slow_start', 'Slow starts'), S('info_dump', 'Lore / info dumps'), S('unlikeable_lead', 'Protagonists I cannot stand'),
      S('love_triangle', 'Love triangles'), S('miscommunication', 'Plots built on misunderstandings'), S('purple_prose', 'Overwritten prose'),
      S('preachy', 'Preachiness / message first'), S('cliffhanger_series', 'Cliffhangers that force the next book'), S('bleak_ending', 'Bleak endings'),
      S('twee', 'Twee / cutesy'), S('male_gaze', 'Male-gaze writing'), S('huge_cast', 'Huge casts I cannot track'), S('present_tense', 'Present-tense narration'),
      S('trauma_plot', 'Trauma as the whole plot'), S('none', 'None of these bother me'),
    ],
  },
  {
    id: 'length_series', layer: 'onboarding', type: 'single',
    text: 'Length and series?',
    options: [
      S('short_standalone', 'Short standalones', 'Under ~300 pages, done in days'),
      S('any_standalone', 'Any length, standalone', 'Doorstoppers fine, but one book'),
      S('series_ok', 'Series are welcome', 'I like committing'),
      S('depends', 'Depends on mood', ''),
    ],
  },
  {
    id: 'era', layer: 'onboarding', type: 'multi',
    text: 'Which of these do you happily read?',
    options: [
      S('new', 'Just published (last 2 years)'), S('contemporary', 'Contemporary (last 25 years)'), S('late20c', '20th century'),
      S('classics', 'Older classics'), S('translated', 'Translated / non-Anglophone'), S('polish', 'Polish literature'),
    ],
  },
  {
    id: 'languages', layer: 'onboarding', type: 'multi',
    text: 'Languages you read in?',
    options: [S('en', 'English'), S('pl', 'Polish'), S('other', 'Other (say which)')],
  },
  {
    id: 'formats', layer: 'onboarding', type: 'multi',
    text: 'Formats you actually use?',
    options: [S('paper', 'Paper'), S('ebook', 'E-reader / phone'), S('audio', 'Audiobook')],
  },
  {
    id: 'proxies', layer: 'onboarding', type: 'text',
    text: 'Films, series, games or music whose FEELING you would like to find in a book.',
    help: 'Taste crosses media. "Arrival", "Severance", "Fleabag", "Disco Elysium", "Radiohead" all tell me something different.',
    placeholder: 'e.g. Severance (the uncanny office dread), Before Sunrise (talk as plot), Hades (myth retold with wit)...',
  },
  {
    id: 'reading_life', layer: 'onboarding', type: 'single',
    text: 'How is your reading life lately?',
    options: [
      S('steady', 'Steady', 'A book or more a month'),
      S('bursts', 'In bursts', 'Nothing for weeks, then three in a row'),
      S('slump', 'In a slump', 'I want to read and cannot get going'),
      S('returning', 'Returning after a long gap', ''),
    ],
  },
  {
    id: 'why_read', layer: 'onboarding', type: 'multi',
    text: 'What does reading do for you, mostly?',
    options: [
      S('escape', 'Escape / rest'), S('insight', 'Self-understanding'), S('aesthetic', 'Beauty / pleasure in craft'),
      S('knowledge', 'Knowledge'), S('company', 'Company / less alone'), S('identity', 'It is part of who I am'),
      S('social', 'Talking about books with people'), S('calm', 'Calming my mind before sleep'),
    ],
  },
];

export const CHECKIN = [
  {
    id: 'mood_now', layer: 'checkin', type: 'single',
    text: 'How are you, right now, honestly?',
    options: [
      S('good_energetic', 'Good and energetic', ''),
      S('good_calm', 'Good and calm', ''),
      S('flat', 'Flat / bored / numb', ''),
      S('stressed', 'Stressed / overloaded', ''),
      S('low', 'Low / sad', ''),
      S('raw', 'Raw (grief, breakup, big change)', ''),
      S('restless', 'Restless / cannot focus', ''),
    ],
  },
  {
    id: 'need_now', layer: 'checkin', type: 'single',
    text: 'What do you need a book to DO for you right now?',
    help: 'Mood management: a low mood can want distraction, comfort, or company in the dark. Only you know which.',
    options: [
      S('distract', 'Distract me', 'Grip me so I forget the day'),
      S('comfort', 'Comfort me', 'Warm, safe, kind'),
      S('sit_with_it', 'Sit with it', 'Something that matches how I feel and does not flinch'),
      S('thrill', 'Thrill me', 'Dread, tension, twists'),
      S('think', 'Make me think', 'Ideas, puzzle, argument'),
      S('laugh', 'Make me laugh', ''),
      S('awe', 'Give me awe', 'Scale, strangeness, wonder'),
      S('learn', 'Teach me something', ''),
      S('feel', 'Make me feel a lot', 'Cry if needed'),
    ],
  },
  {
    id: 'demand_now', layer: 'checkin', type: 'scale',
    text: 'How much effort can you give a book this week?',
    left: 'Easy, I need it to carry me', right: 'Demanding, I want to work',
    options: [S('1', 'Easy'), S('2', ''), S('3', 'Medium'), S('4', ''), S('5', 'Demanding')],
  },
  {
    id: 'time_now', layer: 'checkin', type: 'single',
    text: 'How will you read this one?',
    options: [
      S('one_sitting', 'One sitting / a weekend', 'Short, immersive'),
      S('this_week', 'Over a week or two', ''),
      S('slow_month', 'Slowly, over a month or more', 'A companion book'),
      S('commute', 'In fragments (commute, waiting)', 'Short chapters help'),
      S('audio', 'Mostly as audio', 'While walking / driving'),
    ],
  },
  {
    id: 'tone_now', layer: 'checkin', type: 'scale',
    text: 'Tonight: light or dark?',
    left: 'Light / hopeful', right: 'Dark / bleak',
    options: [S('1', 'Light'), S('2', ''), S('3', 'In between'), S('4', ''), S('5', 'Dark')],
  },
  {
    id: 'safe_now', layer: 'checkin', type: 'scale',
    text: 'Safe or disturbing?',
    left: 'Safe, nothing that will haunt me', right: 'Disturb me, I can take it',
    options: [S('1', 'Safe'), S('2', ''), S('3', 'Some edge'), S('4', ''), S('5', 'Disturbing')],
  },
  {
    id: 'familiar_now', layer: 'checkin', type: 'single',
    text: 'Familiar or strange?',
    options: [
      S('familiar', 'Give me more of what I know I love', ''),
      S('adjacent', 'Adjacent: same feeling, new territory', ''),
      S('strange', 'Surprise me; I want something I would not pick myself', ''),
    ],
  },
  {
    id: 'form_now', layer: 'checkin', type: 'single',
    text: 'Fiction or nonfiction this time?',
    options: [S('fiction', 'Fiction'), S('nonfiction', 'Nonfiction'), S('either', 'Either, whatever fits')],
  },
  {
    id: 'lang_format_now', layer: 'checkin', type: 'multi',
    text: 'Language and format for THIS book?',
    options: [S('en', 'English'), S('pl', 'Polish'), S('paper', 'Paper'), S('ebook', 'E-book'), S('audio', 'Audio')],
  },
  {
    id: 'life_now', layer: 'checkin', type: 'multi',
    text: 'Anything going on in life that the book should know about?',
    help: 'Optional. Books can meet you where you are, or deliberately not.',
    options: [
      S('nothing', 'Nothing special'), S('work_stress', 'Work stress / burnout'), S('relationship', 'Relationship stuff'),
      S('grief', 'Grief / loss'), S('transition', 'Big transition (move, job, identity)'), S('health', 'Health'),
      S('travel', 'Travelling soon'), S('holiday', 'On holiday / free time'), S('insomnia', 'Sleeping badly'),
      S('lonely', 'Lonely'), S('in_love', 'In love / new relationship'), S('creative', 'Creative project'),
    ],
  },
  {
    id: 'last_book', layer: 'checkin', type: 'text',
    text: 'Last book you read (or are reading) and how it landed, in a few words.',
    help: 'Anchors the recommendation without letting one book define you.',
    placeholder: 'e.g. Tomorrow and Tomorrow and Tomorrow - loved the friendship, dragged in the middle',
  },
  {
    id: 'wish_now', layer: 'checkin', type: 'text',
    text: 'Any specific itch? A theme, place, question, trope, or "something like X but Y".',
    help: 'Optional. This box is where the best hits come from.',
    placeholder: 'e.g. something set by the sea; a smart book about work; like Severance but a novel; no romance please',
  },
];

// Quick mode: the minimum that still produces a good slate when the trait profile already exists.
export const QUICK_IDS = ['mood_now', 'need_now', 'demand_now', 'time_now', 'familiar_now', 'wish_now'];

// Reading path: a few books over weeks that form an arc, from where you are to where you want to be.
export const PATH = [
  {
    id: 'path_arc', layer: 'path', type: 'single',
    text: 'What journey do you want these books to take you on?',
    help: 'A path is two to four books in order. Each one moves you a step; the last one is where you want to arrive.',
    options: [
      S('numb_to_feeling', 'From numb to feeling something again', ''),
      S('wound_to_calm', 'From wound-up to calm', ''),
      S('heavy_to_light', 'From heavy to light', 'Earn the laugh'),
      S('scattered_to_focus', 'From scattered to able to sit with a long book', 'Short and gripping first, then slower and bigger'),
      S('through_loss', 'Through a loss, gently', ''),
      S('deepen', 'Deeper into one theme or question', ''),
      S('build_up', 'Build up to a demanding book I keep avoiding', 'Name it in the next questions'),
      S('widen', 'Out of my comfort zone, one step at a time', ''),
      S('rest', 'A month of pure rest and pleasure', ''),
    ],
  },
  {
    id: 'path_to', layer: 'path', type: 'text',
    text: 'Where do you want to be at the end of it? One sentence.',
    help: 'How you want to feel, or what you want to be able to do, or understand.',
    placeholder: 'e.g. calm enough to read a long Russian novel; curious again; able to think about my father without flinching',
  },
  {
    id: 'path_books', layer: 'path', type: 'single',
    text: 'How many books?',
    options: [S('2', 'Two', 'A short arc'), S('3', 'Three', 'The classic shape: ease in, the turn, the arrival'), S('4', 'Four', 'A longer climb')],
  },
  {
    id: 'path_weeks', layer: 'path', type: 'single',
    text: 'Over how long?',
    options: [S('3', 'Three weeks'), S('4', 'A month'), S('6', 'Six weeks'), S('8', 'Two months'), S('open', 'No deadline')],
  },
  {
    id: 'path_link', layer: 'path', type: 'single',
    text: 'How should the books connect?',
    options: [
      S('feeling', 'By feeling', 'Each book shifts the mood one notch'),
      S('theme', 'By a thread', 'One theme, place or question running through'),
      S('contrast', 'By contrast', 'Deliberate opposites that talk to each other'),
      S('world', 'By world', 'Same place, era or author circle'),
      S('free', 'Let the tool decide', ''),
    ],
  },
  {
    id: 'path_theme', layer: 'path', type: 'text',
    text: 'A theme, place, question, or the book you want to build toward? Optional.',
    placeholder: 'e.g. the sea; work and dignity; "Anna Karenina" at the end; Polish reportage',
  },
];
export const PATH_CHECKIN_IDS = ['mood_now', 'life_now', 'demand_now', 'time_now', 'lang_format_now', 'safe_now'];

// Gift mode: a short interview about someone else. The reader's own profile is not used.
export const GIFT = [
  {
    id: 'gift_who', layer: 'gift', type: 'text', required: true,
    text: 'Who is it for? Name or relationship, roughly their age, and anything that matters.',
    placeholder: 'e.g. my brother, 40, engineer, new dad, dry sense of humour',
  },
  {
    id: 'gift_loved', layer: 'gift', type: 'text',
    text: 'Books, films or series they loved. Guesses are fine.',
    help: 'What they talk about, reread, or quote. If you do not know, say what they do with their evenings.',
    placeholder: 'e.g. loved The Martian, watches every Scandinavian crime series, reread Hobbit as a kid',
  },
  {
    id: 'gift_avoid', layer: 'gift', type: 'multi',
    text: 'What would they hate, or what must the book not be?',
    options: [
      S('dark', 'Nothing dark or bleak'), S('romance', 'No romance'), S('long', 'Nothing long'), S('series', 'No series'),
      S('explicit', 'Nothing explicit'), S('literary', 'Nothing too "literary"'), S('genre', 'Nothing too genre'), S('nonfiction', 'No nonfiction'), S('fiction', 'No fiction'),
    ],
  },
  {
    id: 'gift_reading', layer: 'gift', type: 'single',
    text: 'How much do they read?',
    options: [S('lot', 'A lot', 'Will have read the obvious things'), S('some', 'Now and then', ''), S('rarely', 'Rarely', 'The book must hook fast'), S('lapsed', 'Used to, stopped', 'Something to bring them back')],
  },
  {
    id: 'gift_occasion', layer: 'gift', type: 'single',
    text: 'What is the occasion?',
    options: [S('birthday', 'Birthday'), S('holiday', 'Holiday / Christmas'), S('hard_time', 'A hard time', 'Illness, loss, burnout'), S('thanks', 'A thank-you'), S('just', 'Just because'), S('travel', 'A trip')],
  },
  {
    id: 'gift_do', layer: 'gift', type: 'single',
    text: 'What should the book do for them?',
    options: [S('comfort', 'Comfort them'), S('laugh', 'Make them laugh'), S('think', 'Make them think'), S('thrill', 'Grip them'), S('beauty', 'Give them something beautiful'), S('learn', 'Teach them something'), S('feel', 'Move them'), S('impress', 'Show you know them')],
  },
  {
    id: 'gift_format', layer: 'gift', type: 'multi',
    text: 'Language and format?',
    options: [S('en', 'English'), S('pl', 'Polish'), S('paper', 'Paper'), S('ebook', 'E-book'), S('audio', 'Audio')],
  },
  {
    id: 'gift_note', layer: 'gift', type: 'text',
    text: 'Anything else? What they are going through, what you want the gift to say.',
    placeholder: 'e.g. she just moved abroad and is lonely; I want it to say "I see you"',
  },
];

export function questionById(id) {
  return [...ONBOARDING, ...CHECKIN, ...PATH, ...GIFT].find((q) => q.id === id) || null;
}
