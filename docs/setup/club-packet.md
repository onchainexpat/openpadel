# The club packet: what to collect before setting up

An agent can draft most of this from the club's website, its Google listing or its Playtomic page,
then ask the owner to check it. Nothing on this list is a secret; keys and passwords are never
collected here.

| Item | Used for | Who provides it |
|---|---|---|
| The club's name, as members know it | Both apps, emails, Stripe's statements | Website |
| Time zone | Every date and time Kumi shows or acts on | The club's address |
| Language members mostly use (English or Spanish) | The default for new members; each can change it | Owner |
| Owner's name and email address | The first sign-in; they manage everything else | Owner |
| Each location: name and street address | `club.yaml` | Website |
| Each court: its name, and indoor, covered or outdoor | `club.yaml` | Website, photos or the owner |
| Staff: name, email and role (manager, front desk, coach, accountant) | `club.yaml` | Owner |
| A domain the club owns (or can buy), and who controls its DNS | The app's address and email | Owner |
| Brand colour and logo | The apps | Website, owner approves |
| Clinic, social and Americano prices, and the cancellation rule (how many hours before a refund stops) | Programs, once set up | Owner |
| Opening hours for each location, and the days it's closed | Settings, Opening hours (step 5c) | Website or Google listing, owner checks |
| Court prices: by day, time of day and season, and the sales tax rate if any | Settings, Prices (step 5c) | Owner |
| Booking rules: how far ahead, how many at once, the free cancellation window, the lengths offered, and the deadline for "pay my part" (unpaid shares go on the organiser's card then, and an open match that isn't full is cancelled with everyone paid back) | Settings, Booking rules (step 5c) | Owner |
| What a player who can't make a match after the deadline gets back, in percent: when their own sub takes the place (default 100), when the club fills it with a paying player (100), and when nobody takes it or it's given free (0) | Settings, Booking rules (step 5c) | Owner |
| Membership plans: name, price a month or a year, what members get (member court prices, booking further ahead, a discount on clinics and other programs, sessions included each month or year); for a family plan, how many people it covers and the price of each one more; for a new club, a founding offer (how many, and the opening date) | Memberships (step 5d) | Owner |
| Starting levels for members who already have one (a Playtomic level, say), and which staff answer level reviews | Each member's level page, and the Levels page | Owner, or the old system |
| Each coach who gives private lessons: a photo, a few lines about them, the levels and languages they teach, a rate for each lesson length (court included), and the hours they give lessons each week | Coaches (step 5f); each coach can keep their own | The coach, owner approves |
| The club's waiver text, if players must accept one (a lawyer's wording, not Kumi's) | Settings, Waiver (step 5g) | Owner |
| A few lines about the club, for its public page | Settings (step 5e) | Website, owner approves |
| Is the club on Playtomic, and on which plan? | Whether to connect it (its API needs the Champion or Master plan) | Owner |

**Not collected here, ever:** bank accounts, card numbers, Social Security or tax ID numbers, ID
documents, passwords and API keys. Stripe asks the owner for its business and bank details on its
own pages. Keys go into the server's settings file, typed in by the owner.
