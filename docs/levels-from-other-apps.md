# Levels from other apps

How a level a player brings from another app becomes their starting level here
(`packages/core/src/level_import.ts`). The conversions are **interim**, version `interim-2026-11-07` in
the code (`IMPORT_TABLE`): they come from published descriptions and an unofficial table, not from
measuring members. Once a club has players who came in from another app and have played about 6 rated
games here, compare where each started with where their games have taken them, fit the conversion,
and bump the version.

## The conversions to the club's 0 to 7

| App | Its scale | Starting level here | Basis |
|---|---|---|---|
| Playtomic | 0 to 7 | The same number | The club's scale and its tested starting confidence are Playtomic's |
| Playbypoint (NPRP) | 1 to 7 | The same number | The same range (whether NPRP runs lower is unconfirmed) |
| World Padel Rating (WPR) | 0 to 21 | Straight lines through 0 → 1.50, 2 → 2.25, 5 → 3.25, 8.5 → 4.25, 12.5 → 5.25, 15 → 6.00, 21 → 7.00 | Midpoints of an unofficial NPRP to WPR table (padelbrowser.com, 1 June 2026) |
| MATCHi | 1 to 10, whole numbers | 1 → 1.00, 2 → 2.00, 3 → 2.50, 4 → 3.00, 5 → 3.50, 6 → 4.25, 7 → 4.75, 8 → 5.50, 9 → 6.00, 10 → 6.50 | MATCHi's level descriptions matched to the LTA's statements |
| LTA rating | 1 to 7 | The same number | A self-assessment on a matching range |
| PadelLevels, Padelmates, another app | not published | Staff give the start | No conversion yet |

## How sure each start is

The uncertainty a start begins with, in level units (a stranger starts at 1.17, a level staff set at
0.60, and a level counts as provisional above 0.55). No start is ever surer than 0.60.

| Evidence | Uncertainty |
|---|---|
| Playtomic from the club's own records (the member import), or seen in the app with reliability 50% or more | 0.60 |
| WPR with confidence HC, PadelLevels at 70% or more, Playbypoint with 20 or more matches | 0.70 |
| Playtomic below 50% reliability (or none shown), WPR LC, Playbypoint under 20 matches, PadelLevels below 70%, Padelmates or another app | 0.85 |
| The player's own word below the club's line, MATCHi, the LTA rating | 1.00 |
| WPR with confidence NC (self-assigned) | Not used |

Only 0.60 for Playtomic levels has been tested against real results. A player's claim above the club's
line waits for staff; once staff check it, it counts as seen in the app.

A parent brings their junior's the same way, on the members' app's Family page (Level, beside the
junior): it counts as the player's own word, under the same line and the same 5 rated games, and the
junior's history says which parent gave it. Either parent can take it away while the junior is new,
and the club's answer to one that waits goes to the parents.

## Not built yet

- **Links the player approves on the other app**, for WPR and PadelLevels, once they give API access
  (the `partner_link` evidence in the code). Nothing calls another app today.
- **Screenshots.** The members' app doesn't take files; staff ask to see the app instead.
- **Other apps' match history.** Never brought in as games here: those games name people who aren't
  members, and their results come from another rating model.
