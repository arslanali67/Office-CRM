"""Builds samples/eval-emails-100.csv: 100 invented test emails for the AI accuracy check (R14 / M3.6).
Matches the test Knowledge Base (docs/KNOWLEDGE-BASE.md). Run: python samples/make-eval-emails.py
Replace with real, anonymised emails before relying on the result for go-live."""
import csv
import os
import sys
from collections import Counter

D = []


def add(cat, *rows):
    for subject, body in rows:
        D.append((subject, body, cat))


add('inquiry',
    ("Services", "Hi, what kind of services does Brightline Digital offer? I run a small bakery."),
    ("Do you build online stores?", "Hello, I sell handmade candles and want to sell them online. Is that something you do?"),
    ("Question about SEO", "Can you explain what your local SEO plan includes? I'm not sure if it's right for a dental clinic."),
    ("Opening hours", "Hi there, what time do you close on Fridays? I wanted to call you."),
    ("Working with non-US clients", "We're a salon based in Toronto. Do you work with businesses outside the US?"),
    ("Can I edit the site myself?", "If you build my website, will I be able to change the text and photos myself, or do I have to ask you every time?"),
    ("Hosting", "Do you also host the websites you make, or do I need to find my own hosting?"),
    ("Redesign", "Our current website is from 2015 and looks terrible on phones. Do you do redesigns?"),
    ("Social media", "Which social media platforms do you manage for clients?"),
    ("Logo only", "Do you design logos on their own, without a website?"),
    ("Domain ownership", "If I order a site from you, who owns the domain name afterwards?"),
    ("WordPress?", "Are your websites built on WordPress? My previous developer used something custom and it was a nightmare."),
    ("Do you run ads", "Do you also manage Google Ads or Facebook ads for clients?"),
    ("Mobile app", "Hello, can you build a mobile app for my restaurant? Or only websites?"),
    ("How long does SEO take", "Roughly how long until I see results from local SEO? A friend said a few weeks."),
    ("Guarantee", "Can you guarantee that my site will be number one on Google?"),
    ("Moving my site", "I have a site with another company and want to move it to you. Is that possible?"),
    ("Backups", "What happens if my website breaks or gets hacked? Do you keep backups?"),
    ("Contract", "Do you sign a contract for projects, or is it just an email agreement?"),
    ("What do you need from me", "If I decide to go ahead, what do I need to prepare? I only have a logo and a few photos."),
    ("Examples", "Could you send some examples of websites you have built for similar businesses?"),
    ("Languages", "Do you build websites in other languages, for example French?"))

add('pricing',
    ("Starter package", "Hello, how much does the Website + SEO Starter package cost and what is included?"),
    ("Price list", "Could you please send me your price list?"),
    ("E-commerce price", "What would an online store with about 60 products cost?"),
    ("Monthly SEO", "How much is the monthly local SEO plan? Is there a minimum period?"),
    ("Social media cost", "What do you charge for managing Instagram and Facebook? We post about three times a week."),
    ("Logo price", "How much does a logo cost, and how many revisions do I get?"),
    ("Care plan", "What is the monthly price for website hosting and updates?"),
    ("Hourly rate", "If I need small extra changes after the site is done, what is your hourly rate?"),
    ("Payment terms", "Do I have to pay everything upfront or can I pay in parts? And how much is the business website package?"),
    ("Quote", "Hi, we need a 10 page website for our consulting firm. Can you give me a quote?"),
    ("Cost?", "how much"),
    ("Do you offer discounts", "The Business Website package looks good but it is a bit above our budget. Do you offer any discounts?"),
    ("Price comparison", "Another agency quoted us USD 1,200 for a 5 page site. What is your price for something similar?"),
    ("Cuanto cuesta", "Hola, cuanto cuesta el paquete de sitio web con SEO? Gracias."),
    ("Taxes", "Are your prices including tax? I saw USD 799 on the Starter package."),
    ("Budget", "We have about 2000 to spend. What could we get for that?"),
    ("Growth plan", "What is the difference in price between the Basic and Growth social media plans?"),
    ("Pricing for non-profit", "We are a small charity. What would the cheapest option for a simple website be?"))

add('booking',
    ("Free call", "I'd like to book the free 15 minute consultation. I'm free Tuesday or Thursday afternoon."),
    ("Schedule a call", "Can we set up a video call next week to discuss a new website? Any day after 2pm works."),
    ("Appointment", "Hi, I would like to make an appointment to talk about my project. What times do you have on Monday?"),
    ("Book consultation", "Please book me for a consultation this Friday at 10am Eastern if possible."),
    ("Reschedule", "I booked a call for Wednesday but something came up. Can we move it to Thursday at the same time?"),
    ("Call this week?", "Hello, is anyone available for a quick call this week? I want to talk about SEO for my restaurant."),
    ("Free consultation", "How do I book the free consultation you advertise? I'd like to do it tomorrow if possible."),
    ("Meeting request", "We'd like to meet your team on a video call on the 15th to discuss redesigning our site. Is 11am OK?"),
    ("Evening slot", "Do you have any slots after 6pm? I work until 5 and would like to book a call."),
    ("Cancel my call", "I need to cancel the call we planned for tomorrow, sorry. I'll write again when I'm ready."),
    ("Consultation next month", "I'm travelling now, but could I book a call for the first week of next month?"),
    ("Calendar", "Can I pick a time on your calendar online, or should I just email you the times?"),
    ("Quick chat", "Could we have a quick chat on Monday morning? I'd like to ask about the e-commerce package."),
    ("Book a meeting", "Please schedule a meeting with someone who can explain the Business Website package. Thursday works for me."))

