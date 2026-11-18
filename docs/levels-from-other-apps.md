# Levels from other apps

How a level a player brings from another app becomes their starting level here
(`packages/core/src/level_import.ts` for the scales, `packages/core/src/level_claims.ts` for the player's
claims). The conversions are **interim**, version `interim-2026-11-18` in the code (`IMPORT_TABLE`): they
come from published descriptions and an unofficial table, not from measuring members. Once a club has
players who came in from another app and have played about 6 rated games here, compare where each
started with where their games have taken them, fit the conversion, and bump the version.

Nobody signs in to another app through openPadel, and nothing reads another app for a player: the
player types what their app shows (and can add a screenshot), or staff record what they saw.

## The conversions to the club's 0 to 7

| App | Its scale | Starting level here | Basis |
|---|---|---|---|
| Playtomic | 0 to 7, with a reliability % | The same number | The club's scale and its tested starting confidence are Playtomic's |
| Playbypoint (NPRP) | 1.0 to 7.0, active after 20 matches | The same number | The same range (whether NPRP runs lower is unconfirmed) |
| World Padel Rating (WPR) | 0 to 21 (Competition, and WPR-s for social play), confidence NC, LC or HC | Straight lines through 0 → 1.50, 2 → 2.25, 5 → 3.25, 8.5 → 4.25, 12.5 → 5.25, 15 → 6.00, 21 → 7.00 | Midpoints of an unofficial NPRP to WPR table (padelbrowser.com, 1 June 2026); it agrees with WPR's own band descriptions |
| MATCHi | 1 to 10, whole numbers, the player's own choice | 1 → 1.00, 2 → 2.00, 3 → 2.50, 4 → 3.00, 5 → 3.50, 6 → 4.25, 7 → 4.75, 8 → 5.50, 9 → 6.00, 10 → 6.50 | MATCHi's level descriptions matched to the LTA's statements |
| LTA rating | 1 to 7, a self-assessment | The same number | A matching range |
| CourtReserve | no rating of its own: each club's "Custom Ratings", on that club's scale | Staff give the start | A WPR shown in CourtReserve is brought as WPR |
| Padelmates | not published | Staff give the start | An unofficial page says it's an Elo-style 0 to 7; **not checked against the app** |
| PadelLevels, another app | not published | Staff give the start | No conversion yet |

The player's screen and the preview say, for CourtReserve, Padelmates, PadelLevels and another app, that
staff give the start because the scale isn't published.

### Sources (each read 18 November 2026)

