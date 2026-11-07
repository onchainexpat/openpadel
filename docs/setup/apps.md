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