add('complaint',
    ("Website is broken", "The contact form on the website you built stopped working and I've lost customers because of it. This is really disappointing."),
    ("No reply", "I've emailed three times this month and nobody has replied. This is unacceptable service."),
    ("Late delivery", "You promised my site in 5 weeks and it's been 9. I'm very unhappy with how this was handled."),
    ("Wrong colours", "I asked for dark blue and you used bright green. I'm angry that my feedback was ignored."),
    ("Rude staff", "Your team member was rude to me on the phone yesterday. I expected better."),
    ("Terrible", "Terrible experience. The site looks nothing like the draft you showed me."),
    ("Mistakes in the text", "There are spelling mistakes all over my new website. How did this get approved? I'm really upset."),
    ("Slow site", "My website takes ten seconds to load. I'm disappointed, this is not what I paid for."),
    ("Posts went out wrong", "Your social media team posted the wrong opening hours on our page. A customer showed up while we were closed. Not acceptable."),
    ("Nobody told me", "Nobody told me about the extra charge for stock photos. I feel misled and I'm not happy about it."),
    ("Disappointed", "I'm very disappointed with the quality of the logo concepts. They look like clip art."),
    ("Still waiting", "It has been three weeks since you said you'd fix the booking form. I'm frustrated and tired of waiting."))

add('refund_legal',
    ("Refund please", "I would like a refund of the deposit I paid last month. The project never started."),
    ("Money back", "I want my money back. The site is not what we agreed. Please refund USD 750 today."),
    ("Chargeback", "If I don't get my deposit back this week I will file a chargeback with my bank."),
    ("Lawyer", "I have forwarded this matter to my lawyer. You will be hearing from them about breach of contract."),
    ("Legal action", "We intend to take legal action if the website is not delivered by Friday."),
    ("Cancel and refund", "Please cancel my order and send the refund to my card."),
    ("GDPR request", "Under GDPR I request you delete all personal data you hold about me and confirm in writing."),
    ("Dispute", "I am disputing the last invoice. I will report your company to the consumer protection agency if it isn't refunded."))

add('lead_reply',
    ("Re: Website proposal for your business", "Thanks for your proposal. We are interested in your offer, can we talk this week?"),
    ("Re: A better website for Lahore Retail", "Hi, thank you for reaching out with the proposal. The 10% discount sounds good. What are the next steps?"),
    ("Re: Offer for your clinic", "Hello, I read your email with the Starter package offer. Please tell me more about it."),
    ("Re: Quick question about your website", "Thanks for the proposal, but we already have a web designer. No thanks."),
    ("Re: Your website", "Interested in your offer. Please call me on Thursday."),
    ("Re: Free SEO audit", "Thanks for your email. We'd like to take you up on the offer you sent, who do I speak to?"),
    ("Re: Proposal", "Thank you for your proposal. Please send me more details about what is included before I decide."),
    ("Re: Offer", "We received your proposal, thanks! We are discussing it internally and will come back to you."))

add('spam',
    ("YOU WON!!!", "Congratulations winner! You have been selected for a lottery prize of $1,000,000. Click here to claim."),
    ("Cheap pills", "Buy cheap viagra online, no prescription, click here to claim your discount."),
    ("Make money with crypto", "Double your bitcoin in 24 hours. Guaranteed. Join our crypto group now."),
    ("Unsubscribe", "Special offer for you! Limited time. To stop receiving these emails click unsubscribe."),
    ("SEO services 99$", "We will put your website on page 1 of Google for only $99. Click here to claim your free report."),
    ("Dear beneficiary", "I am a lawyer from Nigeria with an inheritance of $8.5 million for you. Reply with your bank details."),
    ("Verify your account", "Your account is locked. Click here immediately to verify your password. Winner of our monthly draw!"),
    ("Hot singles", "Meet singles in your area tonight, click here to claim your free membership."))

add('other',
    ("Partnership", "We are a photography studio and wonder whether you'd like to partner with us and refer clients to each other."),
    ("Job application", "Hi, I'm a junior web developer looking for a position at your company. My CV is attached."),
    ("Invoice from supplier", "Please find attached our invoice for office supplies for the month of September."),
    ("Press", "I'm a journalist writing about small web agencies. Could I interview the owner for an article?"),
    ("Wrong address", "I think this email was meant for someone else, sorry to bother you."),
    ("zzz", "qqq zzz"),
    ("Out of office", "I am out of the office until Monday with limited access to email."),
    ("Thank you", "Just wanted to say thank you for the great work on our site last year. Our customers love it."),
    ("Guest post", "Would you like to publish a guest article on your blog? We can provide it for free."),
    ("Accounting software", "Hello, are you interested in a demo of our accounting software for small businesses?"))

assert len(D) == 100, len(D)
assert len({(s, b) for s, b, _ in D}) == 100
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'eval-emails-100.csv')
with open(out, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['subject', 'body', 'expected_category'])
    w.writerows(D)
print(len(D), dict(Counter(c for _, _, c in D)), file=sys.stderr)