- Playtomic: [How the Playtomic level system works](https://playerhelp.playtomic.com/hc/en-gb/articles/43310980754193-How-the-Playtomic-level-system-works)
  (0 to 7; reliability is a percentage the player can't change; a levelling session sets it to 50%).
  Its club API (third-party.playtomic.io, players with `include=SPORTS`) gives a venue's players' levels
  without reliability, with the club's own token: that's the move-in's club data, not a player's link.
- Playbypoint / NPRP: [nprp.io](https://nprp.io) ("a 1.0 to 7.0 scale", proprietary, 20 matches to calibrate). USPA's
  official rating is WPR ([padelusa.org](https://padelusa.org/uspa-and-wpr-unite-to-improve-padel-player-experience/)).
- WPR: [FAQ](https://worldpadelrating.com/faq/) (LC from 5% confidence, high above 35%) and the
  [WPR guide](https://s3.us-east-1.amazonaws.com/redpadel.com/WPR+Guide.pdf) ("0 – 21", a TEMP rating from a questionnaire).
- MATCHi: [matchi.se/levels](https://matchi.se/levels) (1 Newcomer to 10 Professional). MATCHi has chosen PadelLevels
  for a computed rating; when its app shows that, bring it as PadelLevels.
- CourtReserve: [Custom Ratings](https://help.courtreserve.com/en/articles/4147287-custom-ratings) and its
  [WPR integration](https://intercom.help/courtreserve/en/articles/15465172-courtreserve-world-padel-rating-wpr-integration)
  ("00.00 to 21.00", HC/LC/NC, shown under the profile's Ratings).
- Padelmates: nothing official; [an unofficial page](https://www.playskan.com/blog/padel-levels-explained-uk).
- No rating body publishes a conversion between these scales
  ([bounce.game](https://www.bounce.game/padel-rating-converter) says so too).

## How sure each start is

The uncertainty a start begins with, in level units (a stranger starts at 1.17, a level staff set at
0.60, and a level counts as provisional above 0.55). No start is ever surer than 0.60.

| Evidence | Uncertainty |
|---|---|
| Playtomic from the club's own records (the member import), or seen in the app with reliability 50% or more | 0.60 |
| WPR with confidence HC, PadelLevels at 70% or more, Playbypoint with 20 or more matches | 0.70 |
| Playtomic below 50% reliability (or none shown), WPR LC, Playbypoint under 20 matches, PadelLevels below 70%, Padelmates, CourtReserve or another app | 0.85 |
| The player's own word below the club's line, MATCHi, the LTA rating | 1.00 |
| WPR with confidence NC (self-assigned) | Not used |

Only 0.60 for Playtomic levels has been tested against real results.

## A player brings theirs

On **My level** ("Bring your level from another app"; a parent does it for a junior on Family, and a member who
moved in without a level is pointed there from their welcome), while they've played fewer than 5 rated games here:

1. Pick the app. A plain drawing of a phone's profile page marks where the level and how sure the app is of it
   sit, and the words under it say where to look in that app (both languages).
2. Type the number, and what the app says about how sure it is (Playtomic's reliability, WPR's NC/LC/HC,
   Playbypoint's matches, PadelLevels' percent).
3. Optionally, a link to their public profile there, and a screenshot. The screenshot is sealed on the
   server, seen only by the player (and a parent who manages them) and staff who read levels, and
   deleted once staff answer the claim, when it's taken away, or after 60 days.

Each claim previews first. At or below the club's line (Settings, 4.50 to start) it counts at once as the
player's word; above it, or from an app whose scale isn't converted, it waits for staff on the Levels page.

**Several apps at once.** One claim per app; every one is listed on My level. The start comes from the
surest: the lowest uncertainty above, then the one its own app is surest of (Playtomic at 80% beats MATCHi,
both being the player's word), then the newest. A start staff recorded or the club's file brought counts in
the same comparison. When the start's claim is taken away or turned down, the next surest takes over, and
everyone's games are worked out again as if it never came.

The player (or the parent) takes a claim away while still new; one that waits for staff, any time.

## Staff and coaches answer

The **Levels** page lists claims waiting for staff ("Imported level to check") and, while the player is new,
those counting as their word ("Player's word, can be confirmed"), with the profile link and the screenshot.
The same claims are on the person's level page. Front desk, coaches and managers can:

- **Confirm as seen**: it counts as seen in the app, so its start is surer (the second table), and it
  becomes the start if it's now the surest. For an app that isn't converted, staff type the start.
- **Start at this level**: another start on the club's 0 to 7, with a reason.
- **Turn it down**, with a reason.

The player (and the parent who sent it) hears in the app, with the reason. Confirming or changing is refused
once the player has 5 rated games here; turning one down then leaves the level as their games have it.

## Through an assistant or the command line

A player's assistant can bring their level (`level_claim_preview`, or `openpadel level claim`), and take one
of theirs away (`level_remove_claim_preview`), with the same preview words ("Your level from Playtomic (4.2,
reliability 60%) starts you at 4.20 here, provisional ..."), which the person confirms. A screenshot only comes
from the app. The `my_level` read lists their claims and each app's scale.

Staff agents read the queue (`level_queue`) and a person's level (`person_level`), and answer a claim with
`level_answer_claim_preview` like any other level change. Taking away a start staff recorded
(`level.remove_import`) stays in the app.

## Links the player approves (not built)

The `partner_link` evidence is for a level read from the other app with the player's yes. As of 18 November 2026
no platform documents one a club's software could use:

| App | What exists | What a link would need |
|---|---|---|
| WPR | "WPR API's" on request, a partner console (console.worldpadelrating.com, no public docs); CourtReserve has a "Link WPR Account" sign-in | WPR's partner agreement and docs for its player authorization flow (OAuth or a share code) and a rating endpoint |
| Playtomic | A club API with the club's own token (levels of the venue's players, no reliability); Playtomic Connect for partners | A player-approved scope for reading one player's level and reliability |
| Playbypoint / NPRP | Nothing published | A partner API with player consent |
| MATCHi, Padelmates, PadelLevels | Nothing published | The same |
| CourtReserve | A club API (some plans) with no ratings endpoint | Not useful: its ratings are other apps' or each club's own |

## Other apps' match history

Never brought in as games here: those games name people who aren't members, and their results come from
another rating model.
