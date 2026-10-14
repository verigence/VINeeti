# Verigence VINeeti

**Booking-to-delivery control for car dealerships. By JBR Consulting.**

Verigence VINeeti works alongside the dealership's DMS. It reads the two files the DMS already produces,
the **stock report** and the **booking sheet**, and from them keeps one answer to three questions:

- Which car is free, which is reserved, and for whom?
- Who is next in line for each car, and who was given a car out of turn?
- What has to be looked at today: cancelled bookings still holding a car, payments not verified, cars
  ageing in the yard, delivery dates at risk.

It then runs the process around that answer: first booked, first served allocation; the customer told on
WhatsApp; the payment window (reminder, escalation, re-allocation); exceptions only with a second person's
approval; alarms to the Business Head / CEO and the Dealer Principal; and a reconciliation every evening.

One deployment serves many dealerships. A dealership (one dealer, one manufacturer) has its own outlets,
users, rules, WhatsApp number and data. Each manufacturer's DMS file layout is an adapter
(`src/oem/`), chosen by the dealership's OEM; the adapter in this version is **Mahindra**. A dealership of
another manufacturer can be onboarded and worked from the screens, and its files are refused with a
plain message until its adapter is written from real exports. Nothing is guessed from an unknown layout.

It runs on Cloudflare: one Worker, one D1 database, one scheduled trigger every 15 minutes. No customer
document is stored anywhere in the system.

## The two DMS files

