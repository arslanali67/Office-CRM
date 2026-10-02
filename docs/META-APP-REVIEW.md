# Meta App Review kit

What to do to get Instagram and Facebook messaging approved for live customers. Meta reviews the app by hand, so the submission must show exactly what each permission does. Plan on 1 to 3 weeks and expect at least one round of questions.

## Before you submit

1. **Business verification** in Meta Business Settings (company documents). Required for Advanced Access.
2. **Facebook Page and Instagram professional account**, with the Instagram account connected to the Page.
3. **App** of type Business at developers.facebook.com, with the Messenger and Instagram products added.
4. **Public pages** (served by this CRM once deployed; check with `sh scripts/deploy.sh check`):
   - Privacy policy URL: `https://<CRM_DOMAIN>/privacy`
   - Data deletion URL: `https://<CRM_DOMAIN>/data-deletion` (choose "Data deletion instructions URL" in App Settings > Basic)
   - Fill `COMPANY_NAME`, `COMPANY_ADDRESS`, `CONTACT_EMAIL` in `.env`, then `sh scripts/deploy.sh render-site`.
5. **Webhook**: callback URL `https://<CRM_DOMAIN>/webhooks/meta`, verify token = `META_VERIFY_TOKEN` from `.env`. Subscribe the Page to `messages`; subscribe Instagram to `messages`.
6. **Tokens**: a long-lived Page access token goes in `META_PAGE_TOKEN` (see docs/GO-LIVE.md); `META_APP_SECRET` from App Settings > Basic.
7. **App roles**: add the reviewers' test accounts under Roles > Testers, and your own account as admin. Until approval, only people with a role can message the Page.

## Permissions to request, with the justification text

Paste these into the "How will your app use this permission" boxes, adjusting the company name.

| Permission | Justification |
|---|---|
| `pages_messaging` | Our staff answer customer questions that people send to our Facebook Page in Messenger. The app receives the message, shows it to the right employee in our internal CRM, and sends the reply (written by the employee or an assistant-drafted reply they approved) back in the same conversation, inside the 24-hour window. We do not message anyone who has not written to us first. |
| `pages_manage_metadata` | Needed to subscribe our Page to the webhook so that new messages reach our CRM. Used once at setup. |
| `pages_show_list` | Needed to select our Page when generating the access token. |
| `instagram_basic` | Needed to read the profile name and ID of the person who messages our Instagram account, so the employee knows who they are talking to. |
| `instagram_manage_messages` | Our staff answer direct messages sent to our business Instagram account. Messages arrive in our internal CRM; the reply goes back in the same conversation, inside the 24-hour window. No unsolicited messages. |
| `instagram_manage_comments`, `pages_read_engagement`, `business_management` | **Do not request.** The app does not use them; asking for more than you use is the most common reason for rejection. |

Data handling statement (asked in the form): messages are stored in our own server (no third-party CRM), visible only to our staff, and deleted on request (see the data deletion URL). An AI service drafts replies; sensitive categories (complaints, refunds, legal) are never answered automatically.

## Screencast (one per permission, 1 to 3 minutes, English captions)

Meta rejects when it cannot see the whole flow. Record the screen at 1080p with the cursor visible, and show real login pages (the reviewer must see you are in the real Facebook / Instagram UI, not a mock).

Shot list for Messenger (`pages_messaging`):
1. Open the CRM, log in as an employee. Show the Conversations list.
2. On a phone or in a browser, log in to Facebook as the **tester account** and send a message to the Page: "Hi, what are your opening hours?"
3. Back in the CRM: show the message arriving in the Conversation (name, channel, text).
4. Type a reply (or approve the AI draft) and send. Show the reply arriving in the tester's Messenger.
5. Say aloud or caption: "The app only replies to people who wrote first, within 24 hours."

Shot list for Instagram (`instagram_manage_messages`, `instagram_basic`): the same five steps with an Instagram tester account, and show the sender's username displayed in the CRM (that is `instagram_basic`).

Shot list for `pages_manage_metadata`: App Dashboard > Messenger > Webhooks, showing the Page subscribed to `messages`; then send a message and show it reaching the CRM.

Tips: use a test message that is not private; do not blur the Page name; keep the reply flow in one unbroken take.

## Reviewer instructions (paste in "Notes for reviewer")

> Log in to the CRM at https://<CRM_DOMAIN> with the credentials below (a read-only demo employee). Send a message to the Page "<Page name>" (or Instagram account "@<handle>") from your tester account. Within a few seconds it appears under Conversations. Open it and press Send to reply; the reply appears in your Messenger/Instagram inbox. Username: <demo user> Password: <demo password>

Create a dedicated demo employee for this (`node --env-file=.env scripts/add-employee.mjs`) and delete it after approval. Never give reviewers the owner login.

## Tester checklist (run before you submit)

- [ ] `sh scripts/deploy.sh check` passes, including `/privacy` and `/data-deletion`
- [ ] A message from the tester Facebook account appears in the CRM within 10 seconds
- [ ] A message from the tester Instagram account appears in the CRM
- [ ] A reply sent from the CRM arrives in both apps
- [ ] The CRM refuses a reply after 24 hours (Meta policy), and shows why
- [ ] AI is in draft-only mode for the review (Owner dashboard > AI control)
- [ ] The reviewer demo account can reach Conversations and nothing else important

## Common rejection reasons

- **"We could not see the permission being used"**: the screencast skipped a step, cut away, or used a mock. Re-record in one take.
- **Requesting permissions the app does not use**: remove them.
- **Privacy policy or data deletion URL not reachable / not specific**: must load without login and mention the Page/Instagram and how to delete.
- **Reviewer could not log in or reproduce**: the demo account failed, the server was down, or the Page had no subscription. Test with a fresh account first.
- **Business not verified**: finish Business verification first.
- **Message sent outside the 24-hour window or unsolicited**: the CRM blocks this by design; show that in the video if asked.

After approval switch the app to Live mode, set the tokens in `.env`, and run `sh scripts/deploy.sh update`. Remove the demo employee.
