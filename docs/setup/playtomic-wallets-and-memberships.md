# Moving in from Playtomic: wallets and memberships

The money side of moving a club from Playtomic to openPadel: members' wallet balances become club credit, and their
memberships carry over. The staff app's Playtomic page, Moving in (the owner and managers), or `openpadel move-in` on
the server. Bookings, the archive and the stages of the move are in the main guide, [moving from
Playtomic](moving-from-playtomic.md).

## Wallets and credit

Members' Playtomic wallet balances become club credit here: money the club owes them, spent the way any club credit
is (credit.ts). Nothing changes in Playtomic.

1. **Import the members first** (People, Import, or `openpadel import members`). Each Playtomic player is matched to a
   member here by their Playtomic id (the import keeps it), else their email. A player who isn't a member here yet is
   listed and left out.
2. **Choose where it reads from,** on the Playtomic page, Moving in:
   - **Playtomic itself,** with the club's Third Party API keys: "Read players from Playtomic" reads every player with
     their wallets and memberships. It starts within 10 minutes and goes at Playtomic's pace, about 100 players a minute.
     On the server, `openpadel move-in players` reads them now.
   - **The club's customer export** (a CSV from Playtomic Manager). The columns it reads are listed below.
3. **Wallets into club credit, Preview.** It shows each member, their balance in the club's currency and the total. A
   wallet in another currency, or with an amount that can't be read, is listed and left. Confirm it.
4. **Run it again nearer the switch.** Only what changed moves: a wallet topped up in Playtomic adds the difference, one
   spent there takes it back out, and the same money never comes in twice. Credit a member has since spent here isn't
   taken back; the preview names them.
5. **At the switch, in the same hour:** set the wallets to zero in Playtomic (its wallet import overwrites balances, or
   by hand), so nobody spends the same money in both. Then the owner taps "The Playtomic wallets are at zero" (a manager
   asks the owner). Until then it stays on Today for the owner and managers. After it, no more credit comes over.

- **In the books:** club credit, money owed to members, from a "brought in" account (money the club took in Playtomic),
  never revenue. Reports' club credit includes it.
- **Paying it out at the desk** warns that it came from Playtomic wallets, which members may have topped up by card.
- **On the server:** `openpadel move-in wallets [export.csv] [--apply]`, a preview unless `--apply`.

## Memberships

A Playtomic membership (its benefit or category) becomes a membership here, on the plan staff choose for it, paid
through Playtomic's date, with nothing charged now.

1. **Moving in, Memberships:** each of Playtomic's memberships, with how many have one. Choose the plan here for each, or
   Leave out, then Preview.
2. **What carries over:** for each member, the membership that runs longest, until the last day Playtomic's period
   covers. Someone already a member here, a membership with no end date in Playtomic (give it from the person's page)
   and one that has ended are said and left.
3. **Then:**
   - **On a plan members join in the app,** it renews here from that day, on a card the member adds in the app. They're
     told a week before. With no card, it ends that day: nothing is charged, and staff hear of no failed renewal.
   - **On a desk plan,** the next period is paid at the desk, as with any membership the desk gives.
4. **In Playtomic, stop these memberships renewing** before their dates (remove the members or turn the benefits off),
   or Playtomic charges the card it holds again.
5. **A commitment period** in Playtomic is kept in the membership's note, and not held to here.

- **On the server:** `openpadel move-in memberships [export.csv] --map "<Playtomic name>=<plan name or id>" [--apply]`,
  with one `--map` for each, and `skip` to leave one out.
- Through an assistant, neither wallets nor memberships are offered: money owed and memberships in bulk come from the
  club's own file or Playtomic, in the app or on the server.

**The export's columns,** found by name in English or Spanish (Playtomic doesn't publish them):

| What | Column names read |
|---|---|
| Who | Name (or First name and Last name), Email, Playtomic ID, as for the member import |
| Wallets | Any column whose name says wallet, balance or credit ("Wallet", "Saldo monedero Club"), each one wallet; a column with "total" in its name is left out, since it adds the others up |
| Membership | Category, Benefit, Membership, Plan, Categoría, Beneficio, Membresía, Abono, Tarifa |
| Its last day | Expiry, Expires, Expiry date, Valid until, Until, End date, Paid through, Caducidad, Fecha de caducidad, Vence, Vencimiento, Válido hasta, Hasta, Fecha fin |
| Commitment | Commitment, Permanencia, Compromiso |

A day reads as 2026-12-01, or 01/12/2026 day first, unless the club writes dates the US way (month first).
