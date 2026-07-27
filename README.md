# 🎁 Gradion Shop — SYNAOS Order App

A Shopee-style desktop ordering app that dispatches **SYNAOS intralogistics jobs** (AGV transport orders) through the SYNAOS Job Management API. Built with Electron for Windows and macOS, with light/dark mode and separate **user** and **admin** interfaces.

![status](https://img.shields.io/badge/version-1.7.0-e0563f)

## Features

### 🛍️ User interface
- Browse the products/jobs an admin has published, in a mobile-store style catalog.
- Add any item multiple times; a live order panel on the right shows quantities, per-item prices, and the running total.
- **Finish & Send to Robot** creates one SYNAOS transport job per ordered unit and jumps to a live **order-progress** screen. Ordering an item adds its quantity to the product's **sold** count.
- **Rate your order** — once an order is delivered, the customer rates each item 1–5 stars; the product's displayed rating becomes the **running average** of all ratings received.
- The progress screen polls the Job API and narrates the AGV journey — *Order placed → On the way to Production → Picked up → Delivering to Shop → Delivered!* — using each station's configured **function** label.
- **My Orders** keeps a history; reopen any order to see its live status. Confirm receipt ("👍 Got it!") or cancel (discards the SYNAOS jobs).

### ⚙️ Admin interface (password-protected)
- **Jobs / Products** — define each product as a sequence of job milestones (station + action + **the robot that performs it**, e.g. *Production · PICK → Shop · DROP*), set its price, attach an image file, and choose whether users can see it.
- **Multi-robot relays** — a SYNAOS job is executed by exactly one transport resource, so when consecutive steps use different robots the app splits the route into **one job per robot** and chains them with a milestone dependency (`requiredPredecessorStatus: FINISHED`), meaning a leg cannot start approaching until the previous leg has finished. The editor previews the split and warns if a robot change isn't a **DROP → PICK at the same station**, which is what a physical hand-over requires.
- **Stations** — map a friendly name + **function** (production, storage, shop, charging…) to a SYNAOS station address ID used in job milestones. **Add from SYNAOS** reads the real station addresses the tenant uses (derived from the job-manager, the only data reachable with Basic auth — the layout/fleet services sit behind an OAuth2 gateway), so you don't hand-type IDs.
- **Robots** — **Read from SYNAOS** lists the transport resources (AGVs) the tenant uses, with their mode and supported job types. **Add robot by id** registers robots discovery can't see (it only finds robots already used in jobs), validated live against SYNAOS — ids are case-sensitive.
- **Robot ↔ station access** — each station has an *allowed robots* list. The app also mines job history for `UNABLE_TO_ACCESS_ADDRESS` and marks those robots ✖ for that station. A product's robot dropdown only offers robots that can reach **every** station on its route; the rest are disabled with the reason. Products default to **“Auto — only robots that can reach these stations”**, which pins a capable robot (spread across them) instead of leaving it to the SYNAOS scheduler, which has been observed picking unreachable robots. A pinned-but-incapable robot is never sent — the job degrades to scheduler assignment with a warning.
- **Waiting spots** — each robot can be given a home node on its navigation graph (e.g. `00` on `TUSK/NODES`). Once a robot finishes its part of an order, the app appends a `MOVE` to that node at the end of *its* job, so it parks itself. The trailing move is tagged with a correlation and excluded from the customer's progress, and the next robot in a relay waits on the previous robot's last **delivery** milestone — not on it finishing parking. Robots left to the SYNAOS scheduler get no waiting spot, since the app can't know which robot will run the leg.
- **Hand-overs are placed by hand** — a hand-over is a step you add to a route with **+ Add hand-over (robotic arm)**, with its own `method` and `quantity`. The arm is only ever asked to move something where you put one; a robot change on its own just splits the route into two jobs. The editor previews exactly which jobs will be created and where the arm runs, and warns if a hand-over doesn't sit between a **DROP** and a **PICK at the same station**.
- **Robotic arm (MQTT)** — the arm is driven over MQTT. Configure the broker URL (`mqtt://`, `mqtts://`, `ws://`, `wss://`), TLS certificate validation, credentials, the command/status topics, and a **payload template** with `{taskId}` `{method}` `{quantity}` `{from}` `{to}` `{orderId}` `{unitId}` placeholders so the JSON matches the arm exactly. At a hand-over the app publishes the command, waits for the configured “finished” value on the status topic — matched back by the echoed task id, so an interim `Started` or another task's status can't release it — and only then creates the receiving AGV's job. A configurable timeout stops a silent arm from wedging an order. **Test connection** and **Send test transfer** verify the setup without placing an order, and a live log shows recent MQTT traffic and hand-overs in progress. The supervisor runs in the main process, so it keeps going even if the customer leaves the progress screen, and resumes hand-overs left in flight after a restart.
- **Settings** — SYNAOS connection (base URL, username, password) with a **Test connection** button, plus a **change admin password** form and dark-mode toggle.
- Admin is locked behind a password (default `Ts13`) that can only be changed from within the admin session.

### 🌗 Light & dark mode
Toggle from the top bar; the choice is saved.

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
- **Windows** — `GradionShop-Setup-1.7.0.exe`
- **macOS** — `GradionShop-1.7.0.dmg`

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
