# Moving in from Playtomic: wallets and memberships

The money side of moving a club from Playtomic to openPadel: members' wallet balances become club credit, and their
memberships carry over. The staff app's Playtomic page, Moving in, or `openpadel move-in` on the server. Both are the
owner's; a manager sees the preview first and then asks the owner (the owner sees who uploaded the file and when), and
support access and assistants never do them. If the owner does the same thing meanwhile, the manager's ask is settled,
not left waiting; an ask for something the owner's run didn't cover (other memberships, other people) keeps waiting. Bookings, the archive and the
stages of the move are in the main guide, [moving from Playtomic](moving-from-playtomic.md).

## Where it reads from

The move-in only reads what the server read itself, never rows sent to it:

- **Playtomic itself,** with the club's Third Party API keys: "Read players from Playtomic" reads every player with their
  wallets and memberships. It starts within 10 minutes and goes at Playtomic's pace, about 100 players a minute. On the
  server, `openpadel move-in players` reads them now. A read that can't reach the end (Playtomic stops answering, or a
  club bigger than 2,000 pages) fails and says so, keeping the last full read.
- **The club's customer export** (a CSV from Playtomic Manager), uploaded on the page (or named to `openpadel move-in`).
  The server reads it there and keeps what it read for 30 days; each preview names that upload. The change history
  keeps only its hash and how many rows it had, never the people in it. The columns it reads are listed below.

Each player is matched to a member here by their Playtomic id (the member import keeps it), else their email. Import
the members first (People, Import, or `openpadel import members`): a player who isn't a member here yet is counted and
left out (not named, as they aren't the club's members). Someone whose account was deleted here isn't read again, from
Playtomic or an upload, and the preview says how many were left out; if they join again, they're read from then on.

Each run reads only what's newer than the last run: an upload or a read of Playtomic from before it would bring back
what that run took back, so it's refused. Upload the export again, or read Playtomic again.

## Wallets and credit

Members' Playtomic wallets become club credit here: money the club owes them, spent the way any club credit is.
Nothing changes in Playtomic.

1. **Wallets into club credit, Preview.** For each member, their wallets are added up in the club's currency, and that
   is what they should hold from Playtomic. The preview shows each member, the total, and which export columns it read
   as wallets: untick any that isn't one before previewing. A wallet in another currency, or an amount that can't be
   read, is listed and left. Confirm it.
2. **Run it again nearer the switch.** Each member has one total from Playtomic, so only the difference moves, whatever
   the wallets are called: a renamed column, Playtomic in another language, two staff with two exports or Playtomic's
   own read all count the same money once. The total also follows them as Playtomic knows them (their Playtomic id and
   address, kept only as one-way hashes), so someone who deleted their account and joined again doesn't get the same
   wallet twice.
   - **More than before** (topped up there) comes in.
   - **Less than before** (spent there) is listed and left as it is here, unless you tick "Take back what was spent in
     Playtomic". Then it comes back out of their credit, up to what they still hold of what came from Playtomic: what
     they spent here meanwhile stays spent, and credit from anything else (a refund given as credit, a gift card) is
     never touched. The preview says so.
3. **At the switch, in the same hour:**
   1. The owner says "We're setting the wallets to zero in Playtomic now" on the page (a manager asks). From then a run
      only brings credit in, and taking back is refused: every wallet is about to read 0.
   2. Set the wallets to zero in Playtomic (its wallet import overwrites balances, or by hand), so nobody spends the
      same money in both. A last run can still bring in anyone's last top-up.
   3. The owner says "The Playtomic wallets are at zero" (a manager asks). Until then it stays on Today for the owner and
      managers, with a link to the page. After it, no more credit comes over.

- **The same player on two rows** of the export (one membership a row) counts once. Rows that disagree on the wallets
  are listed for staff to check, and nothing moves for that person.
- **A ceiling:** at most $10,000 (sized for the club's currency) comes over for one person. More is listed and left, to
  check the file or give it as credit by hand. For a currency openPadel can't size a dollar limit in, the owner gives
  the ceiling (on the page, or `--cap=<whole units>` on the server); for one it can, a figure given only lowers it.
- **In the books:** club credit, money owed to members, from a "brought in" account (money the club took in Playtomic),
  never revenue. Reports' club credit includes it.
- **Paying it out at the desk** warns that it came from Playtomic wallets, which members may have topped up by card.
- **On the server:** `openpadel move-in wallets [export.csv] [--take-back] [--cap=<whole units>] [--apply]`, a preview
  unless `--apply`.

## Memberships

A Playtomic membership (its benefit or category) becomes a membership here, on the plan staff choose for it, paid
through Playtomic's date, with nothing charged now.

1. **Moving in, Memberships:** each of Playtomic's memberships, with how many have one. Choose the plan here for each, or
   Leave out, then Preview.
2. **What carries over:** for each member, the membership that runs longest, until the last day Playtomic's period
   covers (a date with no time is that whole day on the club's clock). The preview says, and leaves out:
   - someone already a member here;
   - a membership with no end date in Playtomic (give it from the person's page);
   - one that has ended;
   - one whose plan here has all the members it takes.
3. **Then:**
   - **On a plan members join in the app,** it renews here from that day, on a card the member adds in the app. They're
     told a week before. With no card, it ends that day: nothing is charged, and staff hear of no failed renewal. It
     renews on Playtomic's day of the month, back to the 31st after a shorter month. Until a card is added, it doesn't
     hold back the member deleting their account.
   - **On a desk plan,** the next period is paid at the desk, as with any membership the desk gives.
4. **In Playtomic, stop these memberships renewing** before their dates (remove the members or turn the benefits off),
   or Playtomic charges the card it holds again.
5. **A commitment period** in Playtomic is kept in the membership's note, and not held to here.

- **On the server:** `openpadel move-in memberships [export.csv] --map "<Playtomic name>=<plan name or id>" [--apply]`,
  with one `--map` for each, and `skip` to leave one out.

## The export's columns

They are found by name in English or Spanish (Playtomic doesn't publish them):

| What | Column names read |
|---|---|
| Who | Name (or First name and Last name), Email, Playtomic ID, as for the member import |
| Wallets | Any column whose name says wallet, balance or credit ("Wallet", "Saldo monedero Club"), each one wallet, and a blank cell an empty one. Not a column that adds the others up ("total") or counts what's pending, used, spent or owed. The preview lists the columns read, and any can be left out |
| Membership | Benefit name, Category, Benefit, Membership, Plan (Playtomic's English export); Beneficio, Nombre del beneficio, Categoría, Membresía, Abono, Tarifa (its Spanish one) |
| Its last day | Expiry date, Benefit expiry date, Expiry, Expires, Valid until, Valid to, Until, End date, Paid through; Caducidad, Fecha de caducidad, Fecha de vencimiento, Vence, Vencimiento, Válido hasta, Hasta, Fecha fin |
| Commitment | Commitment, Permanencia, Compromiso |

A day reads as 2026-12-01, or as 01/12/2026 with the day first, unless the club writes dates the US way (month first).

## Privacy

What the read or the upload holds about a member (name, email, phone, wallets, memberships) is kept on the club's
server for the move-in. It's in the member's own data download, and it's deleted with their account, upload and all.
Once deleted, they aren't read from Playtomic again.
