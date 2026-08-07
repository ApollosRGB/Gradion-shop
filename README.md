# 🎁 Gradion Shop — SYNAOS &amp; MPDV Order App

A Shopee-style desktop ordering app that dispatches orders to either of two systems, chosen from a start menu:

- **SYNAOS** — creates AGV transport jobs through the SYNAOS Job Management API and tracks them live.
- **MPDV** — creates production orders (order + one operation per arm) in the MPDV MES.

Built with Electron for Windows and macOS, with light/dark mode and separate **user** and **admin** interfaces.

![status](https://img.shields.io/badge/version-1.12.2-e0563f)

## Features

### 🛍️ User interface
- Browse the products/jobs an admin has published, in a mobile-store style catalog.
- Add any item multiple times; a live order panel on the right shows quantities, per-item prices, and the running total.
- **Finish** dispatches the order to whichever system is selected. In SYNAOS mode each **cart line** travels as one job chain — the whole line rides together rather than one trip per item — and the screen switches to live order progress. Ordering an item adds its quantity to the product's **sold** count.
- **Rate your order** — once an order is delivered, the customer rates each item 1–5 stars; the product's displayed rating becomes the **running average** of all ratings received.
- The progress screen polls the Job API and shows the journey as a **tracking bar**: every step is a stop on the rail with its own icon, short label, station and the time it happened, and a **parcel travels between them** — sitting on the last finished stop, or halfway along while a step is under way. The track fills in behind it, the current stop pulses, and the parcel lands with a bounce on arrival. A long route **compresses to fit** the card rather than scrolling — the icons, labels and dates scale with the number of stops, and past eight stops the station line is dropped to keep the labels readable. Underneath, a **single status line** says what is happening right now ("Delivering to ShopT (shop)") with the next step below it, changing as the order advances rather than growing into a list. Animations respect *prefers-reduced-motion*.
- **My Orders** keeps a history; reopen any order to see its live status. Confirm receipt ("👍 Got it!") or cancel (discards the SYNAOS jobs).

### ⚙️ Admin interface (password-protected)
- **Jobs / Products** — define each product as a sequence of job milestones (station + action + **the robot that performs it**, e.g. *Production · PICK → Shop · DROP*), set its price, attach an image file, and choose whether users can see it.
- **Multi-robot relays** — a SYNAOS job is executed by exactly one transport resource, so when consecutive steps use different robots the app splits the route into **one job per robot** and chains them with a milestone dependency (`requiredPredecessorStatus: FINISHED`), meaning a leg cannot start approaching until the previous leg has finished. The editor previews the split and warns if a robot change isn't a **DROP → PICK at the same station**, which is what a physical hand-over requires.
- **Recalls** — routes the admin runs on demand, typically fetching a rack back from the shop to production. They never appear in the shop, so a customer order can simply deliver instead of also hauling everything straight back. A recall is defined like a product route (station + action + robot per step, hand-overs included), previews how it will be split into jobs, and is dispatched with one button; recent sends are logged with the robot used and any error.
- **Recalls after a delivery** — a recall can run itself once an order has been **delivered**: tick *Run this recall after an order is delivered* and give it a wait in minutes. The countdown hangs off the order's delivery, so the rack is fetched back a set time after it went out; switching the option on starts nothing on its own, and a run finishing does not schedule another one — only the next delivered order does. A further delivery while waiting **pushes the run back** rather than adding a second one, so the AGV goes in once deliveries have settled. Deliveries are noticed even when nobody is on the progress screen (that screen only polls while it is open), so the countdown is not lost if the customer walks away.
- **Each recall answers to its own trigger** — with several recalls on auto, *any delivered order* would wake all of them at once, so a recall can be told what to follow: **any delivered order**, **deliveries of chosen products** (the rack that item travels on is the one worth fetching), or **deliveries by chosen robots** (the AGV that has just delivered is the one that should bring it back). Only a matching delivery arms it; the others are ignored without disturbing its countdown. The robot a job actually ran on is read back from SYNAOS and recorded on the order, so a robot trigger works even when the scheduler picked the AGV rather than the app pinning it. Changing the trigger clears any countdown armed under the old rule, and a trigger with nothing ticked never fires — it says so instead of guessing. Whatever the triggers, **only one recall is ever on the floor at a time**: a second due recall waits for the first to finish rather than sending two AGVs after each other.
- **Several machines, one fleet** — each install has its own orders and its own recall timers and cannot see the others' — but **SYNAOS can see every job**, whoever created it, so the fleet itself is the shared state rather than a file anyone has to keep in step. Every job the app creates is correlated with the order or the **recall id** it belongs to, and unfinished jobs are always returned, so one query every 15 seconds answers *is anyone's order out right now*, *is a recall already on the floor* and *when did the last delivery land* — for the whole shop, not just this machine. A delivery taken on **another** device arms this one's recall (for recalls triggered by *any* order — product and robot triggers need the order record, which lives where the order was taken); another device's order or recall **holds** it; and if a run for this recall started **after** the delivery that armed it, the rack is already being fetched and this machine stands down instead of sending a second AGV. A fresh check is made in the instant before dispatch, since the cached picture can be up to 15 seconds old, and a failed lookup is never read as "the floor is clear".
  On top of that, one machine is nominated in **Settings → This machine** to actually *send* the automatic recalls; the rest watch and show the state honestly (*another machine has a recall out*). That flag is deliberately **not** part of the published setup — loading one setup onto five machines must not create five timers fetching the same rack — so a machine configured from GitHub starts as a watcher and says so.
- **A recall is never sent on top of itself** — dispatching to an AGV that is still executing the previous job puts the vehicle into an error state, so nothing goes out while this recall's own last run is out there. A run counts as finished only when *every* job it created reports `FINISHED`, the trailing park move included; anything uncertain (an API hiccup, a hand-over leg the relay supervisor has not created yet) counts as *still running*, and a 30-second settling gap follows the AGV parking. Sending a recall **by hand** arms the same watcher. By default a recall also holds while a customer order is still in progress. Three failed runs in a row, or a run that never reports finished within an hour, **switch the automation off** and say so in the log rather than sending another AGV after it. The panel shows the live state — *runs in 4:37 — order #a3f9c1 was delivered 05-08 15:04*, *running now*, *holding until the customer order is finished* — and it all keeps running wherever the operator is in the app, for as long as the app is open.
- **"Not ready yet?" — the shop can put a recall off** — an automatic recall would otherwise arrive whether or not the shop is done with the rack, so **30 seconds before it goes** a card appears with the recall's name, a second-by-second countdown, and **four delay buttons the admin sets** (2 / 5 / 10 / 15 minutes by default), plus *I'm done — go now* to send it immediately. Picking a delay pushes the run back by that many minutes and clears the warning, so the shop is asked again before the new time — they can keep putting it off, and every delay is recorded in the log and shown in the admin panel (*shop has put it off 15 min*). A run is **never dispatched without its warning**: if the app was closed through the countdown, or a guard held the run until the warning went stale (over two minutes old), the shop gets a fresh 30 seconds rather than an AGV appearing unannounced. The warning can be switched off per recall.
- **A thought bubble when a recall goes out** — whenever a recall is dispatched, by hand or by itself, a comic thought-bubble pops up in the corner of the shop with the recall's name (*"Bring the rack back — is on its way 🚚"*), so an AGV turning up to collect something is never a mystery. It drifts for a few seconds, fades on its own, and can be clicked away; it is drawn as one SVG whose lobes are outlined and then filled over, so the cloud has a single clean outline in both light and dark mode, and it holds still under *prefers-reduced-motion*.
- **Stations** — map a friendly name + **function** (production, storage, shop, charging…) to a SYNAOS station address ID used in job milestones. Each station can be given an **icon from an image file**, which is what the customer sees on that stop in the order tracking; without one it falls back to an emoji. **Add from SYNAOS** reads the real station addresses the tenant uses (derived from the job-manager, the only data reachable with Basic auth — the layout/fleet services sit behind an OAuth2 gateway), so you don't hand-type IDs.
- **Robots** — **nothing is added automatically.** A tenant carries plenty of AGVs that have nothing to do with this shop, so reading from SYNAOS only *offers* what it found and saves only what you tick. SYNAOS does not let this app list the fleet (that page sits behind its own web login), and reading job history only reveals robots that have already run a job. So **paste the vehicle list** copied from SYNAOS's Fleet Management page: every id in the text is verified against SYNAOS before being offered, and surrounding words are harmless because anything that isn't a real resource simply fails the check. **Ids & patterns** covers ranges and wildcards (`36020-36040`, `#` a digit, `?` a digit or letter, `[1-9]` a set, 600 ids per scan) for predictable naming, but an id with an unguessable part such as `sc-aware-JQ3H0018` can only be found by pasting it. Each robot is also marked **real** or **simulated** — guessed from the name, since SYNAOS exposes no such flag over this API, and overridable per robot.
- **Nodes** — an address book of navigation-graph points (waiting spots, parking, staging) kept separate from handling stations, each with a friendly name. A robot's waiting spot is chosen from this list rather than typed by hand, and reading from SYNAOS files node addresses here instead of mixing them in with stations.
- **Robot ↔ station access** — each station has an *allowed robots* list. The app also mines job history for `UNABLE_TO_ACCESS_ADDRESS` and marks those robots ✖ for that station. A product's robot dropdown only offers robots that can reach **every** station on its route; the rest are disabled with the reason. Products default to **“Auto — only robots that can reach these stations”**, which pins a capable robot (spread across them) instead of leaving it to the SYNAOS scheduler, which has been observed picking unreachable robots. A pinned-but-incapable robot is never sent — the job degrades to scheduler assignment with a warning.
- **Waiting spots** — each robot can be given a home node on its navigation graph (e.g. `00` on `TUSK/NODES`). Once a robot finishes its part of an order, the app appends a `MOVE` to that node at the end of *its* job, so it parks itself. The trailing move is tagged with a correlation and excluded from the customer's progress, and the next robot in a relay waits on the previous robot's last **delivery** milestone — not on it finishing parking. Robots left to the SYNAOS scheduler get no waiting spot, since the app can't know which robot will run the leg.
- **Hand-overs are placed by hand** — a hand-over is a step you add to a route with **+ Add hand-over (robotic arm)**, with its own `method`; the quantity the arm moves is the quantity the customer ordered. The arm is only ever asked to move something where you put one; a robot change on its own just splits the route into two jobs. The editor previews exactly which jobs will be created and where the arm runs, and warns if a hand-over doesn't sit between a **DROP** and a **PICK at the same station**.
- **Robotic arm (MQTT)** — the arm is driven over MQTT. Configure the broker URL (`mqtt://`, `mqtts://`, `ws://`, `wss://`), TLS certificate validation, credentials, the command/status topics, and a **payload template** with `{taskId}` `{method}` `{quantity}` `{from}` `{to}` `{orderId}` `{unitId}` placeholders so the JSON matches the arm exactly. At a hand-over the app publishes the command, waits for the configured “finished” value on the status topic — matched back by the echoed task id, so an interim `Started` or another task's status can't release it — and only then creates the receiving AGV's job. A configurable timeout stops a silent arm from wedging an order. **Test connection** and **Send test transfer** verify the setup without placing an order, and a live log shows recent MQTT traffic and hand-overs in progress. The supervisor runs in the main process, so it keeps going even if the customer leaves the progress screen, and resumes hand-overs left in flight after a restart.
- **Setup sync (GitHub)** — installing on another machine used to mean typing the whole configuration again, so the shop's setup lives in **one JSON file in a GitHub repository**, published under a **name you choose — `setup1`, `line-2`, `showroom`**. That name is the whole interface: the file it maps to (`setups/setup1.json`) is worked out for you, and the other machine picks the setup **from a list of what has been published** rather than typing anything at all. **Publish this setup** writes products, stations, robots, nodes, robot↔station access, recalls (with their automation settings) and the SYNAOS / arm / MPDV connection details; loading is offered on the first-run screen as well as in admin, so a fresh install never needs the admin password just to be configured.
  Setups are **data, not code**, so they live on their own **`setups` branch** rather than landing in the middle of the release history. The branch is created by the first publish as an **orphan** — no parent commit, so it carries the setup files and none of the code — and later publishes just update the file on it. Reading **falls back to the code branch**, so a setup published before the branch existed is still found and says where it came from.
  **Loading needs no token whatsoever** on a public repository — the machines you hand out never see one. A token is only for *publishing*, entered once on the machine that does it, and tucked away in a collapsed *Repository & token* section with a button that opens GitHub's new-token page with the right box already ticked. (GitHub only issues tokens to a person, so the app cannot mint one itself.) What stays behind is what belongs to the machine: its orders, logs, MPDV counter, in-flight hand-overs, each recall's live countdown, and its theme.
  **Passwords are never published in the clear.** The repository is public, so with no passphrase they are simply left out of the file (the other machine is asked for them once); set a **passphrase** and they are encrypted with AES-256-GCM under a scrypt-derived key, with a fresh salt and IV per publish, readable only by a machine given the same passphrase. The GitHub token — which needs *Contents: write* only for publishing, never for loading a public repo — and the passphrase are stored on the machine and are excluded from the payload.
- **Settings** — SYNAOS connection (base URL, username, password) with a **Test connection** button, plus a **change admin password** form and dark-mode toggle.
- Admin is locked behind a password (default `Ts13`) that can only be changed from within the admin session.

### 🌗 Light & dark mode
Toggle from the top bar; the choice is saved.

## MPDV production orders

Selected from the start menu (or the badge in the top bar). Each **cart line** becomes an **order** followed by **one operation per arm**, authenticated with HTTP Basic. No workplan order is involved — that path was removed in v1.12.

**1. `POST /data/BOOrder/insert`** — the order has to exist first, because the operations reference its id.

| Field | Value |
|---|---|
| `order.id` | **the running order number**, `ddmmyyxx` |
| `order.ordertype` | **which AGV fetches it** — `0` kuka, `1` tusk — set per product |
| `order.plan.yield.base` | **the quantity the customer ordered**, as a JSON number |
| `order.latest_end_ts` | fixed deadline, from admin |

**2. `POST /data/BOOperation/insert`, once per arm** — both are sent for every order.

| Field | Openmind arm | Kuka arm |
|---|---|---|
| `order.id` | the order's id | the order's id |
| `operation.operation` | `0010` | `0010` |
| `operation.plan.workplace` | `ROBOT01` | `ROBOT02` |
| `operation.article` / `.designation` | `BRACES` | `PEN` |
| `operation.plan.yield.primary` | the ordered quantity | the ordered quantity |

`plan.unit.primary` (`PCS`), the `BEA_ZY` / `RLFZ` formulas, their `FORMULA` modes and the `60000` cycle target are sent exactly as supplied. The identity fields above are editable in **Admin → Settings → MPDV**; both arms ship with operation number `0010`, and the panel warns that MPDV may refuse the second as a duplicate on the same order, in which case give it its own number.

**A refused operation is retried** — three attempts, one then two seconds apart — before the next one is sent. If the **order** insert fails, no operation is sent against an order that does not exist. Every call is kept in the log and on the result screen with what was sent, what came back and which attempt succeeded, so a failure points at the exact step.

The running number is **`DDMMYY` + a two-digit counter** that restarts each day — `03082601`, `03082602`, … `04082601`. It is deliberately 8 characters: MPDV stores this id in an 8-character field, and a longer number is silently truncated, which would make every order of a day collide on one id. That caps the app at **99 MPDV orders per day**; beyond that it refuses to send rather than create a duplicate. The date follows the configured `timeZoneId`, not the PC clock, so the number matches the day MPDV records.

The log, its running order number and hand-over progress are written by the **main process**, so a save from the window never carries an older copy of them back — clearing the log makes it stay cleared, a send recorded while the panel is open is not wiped, and the running number can never be rewound onto an id MPDV has already been given.

Every send is logged in **Admin → Settings → MPDV** with the order number, quantity, HTTP status and whether MPDV accepted it. **The full response body and the request that produced it are kept for every order, successful or not**, expandable and pretty-printed in the log and on the order result screen. A success also reports the id MPDV actually stored; because that field truncates to 8 characters, the app flags it when what MPDV kept differs from what was sent. A failure additionally shows MPDV's own message. The message is dug out of whatever shape MPDV uses (`message`, `errorMessage`, `error`, an `errors` array, a nested `result`, or its `__rowType` rows); if the shape is unrecognised the raw body is shown verbatim, so nothing is ever hidden. MPDV also answers `200` for some rejected orders, so the body is inspected as well as the status code. The host serves a valid DigiCert certificate but not its full chain, so a "don't validate the TLS certificate" option is provided and enabled by default for it.

## SYNAOS connection

Configured in **Admin → Settings** (defaults are pre-filled). The app talks to the Job Management API:

| Endpoint | Use |
|---|---|
| `POST /api/v1/jobs` | Create a transport job (one per ordered unit) |
| `GET /api/v1/jobs/{id}` | Poll milestone/job status for the progress screen |
| `PUT /api/v1/jobs/{id}/discard-request` | Cancel an order's jobs |
| `POST /api/v1/operations` | Register the job as an operation for the SYNAOS frontend |

Authentication is HTTP Basic. All admin configuration (products, stations, prices, images, credentials, admin password, theme) is stored locally per-machine in the app's user-data folder.

## Download

Grab the latest installers from the [Releases page](../../releases):
- **Windows** — `GradionShop-Setup-1.12.2.exe`
- **macOS** — `GradionShop-1.12.2.dmg`

## Development

```bash
npm install       # install dependencies
npm start         # run the app locally
npm run dist:win  # build the Windows installer -> release/
npm run dist:mac  # build the macOS dmg -> release/ (must run on macOS)
```

Cross-platform installers are produced automatically by the **Build & Release** GitHub Actions workflow whenever a `v*` tag is pushed (Windows `.exe` on `windows-latest`, macOS `.dmg` on `macos-latest`).

## Tech

Electron • context-isolated preload IPC • Node's built-in `https` for the SYNAOS API client • [`mqtt`](https://www.npmjs.com/package/mqtt) for the robotic arm (the only runtime dependency).

## License

MIT — see [LICENSE](LICENSE).
