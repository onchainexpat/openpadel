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
| Is the club on Playtomic, and on which plan? | Whether to connect it (its API needs the Champion or Master plan) | Owner |

**Not collected here, ever:** bank accounts, card numbers, Social Security or tax ID numbers, ID
documents, passwords and API keys. Stripe asks the owner for its business and bank details on its
own pages. Keys go into the server's settings file, typed in by the owner.
