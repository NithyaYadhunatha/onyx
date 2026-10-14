"""Run: .venv/Scripts/python -m unittest discover tests"""

import datetime as dt
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "servers"))
sys.path.insert(0, os.path.join(ROOT, "servers", "office"))
os.environ["ONYX_HOME"] = tempfile.mkdtemp()

import finance  # noqa: E402

T = int(dt.datetime(2026, 10, 12, 14, 30).timestamp() * 1000)

DEBITS = [
    # (sender, body, amount, merchant contains, ref)
    ("AD-HDFCBK", "Sent Rs.120.00 From HDFC Bank A/C x1234 To ZOMATO LTD On 12/10/26 Ref 628512345678 Not You? Call 18002586161/SMS BLOCK UPI to 7308080808", 120.0, "Zomato", "628512345678"),
    ("VM-SBIUPI", "Dear UPI user A/C X4321 debited by 20.0 on date 12Oct26 trf to SWIGGY Refno 628598765432. If not u? call 1800111109. -SBI", 20.0, "Swiggy", "628598765432"),
    ("JD-ICICIB", "ICICI Bank Acct XX567 debited for Rs 499.00 on 12-Oct-26; NETFLIX credited. UPI:628511112222. Call 18002662 for dispute. SMS BLOCK 567 to 9215676766.", 499.0, "", ""),
    ("AX-AXISBK", "INR 1,250.00 spent on Axis Bank Card XX4321 on 12-10-26 at AMAZON PAY INDIA. Avl Lmt INR 48,750.00. Not you? SMS BLOCK 4321 to 919951860002", 1250.0, "Amazon", ""),
    ("BZ-KOTAKB", "Sent Rs.85.00 from Kotak Bank AC X9876 to blinkit.payu@hdfcbank on 12-10-26.UPI Ref 628533334444. Not you, https://kotak.com/KBANKT/Fraud", 85.0, "Blinkit", "628533334444"),
    ("VK-YESBNK", "Rs.300.00 debited from A/c XX1111 on 12-10-2026 to VPA uber.rides@axisbank UPI Ref No 628555556666 -Yes Bank", 300.0, "Uber", "628555556666"),
    ("AD-PNBSMS", "A/c XX2222 debited INR 150.00 Dt 12-10-26 14:20:11 thru UPI:628577778888.Bal INR 5,000.00 Not u?Fwd this SMS to 9264092640 to block UPI.-PNB", 150.0, "", ""),
]

CREDITS = [
    ("AD-HDFCBK", "Money Received - INR 500.00 in your HDFC Bank A/c xx1234 on 12-10-26 by A/c linked to VPA rahul.k@okaxis (UPI Ref No 628599990000).", 500.0),
    ("VM-SBIINB", "Dear Customer, your A/c XX4321 is credited with Rs.45,000.00 on 01-10-26 by NEFT from ACME TECHNOLOGIES PVT LTD SALARY. -SBI", 45000.0),
]

SKIPS = [
    ("AD-HDFCBK", "OTP is 482913 for txn of INR 2,000.00 at AMAZON on HDFC Bank card ending 1234. Valid till 14:35. Do not share OTP for security reasons."),
    ("VM-ICICIB", "Rs 799 will be debited from your account on 15-Oct-26 for your Netflix e-mandate. ICICI Bank"),
    ("JD-PAYTMB", "Rahul has requested money of Rs 200.00 from you on Paytm. Pay now: https://p.paytm.me/xyz"),
    ("AD-HDFCBK", "Your credit card bill of Rs 12,450 is due on 20-10-26. Minimum amount due Rs 620."),
    ("VK-AIRTEL", "Recharge with Rs 299 and get 2GB/day! Offer valid till Sunday. Win exciting prizes."),
    ("+919876543210", "Bhai sent you 500 on gpay check"),
    ("AD-HDFCBK", "UPI txn of Rs 200.00 to SWIGGY failed. Amount if debited will be reversed in 48 hrs."),
]


class SmsTests(unittest.TestCase):
    def test_debits(self):
        for sender, body, amount, merchant, ref in DEBITS:
            with self.subTest(body=body[:40]):
                t = finance.parse_sms(sender, body, T)
                self.assertIsNotNone(t, body)
                self.assertEqual(t["direction"], "debit")
                self.assertEqual(t["amount"], amount)
                if merchant:
                    self.assertIn(merchant.lower(), t["merchant"].lower())
                if ref:
                    self.assertEqual(t["ref"], ref)
                self.assertEqual(t["date"], "2026-10-12")

    def test_credits(self):
        for sender, body, amount in CREDITS:
            with self.subTest(body=body[:40]):
                t = finance.parse_sms(sender, body, T)
                self.assertIsNotNone(t, body)
                self.assertEqual(t["direction"], "credit")
                self.assertEqual(t["amount"], amount)

    def test_skips(self):
        for sender, body in SKIPS:
            with self.subTest(body=body[:40]):
                self.assertIsNone(finance.parse_sms(sender, body, T))

    def test_bank_name(self):
        self.assertEqual(finance.bank_from_sender("AD-HDFCBK"), "HDFC")
        self.assertEqual(finance.bank_from_sender("VM-SBIUPI"), "SBI")


