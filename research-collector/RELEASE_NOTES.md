## 2026.07.21.1

**Added:** The AI Daily Brief as a seventh gather source. `gather` now fetches
recent editions from theaidailybrief.com, keeps written takeaway "nuggets" with
headings, bodies, and anchors, and drops video embeds so only written analysis
survives. Controlled by a new `aiDailyBriefDays` global arg (1-14, default 3).

**Fixed:** The test module had unescaped quotes in three XML fixture string
literals that stopped Deno from parsing the file, so the AI Daily Brief
coverage test never ran. Switched those fixtures to template literals.

**Changed:** `gather`'s output resource now carries an `aiDailyBrief` object
with `editions` alongside the existing source arrays. Existing sources and
resource shapes are unchanged.