Loaded daily, or every few days, on the **End of day** screen, the Data upload screen, or by a scheduled
job (see [End of day](#end-of-day)). Excel (.xlsx) as exported; a .csv with the same headings also works.

| File | What it gives | What the system does with it |
| --- | --- | --- |
| Stock report (`stock report as on DD.MM.YYYY.xlsx`) | Every car: VIN, description, colour, outlet, received or in transit, GRN, and the DMS allotment (Stock Type, Order ID, invoice) | Updates the stock master. Free cars go to the customers waiting for them. A DMS allotment is recorded against its booking and checked against the queue. |
| Booking sheet | Every booking: DMS Booking Number, date and time, customer, car, stage (Booked, Invoiced, Cancellation Initiated), sales consultant | Adds and updates bookings. A cancelled booking releases its car, which goes to the next customer in line in the same load. |

What links the two: `Order ID` in the stock report is the `DMS Booking Number` in the booking sheet.

Loading is safe to repeat. The same file loaded twice changes nothing; the two files can come in either
order; a file for another dealer, an older stock report, or a stock report that would remove a large part
of the stock is refused with the reason. Rows that cannot be applied are listed with the row number and
reason, and the rest of the file is still loaded. A very large change is applied in steps (the screen and
the scheduled job send the file again until it is done).

### What reconciling the files finds

| In the files | What happens |
| --- | --- |
| Booking cancelled | The booking is cancelled; its car is released and allocated to the next customer, who is told |
| Car allotted in the DMS to the booking that already holds it | Confirmed |
| Car allotted in the DMS to a booking, car was free | Recorded as that booking's car. If an earlier booking for the same car was waiting, it is marked **out of turn** and raised as an alarm |
| Car reserved for one booking, allotted or invoiced in the DMS to another | **Bypass**: recorded as the DMS has it, marked out of turn against the booking that was passed over, alarm raised |
| DMS allotment removed | The car is released and goes by the queue |
| Car invoiced | Booking and car marked invoiced; the payment window stops |
| Retail invoice cancelled in the DMS | Reversed, alarm raised |
| Car no longer in the stock report | Invoiced car: delivered. Free car: left stock. Reserved, not invoiced: booking put on hold, alarm raised |
| Car arrived (in transit to received) | Status updated; if reserved, the customer is told and the payment window starts |
| Allotment to an order number not in any booking sheet loaded | Kept as an allotment known only from the stock report, and completed when a sheet brings that booking |

### Reading a Mahindra car

A Mahindra car is identified by **Category, Model, Trim, Transmission, Fuel, Drive, Seater and Variant**.
The DMS writes all of it in one description, for example `XUV3XO AX5 PM MT WQ(A3EVRSTWHT)(M1024)`:
variant text, paint alias, colour code, model code. `src/oem/mahindra.ts` reads it (a TypeScript port of
the dealership's own parser, `tools/mahindra_description_parser.py`, with four fixes marked `FIX 1` to
`FIX 4` in that file). The vehicle master is built from the files themselves; nobody types it.

- A booking and a car are the same car when they have the same model, the same variant (which includes
  the manufacturer's model code, e.g. `AX5 PM MT (M1024)`) and the same colour.
- Colour is matched by the paint alias in the description, not by the colour name, because the two files
  often name the same paint differently (`TANGO RED` / `TAANGO RED`).
- Two names are never treated as the same colour by guesswork (`WHITE` and `DIAMOND WHITE` stay apart).
  Where the dealership knows they are the same, it says so once on the Vehicle master screen.
- A description the parser does not recognise is loaded under the DMS's own model name, flagged, and
  listed at day end. Nothing is guessed.

## Who uses it

Everyone signs in with their mobile number. A person works in all outlets or in the outlets given to
them, and that limit applies to every list, dashboard and file.

| Persona | What they get |
| --- | --- |
| **Sales Executive** | The stock-and-date answer for any car; their own bookings and each one's place in the queue; reports a customer's payment for Finance to verify |
| **Sales Lead** | The team's bookings at their outlets; approves bookings entered in the app; raises exception requests |
| **Finance** | The payments queue: verifies that a reported payment has been received, or that it has not; records invoicing and delivery; sees stock value |
| **CRM** | Customer messages and replies, contact corrections, holds, delayed deliveries; loads the DMS files |
| **Business Head / CEO** | Receives the alarms; decides exceptions; owns the allocation rules; the owner's view and measures |
| **Dealer Principal** | The owner's view across outlets: customers waiting, cars not matched, delivery dates at risk, out-of-turn allocations, unsold stock by age; decides exceptions; receives the alarms |
| **System Admin** | Users and outlets, the employee sheet, password resets, settings, WhatsApp connection, the end-of-day key |
| Stock In-charge, Ordering Desk, Auditor | Receive and move cars and load the files; orders on the manufacturer and the vehicle master; read-only access with the audit trail |

The Roles and controls screen shows, for each persona, exactly what it may do under the dealership's
current settings. Who approves bookings, who decides exceptions and who receives alarms are settings.

### The sales executive's answer

For a model, variant and colour, one of four answers, with the count of free and reserved cars and the
number of bookings already ahead:

1. **In the yard, free**: can be delivered now.
2. **In transit**, with the expected date.
3. **Invoiced by the manufacturer, date not firm**. The stock report carries no dispatch or arrival date.
   If the dealership sets its usual transit time, an indicative date is shown, marked as indicative.
4. **Needs an order**.

Every answer and every dashboard shows the stock report and booking sheet it was worked out from, and
says so when they are out of date.

### The owner's view

Customers waiting; cars not matched to any booking; delivery dates at risk; **out-of-turn allocations**
(who got the car, who was passed over, who approved it, or that nobody did); unsold stock by age
(0-15, 16-30, 31-60, over 60 days from the manufacturer's invoice) with value for those allowed to see
it; bookings with no car coming; payments awaiting verification; and each outlet's position.

Measures are computed only where the data supports them: delivery on promised date, cancellations while
waiting, yard-to-invoice and yard-to-delivery days, stock older than 30 days, funding interest per car
sold (when the dealership sets its funding rate), out-of-turn allocations, bookings with no car coming.
Delivery complaints and time to answer an enquiry are shown as **not measured**: neither file carries them.

### Analytics

Fixed rules over the same two files, on the Analytics screen; every view states its rule and the files it
rests on, and the same files always give the same answer. Charts are drawn with Apache ECharts
(Apache-2.0, bundled; no external service) from the numbers the API gives.

- **Ageing stock by model**: unsold cars (in the yard or in transit, not demo, held by no booking) by
  days since the manufacturer's invoice (0-15, 16-30, 31-60, over 60), oldest and average age, dealer
  value for those allowed to see it, and each model's oldest cars.
- **Not picked up**: customers whose reserved car has been at the dealership for more than N days
  (default 10): payment or invoicing pending, or invoiced in the DMS but still in the stock report.
- **Most and least selling**: sales counted as retail invoices in a period (default the last 90 days);
  most selling model and car (model, variant, colour); least selling among the models the dealership
  stocks; equal counts ordered by name.
- **Allocations by day**: every allocation and every release (de-allocation) in a period, by day and
  outlet, with how it came about or why.
- **Stock by day**: each outlet's position (free and reserved, in yard and in transit, invoiced, blocked)
  at the end of every day on which a DMS file was loaded or the day-end ran.

### Notifications

| Who | How | What |
| --- | --- | --- |
| Customer | WhatsApp templates (editable, approved by Meta) | Car allocated (in transit, free stock, re-allocated), car arrived, payment reminder |
| Sales Executive | In-app alerts and one WhatsApp template | Car allocated, car arrived, payment verified, payment pending, car released |
| Business Head / CEO and Dealer Principal | In-app alarms and one WhatsApp template | The alarms listed below |
| Finance, Sales Lead, Stock In-charge | In-app alerts | Payment to verify, escalations, transfers needed, approvals waiting |

## Controls

- **First booked, first served.** The queue is ordered by the booking's date and time in the DMS. The
  order can be changed only on the Allocation rules screen, and a change is announced and recorded.
- **One car, one customer.** The database itself refuses a second active allocation for a car or a booking.
- **Exceptions need two people.** A change of priority, skipping a customer, a named car, deferring a
  delivery, extending the payment window: each is a request with a reason, decided by a second person
  with an approver role. The person who raised it cannot decide it.
- **The bill must match the reservation.** A car invoiced to a different booking than the one it was
  reserved for is a bypass: recorded, raised as an alarm, and listed until it is reviewed.
- **Out-of-turn allocations are reviewed.** One that nobody approved beforehand stays "under review" until
  the Dealer Principal or the Business Head records what was found.
- **Finance verifies payments.** Sales can report a payment; only Finance can mark it received. The
  person who reported a payment cannot verify it.
- **Nothing is rewritten.** The audit trail and each car's history are append-only (the database refuses
  updates and deletes on them).
- **Booking checklist, not documents.** Before a booking entered in the app is submitted, four items are
  ticked: signed booking docket, KYC documents, PAN and Aadhaar, proof of minimum booking amount. The
  documents themselves stay where they are today; no copy is uploaded or stored.

### Payments and the payment window

When a reserved car is in the yard the window runs: reminder to the customer on day 3, escalation on day
5, re-allocation to the next customer on day 6 (all three are settings; messages go out in business hours).

1. Sales reports the payment with its reference (UTR, receipt or cheque number). It appears in Finance's
   queue. From then on the car is **held**: it is not re-allocated while Finance has not answered.
2. Finance verifies it as received: the window stops and the car stays with the customer. Or Finance
   records that it has not come in, with a note: the reporter is told and the window carries on.
3. If Finance does not answer within the agreed time (default 24 hours), an alarm is raised.

A car is also never re-allocated automatically while the DMS files are out of date.

### Alarms

Raised to the alarm recipients (default: Business Head / CEO and Dealer Principal), in the app and on
WhatsApp, once each:

bypass; out-of-turn allotment without approval; a reserved car that has left stock; a retail invoice
cancelled in the DMS; payment not received by the escalation day; a car taken back after the payment
window; a reported payment not verified by Finance in time; DMS files not loaded for longer than agreed
(default 3 days); high-severity findings at day end.

## End of day

The day closes in three steps, shown on the End of day screen: booking sheet read, stock report read,
reconciliation run.

- **By a person**: load the two files on the screen and run the reconciliation.
- **By a scheduled job** at the dealership: `scripts/eod-push.mjs` sends the files with the dealership's
  end-of-day key and asks for the reconciliation. The System Admin creates the key on the End of day
  screen; it is shown once, only its hash is stored, and it can do nothing except send these two files
  and ask for the reconciliation.

```bash
# every evening, e.g. from Windows Task Scheduler (Node 20 or later; no other dependency)
set EOD_KEY=vne_...
node eod-push.mjs --url https://<address> --dealer <dealer-code> --dir "D:\DMS exports"
```

`--dir` takes the newest file whose name contains "stock" and the newest whose name contains "booking".
See the top of the script for the other options. If nobody runs the reconciliation, it runs by itself at
the dealership's day-end time (default 21:00).

The reconciliation reports and never corrects by itself: stock per outlet (opening + added - left =
closing); cancelled bookings the DMS still shows allotted; out-of-turn allocations not reviewed; payments
reported and not verified; allotments to orders not in any booking sheet; rows the DMS has inconsistent
(for example a received car with no GRN); colour names to confirm; descriptions not recognised; free cars
and waiting bookings left unmatched; payment windows overdue; failed WhatsApp messages. Each finding is
closed by a person with a note, and the run can be downloaded as CSV.

## Getting people in

- The **mobile number is the ID**. The dealer code is asked for only if the same number is registered at
  two dealerships on the deployment.
- The System Admin loads the **employee sheet** (Excel: Name, Mobile, Role, Outlets, and optionally DMS
  ID and Email). The sheet to fill in is downloaded from the Users screen and already lists the sales
  consultants named in the booking sheet. Role is written in words (Sales Executive, Sales Lead, Finance,
  CRM, Business Head or CEO, Dealer Principal, ...); Outlets is the outlet codes or ALL. Loading the sheet
  again updates people and never changes a password or removes anyone. A person's DMS ID (SC Mile Id)
  makes the DMS bookings under that ID theirs.
- Each new person gets a **temporary password**, shown once to the System Admin, and must set their own
  at first sign-in.
- **Forgot password**: once the dealership's WhatsApp number is live, a 6-digit code is sent to the
  person's own mobile on WhatsApp (valid 10 minutes, usable once, limited to 3 requests in 15 minutes);
  entering it sets a new password. Otherwise, or as well, the **System Admin resets** the password: a new
  temporary password, and the person is signed out everywhere.

## WhatsApp

Each dealership connects its own number on the WhatsApp screen. Until then it is in **test mode**: every
message is recorded with its exact text and nothing is sent.

To go live, register the number with Meta (WhatsApp Business Platform, Cloud API) and enter on the screen:

| Field | Where it comes from |
| --- | --- |
| Phone number ID | WhatsApp Manager, API Setup (a numeric ID, not the phone number) |
| WhatsApp Business Account ID | Same page |
| Access token | A permanent System User token with `whatsapp_business_messaging` and `whatsapp_business_management` |
| App secret | Meta App, Settings, Basic (proves delivery receipts come from Meta) |
| Verify token | Any phrase you choose; type the same phrase in Meta when saving the webhook |

Going live is refused unless Meta confirms that the access token controls that phone number ID. In the
Meta App, set the webhook callback URL to `https://<address>/api/wa/webhook` and subscribe to `messages`.
The access token and app secret are stored encrypted and never shown again.

Messages use templates approved by Meta. The templates are on the WhatsApp screen with their wording and
can be sent for approval from there: allocation (in transit, free stock, re-allocated), car received,
payment reminder, escalation, management alarm, and the one-time password code (an authentication
template, whose wording Meta fixes). A customer whose mobile number is missing or who has not agreed to
WhatsApp is not messaged, and the log says why.

## Android app

`android/` is a Trusted Web Activity: a native Android app that opens the deployed site full screen, with
the product's splash screen and icon, as the Play Store expects for this kind of app. The workflow
**Build Android app** (Actions tab) takes the deployment's address and a version, and attaches a signed
APK (for direct installation) and an AAB (for the Play Store) to the run.

- The first run creates the signing key and attaches it as the artifact `android-keystore`: download it,
  keep it safe, and add the four `ANDROID_KEYSTORE_*` secrets it describes before the next build. An app
  signed with a different key is a different app to Android and to the Play Store.
- Every build prints the certificate's SHA-256 fingerprint. Put it in the repository secret
  `ANDROID_CERT_SHA256` and run the deployment again: the site then publishes
  `/.well-known/assetlinks.json`, and the app opens without the browser's address bar.

The same screens are the web app on a desktop browser and an installable web app (PWA) on any phone.

## Run it locally

Needs Node 22 or later.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                  # builds the screens and serves everything on http://127.0.0.1:8787
node scripts/seed-demo.mjs   # second terminal: a sample dealership, the two sample DMS files, one user per persona
```

The files in `samples/` are anonymised: no real customer, employee, vehicle or price data.

```bash
npm test          # runs the real code against an in-memory database
npm run typecheck
```

## Deploy to Cloudflare

The **Workers Paid** plan is needed: the free plan allows 50 database queries and 10 ms of CPU per
request, which is not enough to load a DMS file or to hash a password.

### With GitHub Actions

`.github/workflows/deploy.yml` runs on every push to `main` (and by hand from the Actions tab): type
check, tests, then deployment.

1. In Cloudflare, create an API token for the account with the permissions **Workers Scripts: Edit** and
   **D1: Edit** (the "Edit Cloudflare Workers" template, plus D1). An R2 storage token will not work, and
   R2 is not used.
2. In the GitHub repository, under Settings, Secrets and variables, Actions, add two repository secrets:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`, or run the workflow by hand.

The first run creates the D1 database (location hint `apac`) and the application's own secrets; every
run applies new database migrations, deploys, and waits for the health check. The address is printed in
the run's summary: `https://verigence-vineeti.<your-subdomain>.workers.dev`. A custom domain can be
attached to the Worker in the Cloudflare dashboard.

Then run the workflow **Onboard a dealership** once per dealership: dealer code, name, and the first
System Admin's name, mobile number and first password. It needs no further secret.

### By hand

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy.mjs           # the same steps as the workflow
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy.mjs --check   # only say what it would do
PLATFORM_ADMIN_TOKEN=... node scripts/onboard.mjs https://<address> scripts/dealer.example.json
```

`DATA_KEY`, created at the first deployment, encrypts each dealership's WhatsApp credentials. It is never
replaced by a later deployment and must not be replaced by hand.

### After the first deployment

1. The System Admin signs in with the mobile number and first password, and sets a new password.
2. Load the stock report, then the booking sheet. The first file fixes which dealer's files this
   dealership accepts and creates the outlets.
3. Download the employee sheet, add the mobile numbers and roles, and load it.
4. Check the settings: payment window days, approvers, alarm recipients, how often the DMS files are
   expected, and (optional) usual transit days and funding rate.
5. Connect the WhatsApp number when it is registered.
6. Create the end-of-day key and schedule `scripts/eod-push.mjs`, if the files are to be sent automatically.

## Layout

```
.github/workflows/  deployment, dealership onboarding, Android build
android/            the Android app (Trusted Web Activity)
migrations/         database schema
src/oem/            manufacturer adapters (Mahindra: reading a description, the two file layouts)
src/dms/            reading the stock report and the booking sheet
src/domain/         DMS import and reconciliation, allocation, rules, bookings and payments, timers, alarms,
                    exceptions, dashboards, measures and analytics, day-end reconciliation, onboarding
src/whatsapp/       templates, outbox, Cloud API client, webhook
src/http/           the API, sign-in, permissions, the end-of-day feed
src/scheduled.ts    the 15-minute job
web/                the screens (React, Apache ECharts; one installable web app, laid out for phones first)
test/               tests, with anonymised DMS files as fixtures
scripts/            deploy, onboard a dealership, end-of-day push, demo data
tools/              the Mahindra description parser (Python), as reviewed
samples/            anonymised sample DMS files
```

## Security

- Every row carries its dealership and every query filters on it; a session is bound to one dealership.
- Passwords are salted PBKDF2 hashes. Five wrong attempts lock an account for 15 minutes. Sessions are
  HttpOnly, Secure, SameSite cookies that last 12 hours and end at once on sign-out, deactivation or reset.
- One-time codes and the end-of-day key are stored only as hashes; a code is never written to any log.
- WhatsApp credentials are encrypted at rest; webhook events are accepted only with a valid Meta signature.
- Dealer price and stock value are shown only to roles allowed to see them.

## What it does not do

- It does not write to the DMS. Where the DMS has to be corrected (for example an allotment left on a
  cancelled order), the reconciliation says so and a person does it there.
- First booked, first served is only as complete as the booking sheets loaded: a sheet that covers one
  month does not contain older bookings still waiting. Load a sheet that covers every open booking.
- The booking sheet carries no promised delivery date, and the stock report no dispatch or arrival date.
  These are used when entered in the app; otherwise the answer says "date not firm".
- One WhatsApp number per dealership. Customer replies are recorded and shown, not answered automatically.
- Timers run on a 15-minute schedule, so a reminder goes out within 15 minutes of becoming due.
