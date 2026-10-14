"""Turning bank SMS and statements into transactions, and transactions into
an expense workbook. Plain rules, no model: free, offline, predictable.

Tuned for Indian banks and UPI apps (PhonePe, Google Pay, Paytm, BHIM), whose
SMS and statement formats are documented in the tests.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import os
import re
from collections import defaultdict

# ------------------------------------------------------------------ helpers

AMOUNT = r"(?:rs\.?|inr|₹)\s*:?\s*([\d,]+(?:\.\d{1,2})?)"

BANK_SENDERS = {
    "HDFC": "HDFC", "SBI": "SBI", "SBIUPI": "SBI", "SBIINB": "SBI", "SBMSMS": "SBI", "ICICI": "ICICI",
    "AXIS": "Axis", "KOTAK": "Kotak", "PNB": "PNB", "BOI": "Bank of India", "CANBNK": "Canara",
    "CANARA": "Canara", "YESBNK": "Yes Bank", "IDFC": "IDFC First", "INDUS": "IndusInd",
    "PAYTM": "Paytm", "FEDBNK": "Federal", "UNION": "Union Bank", "BOB": "Bank of Baroda",
    "IOB": "IOB", "INDBNK": "Indian Bank", "AUBANK": "AU Bank", "CITI": "Citi", "AMEX": "Amex",
    "SCBANK": "Standard Chartered", "RBL": "RBL", "UCO": "UCO", "CENTBK": "Central Bank",
    "JUPITER": "Jupiter", "FIBANK": "Fi", "SLICE": "slice", "PHONEPE": "PhonePe", "GPAY": "Google Pay",
}

DEFAULT_CATEGORIES = {
    "Food & Dining": ["swiggy", "zomato", "dominos", "domino", "pizza", "mcdonald", "kfc", "burger", "cafe", "coffee",
                      "starbucks", "restaurant", "hotel", "chai", "biryani", "bakery", "eatfit", "box8", "faasos", "dunzo"],
    "Groceries": ["bigbasket", "blinkit", "zepto", "instamart", "dmart", "grofers", "jiomart", "more retail",
                  "reliance fresh", "supermarket", "kirana", "milkbasket", "country delight", "nature's basket"],
    "Transport": ["uber", "ola", "rapido", "metro", "irctc", "redbus", "fastag", "petrol", "fuel", "hpcl", "bpcl",
                  "indian oil", "iocl", "parking", "namma yatri", "auto", "cab", "railway", "makemytrip",
                  "indigo", "air india", "akasa", "goibibo", "yatra", "cleartrip"],
    "Shopping": ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa", "tata cliq", "snapdeal", "lenskart",
                 "decathlon", "ikea", "croma", "reliance digital", "firstcry", "mall"],
    "Bills & Utilities": ["airtel", "jio", "vodafone", "vi ", "bsnl", "electricity", "bescom", "tneb", "msedcl",
                          "water", "gas", "broadband", "act fibernet", "recharge", "dth", "tata play", "bill",
                          "postpaid", "lpg", "indane", "bharat gas"],
    "Entertainment": ["netflix", "prime video", "hotstar", "spotify", "bookmyshow", "pvr", "inox", "youtube",
                      "sonyliv", "zee5", "jiocinema", "gaana", "steam", "playstation", "xbox"],
    "Health": ["pharmacy", "apollo", "medplus", "netmeds", "pharmeasy", "1mg", "hospital", "clinic", "practo",
               "diagnostic", "lab", "cult.fit", "cultfit", "gym"],
    "Education": ["udemy", "coursera", "byju", "unacademy", "college", "school", "university", "tuition", "fees",
                  "book", "exam", "vtu"],
    "Rent & Home": ["rent", "nobroker", "society", "maintenance", "urban company", "urbanclap", "housejoy"],
    "Investments": ["zerodha", "groww", "upstox", "mutual fund", "sip", "nps", "ppf", "angel one", "kuvera", "coin"],
    "Transfers": ["self transfer", "own account"],
}

SKIP_PATTERNS = re.compile(
    r"\b(otp|one[- ]time password|verification code|will be debited|is due|due on|due date|collect request|"
    r"requested money|request of|has requested|payment request|failed|declined|unsuccessful|reversed|"
    r"auto[- ]?pay (is )?(set|scheduled)|mandate|e-?mandate|emi of .* due|minimum amount due|total amount due|"
    r"offer|cashback up ?to|win |congratulations|loan approved|pre-approved|apply now|kyc)\b",
    re.I,
)


def _money(s: str) -> float:
    return round(float(s.replace(",", "")), 2)


def _clean_merchant(m: str) -> str:
    m = m.strip(" .:-,*/")
    if "@" in m:  # a UPI VPA: swiggy.instamart@icici -> swiggy instamart
        m = m.split("@")[0]
        m = re.sub(r"[._\-]+", " ", m)
        m = re.sub(r"\d{6,}", "", m).strip()
    m = re.sub(r"\b(pvt|private|ltd|limited|llp|india|technologies|services)\b\.?", "", m, flags=re.I)
    m = re.sub(r"\s{2,}", " ", m).strip(" .,-")
    return m[:60].title() if m.isupper() or m.islower() else m[:60]


def bank_from_sender(sender: str) -> str:
    s = re.sub(r"^[A-Z]{2}-", "", (sender or "").upper()).replace("-", "")
    for key, name in BANK_SENDERS.items():
        if key in s:
            return name
    return ""


def looks_like_bank_sms(sender: str, body: str) -> bool:
    b = body.lower()
    alpha_sender = bool(re.match(r"^[A-Z]{2}-?[A-Z0-9]{3,}", (sender or "").upper())) and not re.match(r"^\+?\d+$", sender or "")
    money_words = re.search(r"(debited|credited|spent|sent|paid|withdrawn|received|deposited|txn|transaction|purchase)", b)
    account_words = re.search(r"(a/c|acct|account|card|upi|vpa|bank|neft|imps|rtgs|wallet)", b)
    return bool(money_words and account_words and (alpha_sender or bank_from_sender(sender) or "bank" in b or "upi" in b))


# ------------------------------------------------------------------ SMS


def parse_sms(sender: str, body: str, date_ms: float | None = None) -> dict | None:
    """One bank SMS -> a transaction dict, or None if it is not a completed payment."""
    text = " ".join(body.split())
    low = text.lower()
    if SKIP_PATTERNS.search(low) or not looks_like_bank_sms(sender, text):
        return None

    debit_at = min([m.start() for m in re.finditer(r"\b(debited|debit|spent|sent|paid|withdrawn|purchase|dr\b)", low)] or [10**9])
    credit_at = min([m.start() for m in re.finditer(r"\b(credited|credit|received|deposited|refund(ed)?|cr\b)", low)] or [10**9])
    if debit_at == credit_at == 10**9:
        return None
    direction = "debit" if debit_at < credit_at else "credit"

    amount = None
    m = re.search(AMOUNT, text, re.I)
    if m:
        amount = _money(m.group(1))
    else:  # SBI style: "debited by 20.0"
        m = re.search(r"(?:debited|credited)\s+(?:by|for|with)\s+([\d,]+(?:\.\d{1,2})?)", text, re.I)
        if m:
            amount = _money(m.group(1))
    if not amount:
        return None

    merchant = ""
    patterns_debit = [
        r"\bto\s+vpa\s+([\w.\-]+@[\w.\-]+)",
        r"\btrf\s+to\s+([A-Za-z0-9 .&'\-]+?)(?=\s+(?:ref|refno|upi|on)\b|[.,]|$)",
        r"upi/p2[am]/\d+/([^/\s]+)",
        r"\bat\s+([A-Za-z0-9 .&'*\-]+?)(?=\s+(?:on|via|ref|avl|txn|using)\b|[.,]|$)",
        r"\bto\s+([A-Za-z0-9][\w .&'@\-]{1,50}?)(?=\s+(?:on|ref|refno|upi|via|from|using|avl|txn|is)\b|[.,]|$)",
        r"\binfo[:\s]+([A-Za-z0-9 ./*\-]+?)(?=\s+(?:avl|bal)\b|[.,]|$)",
    ]
    patterns_credit = [
        r"\bvpa\s+([\w.\-]+@[\w.\-]+)",
        r"\bfrom\s+([A-Za-z0-9][\w .&'@\-]{1,60}?)(?=\s+(?:on|ref|refno|upi|via|to|in)\b|[.,(]|$)",
        r"\bby\s+([A-Za-z][\w .&'\-]{1,40}?)(?=\s+(?:on|ref|upi|via)\b|[.,(]|$)",
        r"upi/p2[am]/\d+/([^/\s]+)",
    ]
    if direction == "debit":
        # ICICI style: "debited for Rs 499.00 on 12-Oct-26; NETFLIX credited."
        patterns_debit.insert(0, r";\s*([A-Za-z][\w .&'\-]{1,40}?)\s+credited\b")
    for p in patterns_debit if direction == "debit" else patterns_credit:
        for mm in re.finditer(p, text, re.I):
            cand = mm.group(1).strip()
            # Skip captures that are really "your a/c XX1234", a phone number,
            # the bank's own fraud line, or a transfer rail like NEFT.
            if (
                re.match(r"^(your\b|a/?c\b|acct\b|account\b|card\b|xx|\*)", cand, re.I)
                or re.match(r"^[x*\d]{3,}", cand, re.I)
                or re.search(r"\b(block|fraud|dispute|customer care|helpline|call)\b", cand, re.I)
                or re.fullmatch(r"(neft|imps|rtgs|upi|nach|ach|net ?banking|mob bk|mobile banking)", cand, re.I)
            ):
                continue
            merchant = _clean_merchant(re.sub(r"^(neft|imps|rtgs|upi)\s+(from\s+)?", "", cand, flags=re.I))
            if merchant:
                break
        if merchant:
            break

    ref = ""
    mm = re.search(r"(?:upi\s*ref(?:\s*no)?|ref(?:erence)?(?:\s*no)?|refno|utr(?:\s*no)?|txn\s*id|rrn)[.:\s#]*([A-Za-z0-9]{6,})", text, re.I)
    if mm:
        ref = mm.group(1)
    else:
        mm = re.search(r"upi/p2[am]/(\d{6,})", text, re.I) or re.search(r"\bupi[:\s]+(\d{9,})", text, re.I)
        if mm:
            ref = mm.group(1)

    account = ""
    mm = re.search(r"(?:a/?c|acct|account|card)(?:\s*no\.?)?[\s:]*(?:ending\s*(?:with)?\s*)?[x*]*\s*(\d{3,4})\b", text, re.I)
    if mm:
        account = mm.group(1)

    when = dt.datetime.fromtimestamp((date_ms or dt.datetime.now().timestamp() * 1000) / 1000)
    return {
        "date": when.strftime("%Y-%m-%d"),
        "time": when.strftime("%H:%M"),
        "amount": amount,
        "direction": direction,
        "merchant": merchant or ("Unknown" if direction == "debit" else "Unknown sender"),
        "description": text[:200],
        "account": account,
        "bank": bank_from_sender(sender),
        "ref": ref,
        "source": "sms",
    }


# ------------------------------------------------------------------ statements

DATE_FORMATS = [
    "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y", "%b %d, %Y",
    "%B %d, %Y", "%d-%b-%Y", "%d-%b-%y", "%d %b %y", "%d.%m.%Y", "%d/%b/%Y", "%Y/%m/%d", "%m/%d/%Y",
]


def parse_date(value) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, dt.datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, dt.date):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip()
    s = re.sub(r"\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$", "", s, flags=re.I)
    for f in DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _num(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 2) if value else None
    s = re.sub(r"[₹,\s]|rs\.?|inr", "", str(value), flags=re.I)
    s = s.replace("(", "-").replace(")", "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    n = float(m.group(0))
    return round(n, 2) if n else None


HEADER_KEYS = {
    "date": ["txn date", "transaction date", "date", "value date", "posting date", "tran date"],
    "desc": ["narration", "description", "particulars", "transaction details", "details", "remarks", "merchant", "transaction remarks", "paid to", "name"],
    "debit": ["withdrawal amt", "withdrawal amount", "withdrawal", "debit amount", "debit", "dr amount", "amount debited", "paid out", "withdrawals"],
    "credit": ["deposit amt", "deposit amount", "deposit", "credit amount", "credit", "cr amount", "amount credited", "paid in", "deposits"],
    "amount": ["amount", "transaction amount", "amt", "amount (inr)", "amount(inr)"],
    "type": ["type", "dr/cr", "cr/dr", "debit/credit", "transaction type", "txn type"],
    "ref": ["ref", "reference", "chq./ref.no.", "ref no", "utr", "transaction id", "chq/ref number", "ref no./cheque no."],
}


def _map_header(row: list) -> dict | None:
    cells = [str(c or "").strip().lower() for c in row]
    col = {}
    for key, names in HEADER_KEYS.items():
        for i, c in enumerate(cells):
            if i in col.values():
                continue
            if any(c == n or (len(n) > 3 and c.startswith(n)) for n in names):
                col[key] = i
                break
    if "date" in col and ("desc" in col) and ({"debit", "credit"} & col.keys() or "amount" in col):
        return col
    return None


def rows_to_transactions(rows: list[list], source: str) -> list[dict]:
    out = []
    header = None
    for row in rows:
        if header is None:
            header = _map_header(row)
            continue
        if not any(c not in (None, "") for c in row):
            continue
        get = lambda k: row[header[k]] if k in header and header[k] < len(row) else None  # noqa: E731
        date = parse_date(get("date"))
        if not date:
            continue
        desc = " ".join(str(get("desc") or "").split())
        debit, credit = _num(get("debit")), _num(get("credit"))
        if debit is None and credit is None:
            amt = _num(get("amount"))
            if amt is None:
                continue
            t = str(get("type") or "").lower()
            if "cr" in t or "credit" in t or "received" in t:
                credit = abs(amt)
            elif "dr" in t or "debit" in t or "paid" in t or amt < 0 or not t:
                debit = abs(amt)
        if debit:
            direction, amount = "debit", abs(debit)
        elif credit:
            direction, amount = "credit", abs(credit)
        else:
            continue
        out.append({
            "date": date, "time": "", "amount": amount, "direction": direction,
            "merchant": merchant_from_narration(desc), "description": desc[:200], "account": "", "bank": "",
            "ref": str(get("ref") or "").strip()[:40], "source": source,
        })
    return out


def merchant_from_narration(desc: str) -> str:
    d = desc.strip()
    # UPI narrations: "UPI/DR/628512345678/SWIGGY/YESB/swiggy@yesbank/Payment"
    m = re.match(r"^upi[/-](?:dr|cr|p2[am])?[/-]?(?:\d{6,}[/-])?([^/]+)", d, re.I)
    if m and not re.match(r"^\d+$", m.group(1)):
        return _clean_merchant(m.group(1))
    m = re.search(r"(?:paid to|received from|to|from)\s+(.+?)(?:\s+(?:upi|ref|on)\b|$)", d, re.I)
    if m:
        return _clean_merchant(m.group(1))
    m = re.search(r"([\w.\-]+@[\w.\-]+)", d)
    if m:
        return _clean_merchant(m.group(1))
    return _clean_merchant(re.sub(r"^(pos|ach|nach|neft|imps|rtgs|atm|ecom|ib|mb)[/\s-]+", "", d, flags=re.I)[:40])


# PhonePe statement lines: "Oct 12, 2026 Paid to Swiggy DEBIT ₹250"
PHONEPE_LINE = re.compile(
    r"^(?P<date>[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\s+(?P<desc>.+?)\s+(?P<type>DEBIT|CREDIT)\s+(?:₹|rs\.?|inr)\s?(?P<amt>[\d,]+(?:\.\d{1,2})?)",
    re.I,
)
# Google Pay / Paytm / generic: "12 Oct 2026 ... Paid to Swiggy ... ₹250.00"
GENERIC_LINE = re.compile(
    r"^(?P<date>\d{1,2}[\s/-][A-Za-z]{3,9}[\s/-]\d{2,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+(?P<rest>.+)$"
)


def parse_text_statement(text: str, source: str) -> list[dict]:
    out = []
    lines = [" ".join(l.split()) for l in text.splitlines() if l.strip()]
    for i, line in enumerate(lines):
        m = PHONEPE_LINE.match(line)
        if m:
            nxt = " ".join(lines[i + 1 : i + 4])
            ref = re.search(r"(?:transaction id|utr no\.?)\s*:?\s*([A-Za-z0-9]{8,})", nxt, re.I)
            tm = re.search(r"\b(\d{1,2}:\d{2}\s*(?:am|pm))\b", nxt, re.I)
            desc = m.group("desc")
            out.append({
                "date": parse_date(m.group("date")), "time": tm.group(1) if tm else "",
                "amount": _money(m.group("amt")), "direction": m.group("type").lower(),
                "merchant": _clean_merchant(re.sub(r"^(paid to|received from|payment to|sent to)\s+", "", desc, flags=re.I)),
                "description": desc[:200], "account": "", "bank": "PhonePe" if "phonepe" in source.lower() else "",
                "ref": ref.group(1) if ref else "", "source": source,
            })
            continue
        g = GENERIC_LINE.match(line)
        if not g:
            continue
        date = parse_date(g.group("date"))
        rest = g.group("rest")
        amts = re.findall(r"(?:₹|rs\.?|inr)?\s?(-?[\d,]+\.\d{2})\b", rest, re.I)
        if not date or not amts:
            continue
        low = rest.lower()
        if re.search(r"\b(cr|credit|received|refund)\b", low):
            direction = "credit"
        elif re.search(r"\b(dr|debit|paid|sent|purchase)\b", low):
            direction = "debit"
        elif len(amts) >= 2:
            direction = "debit"  # withdrawal column before balance
        else:
            direction = "debit"
        amount = abs(_money(amts[0]))
        desc = re.sub(r"(?:₹|rs\.?|inr)?\s?-?[\d,]+\.\d{2}.*$", "", rest, flags=re.I).strip()
        out.append({
            "date": date, "time": "", "amount": amount, "direction": direction,
            "merchant": merchant_from_narration(desc), "description": desc[:200], "account": "", "bank": "",
            "ref": "", "source": source,
        })
    return out


def parse_statement_file(path: str, password: str | None = None) -> list[dict]:
    ext = os.path.splitext(path)[1].lower()
    source = os.path.basename(path)
    if ext in (".csv", ".txt"):
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
            rows = list(csv.reader(f))
        tx = rows_to_transactions(rows, source)
        if not tx:
            with open(path, encoding="utf-8-sig", errors="replace") as f:
                tx = parse_text_statement(f.read(), source)
        return tx
    if ext in (".xlsx", ".xlsm", ".xls"):
        if ext == ".xls":
            raise ValueError("Old .xls files are not supported: open it in Excel and save as .xlsx, or export CSV.")
        import openpyxl

        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        tx = []
        for ws in wb.worksheets:
            tx += rows_to_transactions([list(r) for r in ws.iter_rows(values_only=True)], source)
        return tx
    if ext == ".pdf":
        import pdfplumber

        tx, text = [], []
        with pdfplumber.open(path, password=password or None) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables() or []:
                    tx += rows_to_transactions(table, source)
                text.append(page.extract_text() or "")
        # Text parsing catches layouts with no ruled table (PhonePe, GPay).
        text_tx = parse_text_statement("\n".join(text), source)
        return tx if len(tx) >= len(text_tx) else text_tx
    raise ValueError(f"Unsupported statement type {ext}: use PDF, CSV or XLSX.")


# ------------------------------------------------------------------ categories


def rules_file() -> str:
    home = os.environ.get("ONYX_HOME") or os.path.join(os.path.expanduser("~"), ".onyx")
    return os.path.join(home, "expense_rules.json")


def load_rules() -> dict[str, str]:
    try:
        with open(rules_file(), encoding="utf-8") as f:
            return {k.lower(): v for k, v in json.load(f).items()}
    except Exception:
        return {}


def save_rule(keyword: str, category: str) -> dict:
    rules = load_rules()
    rules[keyword.lower().strip()] = category.strip()
    os.makedirs(os.path.dirname(rules_file()), exist_ok=True)
    with open(rules_file(), "w", encoding="utf-8") as f:
        json.dump(rules, f, indent=2, ensure_ascii=False)
    return rules


def categorize(tx: dict, rules: dict[str, str] | None = None) -> str:
    hay = f" {tx.get('merchant', '')} {tx.get('description', '')} ".lower()
    for kw, cat in (rules if rules is not None else load_rules()).items():
        if kw in hay:
            return cat
    if tx.get("direction") == "credit":
        if re.search(r"salary|sal cr|payroll", hay):
            return "Salary"
        if re.search(r"refund|reversal|cashback", hay):
            return "Refunds"
        return "Money In"
    for cat, kws in DEFAULT_CATEGORIES.items():
        if any(k in hay for k in kws):
            return cat
    if re.search(r"\batm\b|cash withdrawal|nwd|atw", hay):
        return "Cash"
    # A UPI payment to a person's name rather than a business.
    merchant = tx.get("merchant", "")
    if merchant and not merchant.startswith("Unknown") and re.match(r"^[A-Za-z]+(\s[A-Za-z]+){0,2}$", merchant) and tx.get("source") == "sms":
        return "People"
    return "Other"


def tx_key(tx: dict) -> str:
    if tx.get("ref"):
        return "ref:" + re.sub(r"\W", "", str(tx["ref"])).lower()
    base = f"{tx.get('date')}|{tx.get('amount')}|{tx.get('direction')}|{re.sub(r'[^a-z0-9]', '', str(tx.get('merchant', '')).lower())[:12]}"
    return "h:" + hashlib.sha1(base.encode()).hexdigest()[:16]
