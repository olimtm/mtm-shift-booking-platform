# Worker access and post-shift updates

Workers use the existing portal address with their own email and password. Connecteam and Xero are not part of this release. Post-shift updates are stored in the portal's persistent database; they do not change Airtable fields or records.

## Invite a worker

1. In **Support workers**, check that the worker is present and active. Airtable **Active** and **Active - Volunteer** staff are included unless archived.
2. Open **People & access → Invite someone**. Enter the worker's name and email, choose **Support worker**, and select their existing worker record.
3. Create the invitation link and send it privately using your usual communication channel. The link expires after 48 hours and can be used once. It is not emailed automatically.
4. The worker follows the link, chooses a password and signs in. They see only confirmed or cancelled shifts assigned to that worker record. They cannot approve requests, change bookings or manage accounts.

Only one worker login can link to each worker record. For an existing account, issue a new invitation or password-reset link instead of creating another login. Coordinators retain their existing full access. Airtable roster synchronization does not create logins or change account roles.

Disabling the login blocks access immediately. A worker who becomes inactive, archived or removed from Airtable loses access when the portal refreshes the roster (normally every five minutes). A failed refresh keeps the last complete roster; a coordinator can disable access immediately in **People & access**. Reassigning a shift removes it from the previous worker's access.

## Submit after a shift

1. The worker opens **Updates to complete**, then **Write post-shift update**. A shift must be confirmed and its booked end time must have passed.
2. Complete **What did we do?**, **How did it go?**, and the participant's feedback if they provided any. Distinguish the participant's own words or communication from staff observations.
3. Under **Goal progress**, add each goal or skill, select **Practised**, **Made progress**, **Maintained skills** or **Needed more support**, and give a concrete example. Up to eight goals can be recorded. If goals were not worked on, select that option and explain why.
4. Optionally add **For next time**. Use **Internal only** for handover notes, coordinator follow-up and an incident-report reference. Continue using the existing incident reporting process.
5. Select **Preview shared update**, check the family-facing content, then **Submit & share update**.

Submission publishes immediately, without coordinator approval. Client accounts explicitly linked to the participant can read the update under **Shift updates** and in the shift details. An open dashboard refreshes approximately every 30 seconds or when brought back into focus. This release does not send notification emails, SMS or push messages.

Internal notes, follow-up details and incident references are available only to coordinators and the currently assigned worker. The server excludes them from every client response, including revision history.

## Corrections and follow-up

The original author can edit their report while still assigned to the confirmed, ended shift. Coordinators can write or correct reports for these shifts. The original author, latest editor and revision history are retained. A replacement worker can read the existing handover but needs a coordinator to amend another person's report. Updates remain readable for cancelled shifts but cannot be edited while cancelled.

Coordinators have **Shared updates**, **Awaiting update** and **Follow-up needed** tabs with participant filtering. To resolve a follow-up, edit the report and clear **Coordinator follow-up needed**. Saving a correction shares its public content immediately and preserves the previous version.

Old completed bookings without a report also appear in **Awaiting update**; the feature does not fabricate historical reports or send reminders.

## Deploy this release

The schema migration adds a worker-account link and report/revision tables automatically at application startup. Existing bookings, accounts, assignments and Airtable settings are retained. No new environment variables or Airtable changes are needed. Keep the existing persistent `DATABASE_PATH`; the full SQLite backup procedure also covers reports and revision history.

After GitHub's **Portal checks** pass for the desired commit, deploy that commit on the existing Render service. With the repository's manual deployment setting, use **Manual Deploy → Deploy latest commit**. Wait for **Live**, reload the portal, and confirm **Shift updates** appears and **Support worker** is available under **People & access → Invite someone**. Use a designated test worker/participant for live testing, since a submitted update is immediately visible to that participant's linked accounts.
