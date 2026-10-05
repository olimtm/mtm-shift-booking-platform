# Add the client portal through the WordPress editor

You can add the portal to **www.matesthatmatter.com** yourself. First follow [the do-it-yourself hosting guide](DO-IT-YOURSELF.md) to put the application on Render. Render provides an HTTPS address ending in `.onrender.com`; you can use it without changing your domain or an agency handoff.

Adding a WordPress page creates the entrance to the portal. The booking application itself runs on Render, with its own login and database.

## Make the page

1. In the ordinary WordPress editor, create a page called **Client Portal**.
2. Add a heading: **Your support, all in one place**.
3. Add this paragraph:

   > Sign in to view your upcoming support, request a new shift, or ask for a change to an existing booking. Our team reviews requests and changes before confirming them.

4. Add a **Buttons** block with the label **Sign in to the client portal**.
5. Paste the **actual portal address shown in your Render service dashboard** into the button's link. Keep this page as a draft until that address and client login have been tested. Do not use a made-up example address or an invitation/reset link.
6. Add this help text:

   > Need access or help signing in? Contact the Mates That Matter team so we can link your account to the right participant or participants.

7. Preview the page and click the button. Confirm it opens the portal's sign-in page. Once the invitation, client access, and booking workflows have been checked, publish the page and add **Client Portal** to your site's navigation using its menu/navigation editor.

Use an ordinary link opening in the same tab. No custom HTML, WordPress plugin, iframe, or portal passwords are needed in the WordPress editor. The application deliberately prevents being embedded in another site's frame.

## Give someone access

Sign into the portal as a coordinator, open **People & access**, and create a client invitation. Select the participant or participants that person is permitted to manage, then privately send them the generated invitation link. They use it to choose their own password. The portal does not email this link automatically.

A representative can manage more than one participant with a single account. This account is separate from your WordPress website editor account. If someone forgets their portal password, verify their identity and use People & access to create a password-reset link for them.

The Airtable PAT and webhook secret belong in the hosting provider's secure settings and the appropriate Airtable Automation secret setting. They never go into the WordPress page or a public button.
