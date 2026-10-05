"""Dump a GreenMail (local test mail server) mailbox as JSON. Usage: python read-mailbox.py <login> [folder]"""
import email, imaplib, io, json, os, sys

m = imaplib.IMAP4('localhost', int(os.environ.get('GREENMAIL_IMAP_PORT', 3143)))
m.login(sys.argv[1], 'x')
m.select(sys.argv[2] if len(sys.argv) > 2 else 'INBOX')


def text(msg, kind):
    part = next((x for x in msg.walk() if x.get_content_type() == kind), None)
    return (part.get_payload(decode=True) or b'').decode('utf-8', 'replace') if part else ''


out = []
for n in m.search(None, 'ALL')[1][0].split():
    msg = email.message_from_bytes(m.fetch(n, '(RFC822)')[1][0][1])
    atts = [{'filename': x.get_filename(), 'type': x.get_content_type(), 'size': len(x.get_payload(decode=True) or b''), 'magic': (x.get_payload(decode=True) or b'')[:5].decode('latin1')} for x in msg.walk() if x.get_filename()]
    pdf_text = ''
    for x in msg.walk():
        if x.get_content_type() == 'application/pdf':
            try:
                import pypdf
                pdf_text = pypdf.PdfReader(io.BytesIO(x.get_payload(decode=True))).pages[0].extract_text()
            except Exception:
                pdf_text = ''
    out.append({'attachments': atts, 'pdfText': pdf_text, 'subject': msg['Subject'], 'inReplyTo': msg['In-Reply-To'], 'from': msg['From'],
                'body': text(msg, 'text/plain') or text(msg, 'text/html'), 'html': text(msg, 'text/html')})
print(json.dumps(out))
