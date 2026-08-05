# 🎁 Gradion Shop — SYNAOS &amp; MPDV Order App

A Shopee-style desktop ordering app that dispatches orders to either of two systems, chosen from a start menu:

- **SYNAOS** — creates AGV transport jobs through the SYNAOS Job Management API and tracks them live.
- **MPDV** — creates workplan orders in the MPDV MES.

Built with Electron for Windows and macOS, with light/dark mode and separate **user** and **admin** interfaces.

![status](https://img.shields.io/badge/version-1.10.1-e0563f)

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
- **Recalls on a timer** — a recall can also repeat by itself: tick *Run this recall automatically* and give it a wait in minutes. The wait is measured **from the moment the previous run finished**, never from when it was sent, so a recall can never be triggered on top of a trip the AGV is still driving — which is what puts the vehicle into an error state. A run counts as finished only when *every* job it created reports `FINISHED`, the trailing park move included, and anything uncertain (an API hiccup, a hand-over leg the relay supervisor has not created yet) counts as *still running*; a 30-second settling gap is then added before the countdown starts. Sending a recall **by hand** arms the same watcher, so the timer waits for that run too, and switching the option on starts a countdown rather than a run. By default a recall also holds while a customer order is still in progress. Repeated failures (three in a row) or a run that never reports finished **switch the timer off** and say so in the log rather than sending another AGV after it. The panel shows the live state — *next run in 4:37*, *running now*, *holding until the order is finished* — and the timer runs wherever the operator is in the app, for as long as the app is open.
- **Stations** — map a friendly name + **function** (production, storage, shop, charging…) to a SYNAOS station address ID used in job milestones. Each station can be given an **icon from an image file**, which is what the customer sees on that stop in the order tracking; without one it falls back to an emoji. **Add from SYNAOS** reads the real station addresses the tenant uses (derived from the job-manager, the only data reachable with Basic auth — the layout/fleet services sit behind an OAuth2 gateway), so you don't hand-type IDs.
- **Robots** — **nothing is added automatically.** A tenant carries plenty of AGVs that have nothing to do with this shop, so reading from SYNAOS only *offers* what it found and saves only what you tick. SYNAOS does not let this app list the fleet (that page sits behind its own web login), and reading job history only reveals robots that have already run a job. So **paste the vehicle list** copied from SYNAOS's Fleet Management page: every id in the text is verified against SYNAOS before being offered, and surrounding words are harmless because anything that isn't a real resource simply fails the check. **Ids & patterns** covers ranges and wildcards (`36020-36040`, `#` a digit, `?` a digit or letter, `[1-9]` a set, 600 ids per scan) for predictable naming, but an id with an unguessable part such as `sc-aware-JQ3H0018` can only be found by pasting it. Each robot is also marked **real** or **simulated** — guessed from the name, since SYNAOS exposes no such flag over this API, and overridable per robot.
- **Nodes** — an address book of navigation-graph points (waiting spots, parking, staging) kept separate from handling stations, each with a friendly name. A robot's waiting spot is chosen from this list rather than typed by hand, and reading from SYNAOS files node addresses here instead of mixing them in with stations.
- **Robot ↔ station access** — each station has an *allowed robots* list. The app also mines job history for `UNABLE_TO_ACCESS_ADDRESS` and marks those robots ✖ for that station. A product's robot dropdown only offers robots that can reach **every** station on its route; the rest are disabled with the reason. Products default to **“Auto — only robots that can reach these stations”**, which pins a capable robot (spread across them) instead of leaving it to the SYNAOS scheduler, which has been observed picking unreachable robots. A pinned-but-incapable robot is never sent — the job degrades to scheduler assignment with a warning.
- **Waiting spots** — each robot can be given a home node on its navigation graph (e.g. `00` on `TUSK/NODES`). Once a robot finishes its part of an order, the app appends a `MOVE` to that node at the end of *its* job, so it parks itself. The trailing move is tagged with a correlation and excluded from the customer's progress, and the next robot in a relay waits on the previous robot's last **delivery** milestone — not on it finishing parking. Robots left to the SYNAOS scheduler get no waiting spot, since the app can't know which robot will run the leg.
- **Hand-overs are placed by hand** — a hand-over is a step you add to a route with **+ Add hand-over (robotic arm)**, with its own `method`; the quantity the arm moves is the quantity the customer ordered. The arm is only ever asked to move something where you put one; a robot change on its own just splits the route into two jobs. The editor previews exactly which jobs will be created and where the arm runs, and warns if a hand-over doesn't sit between a **DROP** and a **PICK at the same station**.
- **Robotic arm (MQTT)** — the arm is driven over MQTT. Configure the broker URL (`mqtt://`, `mqtts://`, `ws://`, `wss://`), TLS certificate validation, credentials, the command/status topics, and a **payload template** with `{taskId}` `{method}` `{quantity}` `{from}` `{to}` `{orderId}` `{unitId}` placeholders so the JSON matches the arm exactly. At a hand-over the app publishes the command, waits for the configured “finished” value on the status topic — matched back by the echoed task id, so an interim `Started` or another task's status can't release it — and only then creates the receiving AGV's job. A configurable timeout stops a silent arm from wedging an order. **Test connection** and **Send test transfer** verify the setup without placing an order, and a live log shows recent MQTT traffic and hand-overs in progress. The supervisor runs in the main process, so it keeps going even if the customer leaves the progress screen, and resumes hand-overs left in flight after a restart.
- **Settings** — SYNAOS connection (base URL, username, password) with a **Test connection** button, plus a **change admin password** form and dark-mode toggle.
- Admin is locked behind a password (default `Ts13`) that can only be changed from within the admin session.

### 🌗 Light & dark mode
Toggle from the top bar; the choice is saved.

## MPDV production orders

Selected from the start menu (or the badge in the top bar). Each **cart line** becomes one workplan order via `POST .../MDWorkplanOrder/generateOrder`, authenticated with HTTP Basic.

| Field | Value |
|---|---|
| `workplanorder.id` | fixed, from admin (e.g. `00003150`) |
| `workplanorder.target.id` | **the running order number** |
| `workplanorder.ordertype` | fixed, from admin |
| `workplanorder.plan.yield.base` | **the quantity the customer ordered**, as a JSON number |
| `workplanorder.latest_end_ts` | fixed deadline, from admin |

The running number is **`DDMMYY` + a two-digit counter** that restarts each day — `03082601`, `03082602`, … `04082601`. It is deliberately 8 characters: MPDV stores this id in an 8-character field, and a longer number is silently truncated, which would make every order of a day collide on one id. That caps the app at **99 MPDV orders per day**; beyond that it refuses to send rather than create a duplicate. The date follows the configured `timeZoneId`, not the PC clock, so the number matches the day MPDV records.

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
- **Windows** — `GradionShop-Setup-1.10.1.exe`
- **macOS** — `GradionShop-1.10.1.dmg`

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
