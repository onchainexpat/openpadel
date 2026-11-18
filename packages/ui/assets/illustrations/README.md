# Illustrations

Original line drawings made for openPadel, from openPadel's own prompts. They show no real club, place or person,
and contain no third-party artwork. They are part of openPadel and under the same licence as the rest of this
repository (MIT, see `LICENSE` at the top).

Each file is an alpha mask: the drawing is the transparency, the colour is ignored. The apps paint them through
CSS `mask-image` in the club's colour (or the text colour), so one file suits every club, both themes and dark mode
(`packages/ui/src/Illustration.tsx`, `styles.css`).

| File | Where it shows |
| --- | --- |
| `welcome.webp` | The welcome at a first sign-in, and the welcome for members who moved in |
| `offline.webp` | The start screen when the club can't be reached or is slow (written into each `index.html`, so it shows with no network) |
| `no-matches.webp` | Play, when there are no open matches |
| `no-bookings.webp` | My bookings and Home's "coming up", when there's nothing; the staff app's empty Bookings list |
| `no-classes.webp` | Learn, when no clinics or courses are open |
| `coach.webp` | Learn, Private lessons |
| `youre-in.webp` | After booking a court or a lesson, or joining a booking |
| `court.webp` | Home's header, behind the club's name; the staff app's empty Schedule |

Squares are 480 px on their long side (`offline.webp` 360 px), `court.webp` 960 px wide, lossless WebP with the
alpha in eight steps, which keeps the lines smooth at a fraction of the size.
