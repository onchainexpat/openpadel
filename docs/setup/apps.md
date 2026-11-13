# The phone apps

The same is true whether the club runs openPadel on its own server, an agent set it up for the club, or Kumi, the
hosted service, runs it.

## What a club has today: apps installed from its own address

The members' app and the staff app are installable web apps. Each installs from the club's own address
(`https://app.yourclub.com` and `https://staff.app.yourclub.com`), with the club's name, icon and colour. The staff
app installs as "<the club> Staff". Neither says "openPadel" or "Kumi" on the home screen.

- **Android:** in Chrome, the members' profile offers "Install the app" (or Chrome's menu, Install app). It installs as
  a real app: its own icon and window, in the app drawer, with push messages.
- **iPhone and iPad:** in Safari, Share, then Add to Home Screen. Push messages work once it's on the Home Screen (iOS
  and iPadOS 16.4 and later), not in a Safari tab.
- **Computers:** Chrome and Edge install it too; any browser opens it.

### The icon and the start screen, from the club's name and colour

Both apps take their look on the phone from two settings the club already has: its **name** and its **brand colour**
(staff app, Settings, or `brand_colour` in the club's setup file). A logo is optional: without one, the server draws a
mark from the name.

- **The icon** is the club's mark on its colour: the first letters of its name, past words every club has ("Padel",
  "Club", "de"...), so "Harbor Lights Padel" is HL. A name with no letters A to Z (accents are fine) gets a white ball.
  The letters are white, or near-black on a light colour, whichever reads.
- **Android** draws its own start screen from the app's manifest: the club's colour with the icon in the middle and
  the name under it. It also colours the status bar.
- **iPhone** shows a start image the server draws for each common iPhone size, in the same colour with the same mark,
  and the club's icon on the Home Screen.
- **Inside the app**, while it loads, the same mark on the same colour, so there's no jump when the phone hands over.
  It goes as soon as the first screen is ready. On a slow connection it shows a quiet loading line, then a note to
  check the connection and Try again; with no connection it says so, and tries again when the phone is back online.
- **A first sign-in** plays a short welcome (about a second; a tap ends it) once per person in each app, and the
  welcome for members who moved in from another system comes in part by part. With "reduce motion" on in the phone's
  settings, both only fade.

Changing the name or colour draws new icons and start screens straight away, and phones pick them up: the app's own
start screen the next time it opens (or the one after, at most a day later), and Android's icon when Chrome next
checks the app (it does on its own, about once a day). An iPhone keeps the icon it was added with until the app is
removed and added to the Home Screen again: that's Apple's rule, not openPadel's.

### The club's logo

A club with a logo can use it in place of the drawn mark: on the app icons (plain and maskable), the iPhone icon and
start images, the start screen inside the apps, the first-sign-in welcome, both apps' headers and the members' Home.

- **Adding it:** the owner (or a manager) opens Settings in the staff app, Club details, Logo, and chooses the file.
  The preview shows it on the club's colour as a start screen will; Confirm sets it, and it's in Changes like any
  other setting, with Undo. Remove the logo brings the drawn mark back. On the server, `logo: logo.svg` under `club:`
  in club.yaml (a path from the file's own folder) does the same through `openpadel setup plan` and `apply`; it's set
  again only when the file or `logo_for` changes.
- **Files:** SVG, PNG or JPEG, under 1 MB. A PNG or JPEG is 32 to 2048 pixels a side; square or wide both work (a
  square one fills the icon best). WebP isn't taken. Empty margins round the logo are trimmed.
- **SVGs** must be shapes only. Text has to be turned into outlines (in Illustrator, Create Outlines; in Inkscape,
  Object to Path), since the server has no fonts. An SVG with scripts, embedded HTML, event handlers, links to other
  files or pages, CSS imports, XML entities or an embedded picture over 2048 pixels is refused with the reason. The
  file itself is never served: the server draws it as a PNG, keeps that, and makes every image anyone gets from it.
  The file waits with the preview until it's confirmed (or, for a change waiting for the owner's yes, until it's
  answered) and is taken out once it's applied or the preview runs out.
- **Light and dark logos:** a logo is made for a dark background (a light logo) or a light one (a dark logo). The
  server reads which from the logo, and the owner can say otherwise (Settings, "The logo is made for", or
  `logo_for: dark` or `light` in club.yaml; left out of club.yaml, the choice made in Settings stays). The logo sits straight on the club's colour when it stands out there (at
  least 3:1, and on the side of light or dark it's made for); otherwise it sits on a near-black tile (a light logo) or
  a white one (a dark logo). A logo with its own background, like most JPEGs, keeps it as its tile. The icons are
  then that tile colour all over.

A new logo, or a new choice of background, draws new icons and start screens at once, and phones pick them up as for
a new name or colour (above).

Members find their way around the members' app by the tabs at the bottom of every page, where members coming from
other padel apps expect them:

