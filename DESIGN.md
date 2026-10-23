# Design notes

Why the tool is built the way it is. Sources are summarised; the research behind them came from readers'-advisory literature (Saricks, Wyatt, Pearl), NoveList's appeal taxonomy, StoryGraph and Whichbook, mood-management psychology, and recommender-systems work on diversity, serendipity and explanation.

## 1. Ask about appeal, not genre
Librarians found decades ago that readers do not want "another spy novel"; they want the same *pacing*, *tone*, *characterization*, *storyline* and *frame*. Genre is a soft signal only. The whole prompt chain (`src/prompts.js`) speaks NoveList-style appeal vocabulary, and the brief translates every answer into those terms.

## 2. Trait vs state
Taste is stable; what you need tonight is not. Two layers:
- **Trait** ("Reader DNA"): asked once, confirmable later with the previous answer shown, superseded rather than overwritten so drift is visible.
- **State**: mood, need, effort, time, light/dark, safe/disturbing, novelty, life context. Asked every session, stored per session.
State wins for "which book now"; trait vetoes (dealbreakers).

## 3. Negative signal is worth more than positive
Dislikes, abandoned books and dealbreakers predict failure better than likes predict success. The interview asks for abandoned books with reasons, hard dealbreakers (filters) and soft turn-offs (penalties). The ranking step matches each candidate's 1-3 star review themes against those turn-offs and says so explicitly.

## 4. Mood management, not mood repair by default
A low mood may want distraction, comfort, or company in the dark. The check-in asks "what should the book DO" (distract / comfort / sit with it / thrill / think / laugh / awe / learn / feel) instead of assuming cheer-up.

## 5. Short, closed, with an escape hatch
Survey telemetry shows completion drops steeply past ~15 items and ~7 minutes; forced-choice beats Likert on completion. Check-in is ~12 closed items (quick mode 6), then 2-3 LLM follow-ups, each with an "Other / my own words" box because free text is where the best signal lives. Keyboard 1-9 selects.

## 6. Adaptive follow-ups do real work
Claude designs the last questions from the whole context: reconcile contradictions, pairwise "which of these two blurbs tonight", clarify free text, probe a dealbreaker made relevant by the mood. It never asks what is already known.

## 7. Real data per candidate, cached forever
Ratings cluster at 3.8-4.2 and are inflated for hyped books, so the mean is weak evidence. Per book the tool stores description, genres, full 1-5 star distribution and the 30 most-liked real reviews; Claude writes a digest (praise, complaints, who loves it, who should skip, first-100-pages feel, content notes, verbatim quotes, polarising flag). Digests are reused across sessions.

## 8. Slate design
Never five of the same thing. The brief names slots (safe bet, stretch, wildcard/serendipity, short/comfort, ...) and the ranker fills them, ordering by likelihood that the reader *starts and finishes this week*, not prestige. Runners-up and dropped candidates (with reasons) are shown for transparency.

## 9. Explanation format
Per pick: headline, "why now" tied to today's answers, what readers love, what readers complain about (flagging matches to the reader's turn-offs), the single biggest risk for this reader, read-if / skip-if, how to approach the opening. Second person, specific, no "perfect".

## 10. Learning loop
Every save, rejection (with reason), finished rating/verdict and DNF reason is stored. "Rebuild Reader DNA" reads everything and writes inferred patterns with confidence and evidence; the reader can delete wrong ones. Anything read, shelved, shown or rejected is excluded from future long lists ("Someday"/"Maybe" may resurface).

## 11. Interface
Readability first: 18px reading face (Literata) at a 65-character measure, secondary text never lighter than 7:1 contrast, light paper by default with a deliberately designed dark theme behind a toggle. Fraunces for headings and questions, Instrument Sans for controls. The interview is one question per screen with keycaps, Enter, Back, a 400ms auto-advance on single choice, a short reaction line after each answer, and a summary before the research starts. The five-minute job shows a paced percentage, the current step, a time estimate and the brief as soon as it exists. Only book cards are cards; everything else is flat sections. Covers are always 2:3 with a text fallback.

## 12. Conversation and single-book verdicts
A slate answers "what should I read"; it cannot answer the follow-ups a reader actually has ("how slow is the opening, really?", "does the dog die?", "is there a Polish edition?"). So every book carries a conversation grounded in the same real reviews and the reader's profile, with spoilers only on request and web search reserved for facts outside the reviews. The "Should I read this?" verdict is the reverse direction of the same engine: a book the reader already has in mind, judged against trait, state and the 1-3 star reviews, with "no" as a legitimate answer. Both are stored, so a verdict or chat is there when the reader returns.

## 13. Seeing drift
State answers are only useful if the reader can see them change. "Mood over time" draws the three scales (effort, light/dark, safe/disturbing) as single-series strip charts over check-ins, with mood and need in words underneath (no colour coding of seven moods; words are more honest), and states a few deterministic patterns. The weekly automatic rebuild keeps the Reader DNA from going stale without the reader having to remember a button; it runs only when there is new evidence.

## Known limits
- Goodreads has no API; page parsing may break when their layout changes (`src/sources/goodreads.js`). Their terms disallow automated gathering; this is strictly personal, one page per book, cached.
- Hardcover (sanctioned) is optional and needs a free token; its review text is not used yet.
- Full run is 4-7 minutes with default tiers because the long list and ranking use Opus at high effort. Lower tiers in Settings for speed.
- Single user, localhost only, no auth.
