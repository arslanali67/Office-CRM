# Knowledge Base (R06 / R07)

The AI answers customers **only** from the articles below. Every `## heading` under *Articles* becomes one published Knowledge Base article.

**Status: TEST DATA.** Brightline Digital is an invented company. Replace every article with your real facts before go-live (M3.2 stays open until then).

**How to put in your real data**
1. Edit this file: change the text under each `## heading`, remove `(TEST)` from the headings, add or delete articles as needed.
2. Write every price exactly, with currency (for example `USD 1,499`). Any price the AI writes that is not in this file is blocked and sent to a person.
3. Write only contact details (phone, email, links) that customers may receive; any other contact detail in a reply is blocked.
4. Run `node --env-file=.env scripts/load-kb.mjs`. It creates or updates each article and deletes every `(TEST)` or `(PLACEHOLDER)` article no longer in this file, so old test facts cannot leak into replies. Articles you created yourself in the CRM are never deleted; remove those in the CRM.

Alternatively edit the articles in the CRM's Knowledge Base tab, but then this file is out of date and the next `load-kb.mjs` run overwrites articles with the same heading.

# Articles

## Services (TEST)
Brightline Digital is a small web agency for local businesses: shops, clinics, restaurants, salons and consultants.
We design and build mobile-friendly websites, online stores, local search optimisation (SEO), social media management, logo design and website care (hosting, updates, backups).
We work in English. All work is done remotely; meetings are by video call.

## Pricing (TEST)
What each package and service costs: the price, how much is included and the delivery time (all prices in US dollars, taxes not included):
- Website + SEO Starter package: USD 799, delivered in 3 weeks. Up to 5 pages, contact form, Google Business Profile setup, basic on-page SEO.
- Business Website package: USD 1,499, delivered in 5 weeks. Up to 12 pages, blog, booking form, on-page SEO for 10 keywords.
- E-commerce Store package: USD 2,999, delivered in 8 weeks. Up to 100 products, card payments, shipping setup, training session.
- Local SEO monthly plan: USD 299 per month, minimum 3 months.
- Social media management: Basic USD 199 per month (2 platforms, 12 posts), Growth USD 399 per month (3 platforms, 20 posts, monthly report).
- Logo design: USD 249, three concepts and two revision rounds.
- Website care plan: USD 49 per month (hosting, updates, daily backups, small text changes).
- Extra work outside a package: USD 60 per hour.
Payment: 50% deposit to start, 50% on delivery. Monthly plans are paid in advance. We accept bank transfer and card.

## Hours and contact (TEST)
Office hours: Monday to Friday, 9:00 to 17:00 (Eastern Time). Closed on weekends and public holidays.
Messages that arrive outside office hours are answered on the next working day.
Phone: +1 555 0100. Email: hello@brightline.test. Website: https://brightline.test

## Booking a call (TEST)
The first consultation call is free and takes 15 minutes, by video call.
To book, reply with two or three days and times that suit you. A team member confirms the slot by email within one working day.
Before the call, please send your business name, your current website (if any) and what you want to achieve.

## Process and timelines (TEST)
1. Free consultation call. 2. Written quote within 2 working days. 3. Deposit paid, project starts within 5 working days.
4. Design draft for your feedback. 5. Build and two revision rounds. 6. Launch and a short training video.
Delivery times in the price list start when we have your deposit and your content (texts, photos, logo).
If you have no texts or photos, we can write texts and use licensed stock photos as extra work.

## Policies (TEST)
Refunds, cancellations, complaints and legal questions are handled personally by the owner; the team will put you in touch.
Monthly plans can be cancelled with 30 days' notice.
You own your website, domain and content after the final payment.
We never share customer data with third parties.

## Common questions (TEST)
Do you work with businesses outside the US? Yes, we work with clients worldwide, remotely.
Can I update the site myself? Yes, every site comes with an easy editor and a short training video.
Do you offer hosting? Yes, through the Website care plan.
Can you redesign my existing site? Yes, we quote a redesign after the free consultation call.
Do you write the texts? We can, as extra work, or you send your own.
Will my site work on phones? Yes, every site is mobile-friendly.
Do you guarantee first place on Google? No. Nobody can honestly guarantee rankings; we do the work that helps you rank locally.
How soon will I see SEO results? Usually within 2 to 4 months.
Do you run paid ads? No, we do not manage paid advertising.
Which social platforms do you manage? Facebook, Instagram and LinkedIn.
Do you design logos only? Yes, the logo design service can be booked on its own.
Can I pay in instalments? Yes: 50% deposit to start and 50% on delivery.
Do you sign a contract? Yes, every project has a short written agreement.
Do you build online stores? Yes, with the E-commerce Store package.
Can my customers book appointments online? Yes, the Business Website package includes a booking form.
Do you translate websites? No, we work in English only.
Do you build mobile apps? No, we build websites and online stores only.
What do I need to start? Your business name, logo (if you have one), texts and photos, and the deposit.
Who owns the domain? You do; we register it in your name.
Do you do backups? Yes, daily backups are part of the Website care plan.
Can I see examples of your work? Yes, ask us and a team member will send examples.
Do you offer discounts? Only when a written offer from us says so.
Is the consultation call free? Yes, the first 15-minute call is free.
How do I contact you? See Hours and contact.
How fast do you reply? Within one working day.
Can I change my plan later? Yes, monthly plans can be upgraded at any time from the next month.
Do you work with WordPress? Yes, most of our sites are built on WordPress.
Can you move my site from another company? Yes, as extra work at the hourly rate.
Do you send invoices? Yes, for every payment.
Do I need to be technical? No, we handle the technical side and explain everything in plain words.