- **Home:** the club, what the member has coming up, shortcuts, what's on in the next 14 days, asking the club, and
  the club's courts, opening hours and directions (the address of each location, from Settings).
- **Book:** a court, by day, length and start time, then the court; the preview shows the price before anything is
  booked.
- **Play:** open matches, and the club's events: open play (socials and Americanos), tournaments and leagues, with
  chips for each kind. Both lists have a week of days to pick from and "Only ones with places left". A card shows
  when, the level range, the price, the places taken (an open match also shows its players' initials, as its page
  names them) and who runs it: the host, the coach of its next date, or the club. Each event has its own page with
  the level, price and places, the coach, the length and refund rule, its dates to choose from when it's signed up
  for per date, the players' chat once the member is in, and Join kept at the bottom of the screen.
- **Learn:** clinics (with the same week of days), courses (with the price for the whole course and how many weeks it
  runs) and private lessons with a coach. Clinics and courses never show under Play's events. A clinic or course
  taken as a whole can be joined from its card; every Join opens the usual preview, with the member's own price
  (member price, included session or pack) shown before anything is paid.
- **Me:** level, club credit and receipts, membership, the card on file, family, profile and settings, the member's
  data, and signing out.

Links the club already sent (in emails, texts and the inbox) still open the page they named.

Why this is the way today:

- **Free.** No developer accounts, store fees or reviews.
- **Fast to ship.** It's ready the moment the club's address works, and every update reaches every phone the next
  time the app opens, with no store review in between.
- **One app for everyone.** Android, iPhone and computers run the same app, so members on any phone see the same thing.

## Store apps: what Google Play and the App Store would add, and cost

openPadel doesn't build store apps yet: the installed app is the way today. A club that wants its app in the stores
(found by searching the store, installed the way people expect) can have one later, but it takes more steps, its own
company's details and fees. The steps are the same hosted or self-hosted. **The owner creates and pays for these
accounts, in the club's company's name. An agent tells the owner what to click and never enrols an account for them.**

### What both stores need

- **The club's own developer accounts.** Apple's rules say an app made from a template service is submitted by the
  business whose app it is, not by the service for its clients (App Review Guideline 4.2.6). So the club's app is
  published from the club's own Apple account, in its company's name, and the same goes for Google Play.
- **A legal entity and a D-U-N-S number.** Both stores verify an organisation with its D-U-N-S number from Dun &
  Bradstreet (free, and it can take up to 30 days). Apple wants the legal entity's name (not a trade name), someone who
  can sign for it, and a website on the club's own domain. Google won't create an organisation account without one.
- **A privacy policy and the stores' privacy forms.** Apple's App Privacy details and Google's Data safety form, filled
  in from [processors.md](../processors.md) and the club's own policy ([templates](../templates/README.md)).
- **The listing.** Screenshots for each phone size, an icon, a description in each language, a support address.
- **Review, then review again for each new version.** And the store app updates only when a new version is approved,
  unlike the installed app.

### Apple (iPhone and iPad)

- **99 USD a year** for the Apple Developer Program (fee waivers exist for some nonprofits, schools and governments).
- **An organisation account:** an Apple Account with two-step sign-in, the D-U-N-S number, the legal entity, an email on
  the club's domain and a working public website.
- **Review:** half of submissions in under a day, and 90% in under two days, by Apple's own figures.
- **More than a website in a frame.** Apple asks for an app that's more than a repackaged website (Guideline 4.2), so a
  store version needs real app features, not only a wrapper around the installed one.

### Google (Android)

- **25 USD, once**, to register a Google Play developer account.
- **An organisation account:** the D-U-N-S number, the organisation's phone number and website, and contact details
  confirmed by one-time codes.
- **A personal account instead** (not recommended for a club): one made after 13 November 2023 must run a closed test
  with at least 12 testers, opted in for 14 days in a row, before the app can go to everyone.
- **Review:** usually hours, and up to seven days or longer for some apps, such as those from new accounts.

## Sources

Read on 7 November 2026:

- Apple Developer Program, enrolling an organisation and the fee: https://developer.apple.com/programs/enroll/
- App Review Guidelines 4.2 and 4.2.6: https://developer.apple.com/app-store/review/guidelines/
- App privacy details, required for new apps and updates: https://developer.apple.com/app-store/app-privacy-details/
- App Review times: https://developer.apple.com/distribute/app-review/
- Web push on the iPhone Home Screen from iOS 16.4: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Google Play's registration fee: https://support.google.com/googleplay/android-developer/answer/6112435
- What a Google Play organisation account needs, the D-U-N-S number among it: https://support.google.com/googleplay/android-developer/answer/13628312
- Testing before production for new personal accounts: https://support.google.com/googleplay/android-developer/answer/14151465
- Google Play's Data safety form: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play review times: https://support.google.com/googleplay/android-developer/answer/9859751
