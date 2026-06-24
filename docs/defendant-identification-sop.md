# SOP: Defendant Identification & Forensic Investigation

**Role:** Intake Specialist / Investigator
**Time Cap:** Most should take 5–15 minutes max

This document is the source of truth for the **defendant identification** step. The goal is
to automate as much of this manual workflow as possible. An agent reads the evidence
(screenshot description / audio transcription) extracted earlier in the pipeline, identifies a
phone number or company name, and then loops through investigative steps to identify and locate
the legal entity behind the message.

---

## 1. Objective

Use whatever information exists in a screenshot or voicemail to identify and locate an **active
legal entity** (usually a corporation or LLC) we can sue — remember, *"if we can't find them, we
can't sue them."* If we can't sue them we can't hold them accountable and we can't get anyone
compensation even if there is otherwise a case.

The following information must be provided to the legal team for sign-up approval:

- The **name** of the company.
- The **website** of the company.
- The **type of goods/services** sold.
- The **state of incorporation** (e.g. Florida, California, Delaware).
- The **main office mailing address**.
- The **registered agent** name and address (commonly a different address).

---

## 2. Investigation Workflows

Use the internet to find the company however you can.

1. Review the text or call for a company name.
2. Google the company name and try to locate a website.
3. Make sure the website you locate is accurate to what is being advertised in the text/call. For
   example, if the texts/calls are about personal loans, the website you locate should also be a
   company that does personal loans, not a company in a totally different business — that would
   mean you probably have the wrong website.
4. Scroll through the website front page, looking for any company name, especially anything with
   **LLC** or **Corp**. These are commonly located at the bottom of the website, but not always.
5. Most websites have buttons at the bottom for "Terms and Conditions" / "Terms" and a button for
   "Privacy" / "Privacy Policy". The legal entity name can often be found by clicking those links —
   usually at the top or bottom of the terms or the privacy policy.

   **The Keyword Search:** Press `Ctrl+F` and search for:
   - `LLC`
   - `Inc`
   - `Company`
   - `governed by`

### TRACK A — The Evidence is a URL (Link)

Use this if the text message contains a link (e.g. `bit.ly/123` or `solar-savings.com`).

**Step 1: Unmask the Link**
If the link is a "short link" (like `bit.ly`, `tinyurl`, `tr.im`), find out where it really goes
before opening it.
- Go to `checkshorturl.com` or `unshorten.it`.
- Paste the short link to see the destination URL.
- Example: `bit.ly/123` → `www.shady-solar-deals.com/landing-page`

**Step 2: Find the Legal Entity (Terms & Conditions)**
- Scroll to the very bottom of the page (the footer).
- Look for links that say "Terms," "Terms of Service," "Privacy," or "Contact Us."
- Click those links.
- **Download:** Save the Terms and Privacy Policy as PDFs to the client's file.
- **Search:** Use `Ctrl+F` to search the text for corporate markers: `LLC`, `Inc`, `Company`,
  `Governed by the law`.
- **Capture:** Screenshot the paragraph that names the legal entity (e.g. *"Service provided by
  Sunshine Marketing, LLC, a Florida corporation"*).

### TRACK B — The Evidence is a Phone Number (No Link)

Use this if the text is just text, or for a voicemail case.

**Step 1: The "HELP" Text (OpenPhone)**
- Open your assigned OpenPhone account.
- Send a text message to the number that spammed the client.
- Message body: `HELP`
- *Why:* By law, legitimate automated systems must reply to "HELP" with the service/company name.
- If you get a reply identifying a company: screenshot it immediately. This is often the
  "smoking gun."

**Step 2: Google Investigation**
If Step 1 failed, use Google to find digital footprints. Try these search variations:
- **Company name:** If the text mentions a brand (e.g. "Offer from Speedy Cash"), Google
  "Speedy Cash".
- **Number formats:** `305-555-0199` (with dashes), `3055550199` (no dashes).
- **Text content:** Google the exact phrase in the text message inside quotes — e.g.
  `"Your car warranty is about to expire final notice"`.

**Step 3: The Call Back (OpenPhone)**
If you still don't know who they are, call the number using your OpenPhone line.
- Script: act like an interested customer.
  - You: *"Hi, I missed a call from this number. What is this regarding?"*
  - Them: *"We are selling health insurance."*
  - You: *"Oh, I'm actually looking for insurance. What is your website so I can learn more?"*
- **Goal:** Get the website URL. Once you have it, go back to Track A, Step 2 to find the legal
  entity.

---

## 3. Closing the Loop: Corporate Verification

Once you have a name (e.g. "Sunshine Marketing, LLC"), you need the official records to locate
them.

**Step 1: Find State of Incorporation**
- Go to `opencorporates.com` or `bizapedia.com`.
- Search the company name you found.
- Look for **Active** entities.
- *Note on Texas:* Texas charges $1.00 per search. If you find a company you believe is
  incorporated in Texas, **do not pay** — notify the legal team immediately.

**Step 2: Get the Main Office Address**
- Look at the OpenCorporates listing or the company's website "Contact Us" page.
- Record the mailing address for the company headquarters.

**Step 3: Get the Registered Agent (Secretary of State)**
- Once you know the state (e.g. Florida), find the official government record.
- Google the state corporation search (e.g. "Florida Corporation search").
- Click the official government (`.gov`) link.
- Search the exact legal name of the company.
- Copy the **Registered Agent Name** and **Registered Agent Address** exactly as they appear.

---

## 4. Check Company Against Repeat Defendant List

Cross-reference the identified entity against the firm's repeat-defendant list.

---

## 5. Solvability (Do They Have Money?)

**Step 1: The Employee Check**
Google: `"[Company Name] LinkedIn"` or `"[Company Name] employees"`.
- `< 10` employees: ⚠️ **Risk** (could be too small, but let's see)
- `11–50` employees: ✅ **Good** (solid target)
- `50+` employees: 💰 **Whale** (priority target)

**Step 2: The Revenue Snippet**
Google: `"[Company Name] revenue zoominfo"` or `"[Company Name] revenue"`.

---

## 6. Handoff Protocol

Update the Opportunity in GoHighLevel (GHL) and notify the legal team.
- **Input data:** Fill in Defendant Name, Website, State of Inc., Main Office Address, and
  Registered Agent info in the GHL fields.
- **Upload evidence:** Upload all screenshots (homepage, terms, HELP reply) and downloaded PDFs
  (Terms/Privacy) to the client's folder.
- **Change status:** Move the Opportunity to "Legal Review Needed".
