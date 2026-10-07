# Put the portal online yourself

You can manage this directly in your own hosting and WordPress accounts. The portal will run on **Render**, which gives it its own HTTPS address. Your WordPress page will contain a button to that address. You do not need to write code or buy another domain.

This repository includes the hosting recipe, `render.yaml`. **Preparing this file does not deploy anything:** no Render account, paid service, public portal, or Airtable automation has been created by these instructions. The application code must be uploaded to GitHub before Render can use it.

## 1. Make sure the project is on GitHub

Open [the project repository](https://github.com/olimtm/mtm-shift-booking-platform). You should see `README.md`, `package.json`, `render.yaml`, and the application folders on its **main** branch.

The source is maintained on GitHub; do not depend on a workspace download link. `client`, `server`, `shared`, `automation`, `scripts`, tests, and deployment documentation belong in the repository. Environment files, credentials, databases, release ZIPs, build output, and dependencies are excluded. GitHub’s **Code → Download ZIP** is available if you need a source copy.

## 2. Create your Render service

1. Open [Render](https://dashboard.render.com/) and create your own account, preferably with the GitHub account that can access the project.
2. Choose **New → Blueprint**. Connect GitHub and grant access to **olimtm/mtm-shift-booking-platform**. Select that repository, its **main** branch, and the `render.yaml` file at the root.
3. Render will ask for three settings. These are entered in Render's private settings, not in WordPress or the repository:

   | Setting                       | What to enter                                                                              |
   | ----------------------------- | ------------------------------------------------------------------------------------------ |
   | `AIRTABLE_PAT`                | The full Airtable personal access token, copied privately from your saved secure settings. |
   | `AIRTABLE_BASE_ID`            | The base identifier beginning `app…`.                                                      |
   | `AIRTABLE_PARTICIPANTS_TABLE` | The exact existing participant table name or its `tbl…` identifier.                        |

   Credentials in your Codex development environment are **not automatically copied to Render**. Do not enter explanatory sentences as placeholder passwords.

4. Review the service and disk cost shown by Render before choosing **Deploy Blueprint**. This recipe uses the smallest paid web service (`0.5c-512mb`) and a 1 GB persistent disk; the free service cannot keep this app's booking database safely across deployments. See [current Render pricing](https://render.com/pricing). No payment has been made on your behalf.
5. Wait for the deployment to show **Live**, then open the HTTPS address shown on the service page. It will end in `.onrender.com`; copy your actual address, since Render may add a suffix to make it unique.

The recipe chooses Singapore, one of Render's listed regions. Your portal database will be hosted there. Check that this location suits your organisation's requirements before importing real participant records; the region cannot be changed in place. A custom Australian domain does not change where data is hosted.

Render installs and starts the application from the recipe. It also creates two random secrets for you: `MTM_SETUP_SECRET` and `RSVP_WEBHOOK_SECRET`. You do not need to invent either one. The app uses the Render address automatically, so no DNS settings or an agency handoff are needed.

The recipe includes the nonsecret field/value mappings checked against your Airtable base. These settings are `AIRTABLE_FIELD_MAP`, `AIRTABLE_SHIFT_VALUE_MAP`, `AIRTABLE_SUPPORT_TYPE_MAP`, and `AIRTABLE_RSVP_STATUS_MAP`. You do not need to type their JSON by hand. They reuse existing field names, keep Recommended support hidden until approved, and map Active/Dropped attendance correctly.

## 3. Set up your coordinator login

1. In Render, open your service's **Environment** settings and reveal/copy the generated value of **MTM_SETUP_SECRET** privately.
2. Open your portal address. On the initial setup screen, enter that setup key, your name, email, and a new portal password.
3. Create your coordinator account and sign in. The first-account setup is then closed; the setup key cannot create further accounts.
4. In the staff workspace, use **People & access** to invite a **second trusted coordinator**. Have them accept the invitation and check they can sign in. Keep two working coordinator accounts so one coordinator can issue a password-reset link if the other loses access. You can save your own password in a password manager.
5. Once Airtable is connected, **Support workers** automatically lists Staff records with status **Active**, **Active - Volunteer** or **Pending Superannuation Xero Input**, excluding archived records. It refreshes on startup and every five minutes; **Refresh workers** runs it immediately. Manage staff names/statuses in Airtable and bookings/assignments in the portal. Worker sync does not grant login access. Use **People & access** for coordinator, support worker or client invitations. For a worker, choose **Support worker** and link their existing worker record. For a client/representative, select exactly the participant records they should be able to see. Creating or importing a participant does not give anyone login access.

Invitation and password-reset links are shown for you to copy and send privately to the intended person through your usual communication channel. They expire after 48 hours and can be used once. This version does not send invitation or recovery emails automatically, so you do not need to configure an email service. A person who needs a password reset contacts your team; a coordinator creates a new reset link from People & access. Treat these links like temporary passwords.

## 4. Connect and check Airtable

Keep **AIRTABLE_SYNC_ENABLED=false** while setting up. This lets you inspect and import without sending new requests to Airtable.

1. Follow [the audit of your existing Airtable base](AIRTABLE-AUDIT.md): Claude’s six fields, **Declined**, and **Client Portal** are already present and the read-only schema check passed on 6 October 2026. Preserve these fields and options; do not add duplicates. Existing internal Office Notes remain separate from client-visible notes. Keep existing fields and choices.
2. Open the staff workspace's Airtable integration screen and run its **schema check**. The hosting recipe already includes the audited mappings. Resolve any remaining reported issues, then use the initial import and review participants, event times, existing shifts, and staff assignments. Check existing Request Notes are suitable for clients to see before importing them. Imports do not create client logins. Decide which client account can access which participant through People & access.
3. Enable outgoing synchronization only after this review. In Render's Environment settings, change **AIRTABLE_SYNC_ENABLED** to `true`, then save and redeploy. The Blueprint deliberately contains `false`; if you later resync the Blueprint, recheck this setting.
4. Follow [Configure the existing RSVP automation drafts](RSVP-AUTOMATION.md). Copy Render's generated **RSVP_WEBHOOK_SECRET** into the automation secret named **portalWebhookSecret**. The Airtable PAT and the webhook secret do different jobs and must be different values.
5. With a clearly designated test participant, check a new request, staff approval, an edit, and a cancellation. Check an event RSVP creates exactly one request with 30 minutes on each side, and repeated delivery does not duplicate it. Confirm a client sees only their linked participants.

Claude’s three portal automation drafts already exist, are disabled, and contain placeholders. Fill them using the repository script, real portal URL, and webhook secret. The old **1:1 event support request from RSVP** automation is still active. Disable that old creator at the tested cutover before enabling the portal drafts; running both risks duplicate rows. The field mapping must match the live base before you turn portal synchronization on. Airtable's Run a script action also requires a plan that supports that feature.

The persistent disk keeps the database across ordinary restarts. Before inviting real clients, also arrange and test a database backup/recovery process. Render's disk snapshots alone are not a verified SQLite backup procedure; restoring a disk can lose newer records. Use the tested [backup and recovery procedure](BACKUPS.md). No automatic external backup destination is configured by this recipe.

## 5. Add the WordPress button

Once the hosted portal and test accounts work, follow [the WordPress page steps](WORDPRESS-PAGE.md). Use the real `.onrender.com` URL from Render for the button.

Clients open the button, sign in to the portal, and see their support bookings. Your WordPress editor login is separate. A branded address such as `bookings.matesthatmatter.com` is optional later and would require access to your domain's DNS; the provider address already works without it.

## Day-to-day ownership

- Follow [Worker access and post-shift updates](POST-SHIFT-UPDATES.md) to invite workers and share activities, participant feedback and goal progress with linked client accounts. Reports publish immediately; internal notes stay private.
- Approvals, support settings, accounts, and staff assignments are managed in the portal. Airtable receives the configured updates; direct Airtable shift edits do not automatically update the portal.
- Check failed Airtable automation runs and the portal's sync status. Correct mapping/access failures before retrying.
- Keep access to both your Render and GitHub accounts. Publishing a new code version does not deploy it automatically: the recipe disables automatic deploys so you can choose **Manual Deploy → Deploy latest commit** in Render after testing updates. Deployments may briefly interrupt the single instance that owns the disk.
- Keep the paid service and persistent disk in place. Deleting the service or disk is not a password-reset or troubleshooting step.

The hosting recipe follows Render's [Blueprint reference](https://render.com/docs/blueprint-spec), [Node version guide](https://render.com/docs/node-version), and [persistent disk guide](https://render.com/docs/disks).