class CategoryTests(unittest.TestCase):
    def test_defaults(self):
        c = lambda m, d="debit": finance.categorize({"merchant": m, "description": "", "direction": d}, {})  # noqa: E731
        self.assertEqual(c("Swiggy"), "Food & Dining")
        self.assertEqual(c("Blinkit"), "Groceries")
        self.assertEqual(c("Uber"), "Transport")
        self.assertEqual(c("Amazon Pay"), "Shopping")
        self.assertEqual(c("NETFLIX"), "Entertainment")
        self.assertEqual(c("ACME SALARY", "credit"), "Salary")

    def test_rules_win(self):
        finance.save_rule("chai point", "Food & Dining")
        self.assertEqual(finance.categorize({"merchant": "Chai Point", "description": "", "direction": "debit"}), "Food & Dining")


class StatementTests(unittest.TestCase):
    def test_phonepe_text(self):
        text = """Transaction Statement for 98XXXXXX10
Date Transaction Details Type Amount
Oct 01, 2026 Paid to Swiggy DEBIT ₹250
09:15 am Transaction ID T2610010915123456
UTR No. 427412345678
Paid by XXXXXXXX1234
Oct 02, 2026 Received from Rahul Kumar CREDIT ₹1,000
06:40 pm Transaction ID T2610021840654321
Oct 03, 2026 Paid to BESCOM DEBIT ₹1,320.50
"""
        tx = finance.parse_text_statement(text, "PhonePe_Statement.pdf")
        self.assertEqual(len(tx), 3)
        self.assertEqual(tx[0]["merchant"], "Swiggy")
        self.assertEqual(tx[0]["amount"], 250.0)
        self.assertEqual(tx[0]["ref"], "T2610010915123456")
        self.assertEqual(tx[1]["direction"], "credit")
        self.assertEqual(tx[2]["amount"], 1320.5)
        self.assertEqual(tx[2]["date"], "2026-10-03")

    def test_bank_csv(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "hdfc.csv")
        with open(p, "w", encoding="utf-8") as f:
            f.write("HDFC BANK Ltd. Statement of account\n\n")
            f.write("Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n")
            f.write("01/10/26,UPI-SWIGGY-swiggy@icici-ICIC0DC0099-628512345678-Payment,0000628512345678,01/10/26,350.00,,10650.00\n")
            f.write("02/10/26,NEFT CR-ACME TECH SALARY,N123456,02/10/26,,45000.00,55650.00\n")
            f.write('03/10/26,POS 416021XXXXXX1234 DMART AVENUE,0000,03/10/26,"1,240.75",,54409.25\n')
        tx = finance.parse_statement_file(p)
        self.assertEqual(len(tx), 3)
        self.assertEqual(tx[0]["amount"], 350.0)
        self.assertEqual(tx[1]["direction"], "credit")
        self.assertEqual(tx[2]["amount"], 1240.75)
        self.assertEqual(tx[0]["date"], "2026-10-01")

    def test_dedupe_key(self):
        a = {"date": "2026-10-01", "amount": 250, "direction": "debit", "merchant": "Swiggy", "ref": ""}
        self.assertEqual(finance.tx_key(a), finance.tx_key(dict(a)))
        self.assertTrue(finance.tx_key({**a, "ref": "628512345678"}).startswith("ref:"))


class WorkbookTests(unittest.TestCase):
    def test_expense_add_and_summary(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("office_server", os.path.join(ROOT, "servers", "office", "server.py"))
        srv = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(srv)
        wbpath = os.path.join(tempfile.mkdtemp(), "Expenses.xlsx")
        tx = [finance.parse_sms(s, b, T) for s, b, *_ in DEBITS] + [finance.parse_sms(s, b, T) for s, b, _ in CREDITS]
        r1 = json.loads(srv.expense_add(tx, wbpath))
        self.assertEqual(r1["added"], len(tx))
        r2 = json.loads(srv.expense_add(tx, wbpath))
        self.assertEqual(r2["added"], 0)
        self.assertEqual(r2["duplicates_skipped"], len(tx))
        s = json.loads(srv.expense_summary("2026-10", wbpath))
        self.assertAlmostEqual(s["total_spent"], sum(a for _, _, a, *_ in DEBITS), places=2)
        import openpyxl

        wb = openpyxl.load_workbook(wbpath)
        self.assertIn("Summary", wb.sheetnames)
        self.assertTrue(str(wb["Summary"]["B2"].value).startswith("=SUMIFS("))


if __name__ == "__main__":
    unittest.main()
