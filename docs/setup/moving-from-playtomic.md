# Moving a club from Playtomic

For a club on Playtomic that wants openPadel to become its system, step by step, without selling a court twice
and without losing what Playtomic would forget. Set up the connection first
([accounts/playtomic.md](accounts/playtomic.md)): it needs one of Playtomic's top two plans (Champion or Master),
which come with its Third Party API. Without them there's no mirror, so go straight to a one-day switch using
Playtomic's exports, at a quiet hour.

openPadel never writes to Playtomic: its API is read only. Whatever has to change in Playtomic, staff change there
themselves. Never automate Playtomic Manager (a staff login driven by a program): Playtomic is shutting off
unauthorised automations, and openPadel doesn't do it.

There are four stages. Keep the second one short: weeks, not months.

| Stage | What runs | Who sells courts | Ends when |
|---|---|---|---|
| 1. Shadow | openPadel reads Playtomic and sells nothing | Playtomic | The staff have practised and the members are in |
| 2. Side by side | Both | Each its own courts or hours | The club is ready to switch |
| 3. openPadel first | openPadel; Playtomic bookings still land in its schedule | openPadel | Nothing new lands from Playtomic |
| 4. Playtomic off | openPadel alone | openPadel | |

## Stage 1: shadow

**What openPadel does:**

- **Holds every Playtomic booking on a linked court**, so it never puts anything there itself
  ([accounts/playtomic.md](accounts/playtomic.md#what-a-copied-booking-does)).
- **Keeps an archive of every Playtomic booking it reads**, from the first read. Playtomic itself keeps bookings
  only three months back, so the archive reads those three months too, and then everything new as it comes. Each
  booking is kept as Playtomic gave it: court, time, type, where it was made (app, web, Manager), price, payment
  status, coaches, course or activity, and its players by name and email. Players are matched to members here by
  email, or by their Playtomic id once the members are imported.
  - Staff see a person's Playtomic bookings on their page (In Playtomic), read only.
  - A member's Playtomic bookings come with their data download (Profile, Your data).
  - When a member's account is deleted here, their name and email go from the archive too. Playtomic's own id for
    them stays on those rows, without either, so a later read of a booking still in Playtomic doesn't copy their
    name back. Their account in Playtomic is Playtomic's: delete it there too if they asked the club to.
  - Mention the archive in the club's privacy policy ([the template](../templates/member-privacy-policy.md) has the
    line).
- **Compares the two every day** (staff app, Playtomic, "Playtomic and openPadel, day by day"): for each linked
  court and day, from yesterday to a week ahead, its bookings in Playtomic, how many openPadel holds or has taken
  over, and openPadel's own. Anything that differs is listed:
  - a Playtomic booking that clashes with something in openPadel;
  - a Playtomic booking openPadel doesn't hold yet;
  - a booking taken over (stage 3) that was then moved or cancelled in Playtomic.

  The owners hear of each difference once, by email and in the app (that daily check looks two weeks ahead), never
  again for the same one.

**What staff do:**

- Create the API keys in Playtomic and link each court ([accounts/playtomic.md](accounts/playtomic.md)).
- Block openPadel's own event times in Playtomic (one recurring block per series), if it runs any.
- Download Playtomic Manager's customer export and import the members (`openpadel import members`, or People in
  the staff app; [the setup guide](README.md#step-5b-members) lists the columns it reads). The import keeps each
  member's Playtomic id, so running it again with a newer export updates the same people.

## Stage 2: side by side

Both sell courts, so each court (or each hour of a court) belongs to one of them:

- **Split the courts.** Decide which courts or hours openPadel sells. Close those in Playtomic (blocks, or the
  court's own hours there), and leave members booking only those in openPadel. openPadel keeps holding whatever
  Playtomic sells on the rest.
- **For the odd exception** (a desk booking in openPadel on a court Playtomic sells), staff enter a zero-price
  booking for that time in Playtomic under a club-owned "openPadel hold" customer, at once. Until it's there,
  Playtomic can still sell the court, an open match filling up included.

Members use two apps for a while, and Playtomic's own service fee makes the same court look cheaper in openPadel.
That's why this stage should be short.

## Stage 3: openPadel first

openPadel is the club's system. In Playtomic, set the book-ahead limit to 0 days, and every benefit's own booking
window to 0 too, so members can't book there any more. Playtomic's help says this also stops open matches being
made there, for everyone. Anything still booked in Playtomic keeps holding its court in openPadel, and anything new
that lands there (desk habit, an old series) is held too, or listed as a clash.

**Taking over upcoming bookings** (staff app, Playtomic, "Take over upcoming bookings"; owners and managers). Choose
the Playtomic bookings to bring in, see the preview, and confirm. Each one becomes a booking here:

- on its linked court, at its time, with its player as organiser and the others named (members matched by email or
  Playtomic id; guests by name). Nobody is told: it's the booking they already have.
- **Paid in Playtomic:** kept as paid there, so nothing is owed here. That money isn't counted in openPadel's books
  (it's in Playtomic's payouts), and no receipt is made (Playtomic gave one).
- **Not paid in Playtomic:** owed at the desk here.
- **Recurring bookings** with the same player, court, weekday, time and length every week, with no week missing,
  become a weekly court (one a week, paid at the desk, each week its own booking). Any other pattern stays one
  booking a week, and the preview says so.

The preview lists what stays in Playtomic, and why, by name: a class, course, tournament, open or league match, or
lesson (not one player's court); a player who isn't a member here yet (import the members first); a booking partly
paid or refunded in Playtomic (settle it there first); a price in another currency; a court not linked; or a
clash with something here.

From then on openPadel's own booking holds the court, and the mirror doesn't hold it twice. Leave the booking in
Playtomic as it is: if it's cancelled here, openPadel holds the court for it again, since it's still booked there.

**Refunds of what was paid in Playtomic are made in Playtomic, never as money here.** Cancelling a taken-over booking
here, the preview says how much goes back by the club's rule. The managers are told by email and in the app (it
stays on Today until someone marks it handled), and refund it in Playtomic. Making one shorter or cheaper, the
preview says the same: what goes back is given back in Playtomic.

### Wallets and credit

<!-- kumi-ptmovein fills this -->

### Memberships

<!-- kumi-ptmovein fills this -->

**At the switch, in one sitting at a quiet hour:**

1. Set Playtomic's book-ahead limit to 0 (and each benefit's window).
2. **Stop Playtomic's membership renewals.** Playtomic charges card-paid memberships again by itself, and a
   commitment period binds the member unless staff waive it. Remove the members from their benefits there, or turn
   the benefits off.
3. **Zero every Playtomic wallet in the same hour that club credit opens here**, or a member can spend the same
   money twice.
4. Let programs already sold in Playtomic run out there.
5. Take over the upcoming player bookings (above).

Cards don't move: Playtomic's are in Playtomic's own payment account. Members add a card here the first time they
pay.

**Telling the members.** openPadel sends nobody anything at an import. The club's own announcement goes as club news
only to those who said yes to it, and as a service message only to people with an upcoming booking (Playtomic says
clubs should contact players who didn't opt in only about an existing booking). That's the club's call.

## Stage 4: Playtomic off

Leave the connection on until the last Playtomic booking has passed: a recurring tournament there can run a year
ahead. Then download Playtomic's payments history and customer export one last time, keep them with the club's
records, delete the API keys, and cancel the Playtomic plan. Any wallet balance left in Playtomic is still owed to
its member. The archive stays in openPadel, read only, with each member's Playtomic bookings on their page.
