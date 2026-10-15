# Onyx on your phone

There are three ways Onyx works with an Android phone. Use any of them, or all three.

| What | How it connects | Gives you |
|---|---|---|
| **Phone control** | adb over USB or Wi-Fi | Onyx can see your phone's screen, tap, type, open apps, read SMS and notifications |
| **Phone web app** | your home Wi-Fi | Chat with Onyx from your phone, approve its actions, get its notifications |
| **SMS forwarder** | your home Wi-Fi | Bank SMS reach Onyx even without adb, so the expense sheet stays up to date |

iPhones can use the web app. Apple does not allow phone control or reading SMS.

---

## 1. Phone control (adb)

adb is Google's free, open-source Android Debug Bridge. `npm run setup` can download it for you.

**Turn on developer mode once:** Settings → About phone → tap **Build number** 7 times.

### Over USB (simplest)
1. Settings → Developer options → turn on **USB debugging**.
2. Plug the phone into the PC. On the phone, tap **Allow** (tick "Always allow from this computer").
3. Ask Onyx: *"Is my phone connected?"*

### Over Wi-Fi (Android 11+, no cable)
1. Phone and PC on the same Wi-Fi.
2. Settings → Developer options → **Wireless debugging** → turn it on.
3. Tap **Pair device with pairing code**. Tell Onyx:
   *"Connect my phone: pair 192.168.1.23:37000 code 482913, connect 192.168.1.23:41235"*
   (the pairing address and code from the pairing popup, and the IP:port shown on the Wireless debugging screen).
4. Later, only the connect step is needed. Phones change the port when Wi-Fi debugging restarts.

### Try it
- *"Open WhatsApp on my phone and tell me who messaged last"*
- *"What's my phone battery?"*
- *"Read my latest bank SMS and log them as expenses"*

Onyx never sends a message or places a call on its own: `send_sms` and `dial` open the
composer or the dialer with everything filled in, and you press send or call.

### Expenses from SMS, automatically
While the phone is connected by adb, Onyx reads new bank SMS every 15 minutes
(`phone.smsSyncMinutes` in settings) and adds them to `Documents\Onyx\Expenses.xlsx`.
The first sync goes back 30 days. OTPs, offers, payment requests and failed payments are skipped.

Some phones (often Android 12+ on Xiaomi/Samsung) block adb from reading SMS. Onyx will
say so; use the SMS forwarder below instead.

---

## 2. Phone web app

1. In `%USERPROFILE%\.onyx\config.json` set `"lan": { "enabled": true }`, then restart Onyx
   (tray icon → Quit Onyx, then `npm start`).
2. Windows asks whether to let Node.js through the firewall: allow **Private networks** only.
3. In the Onyx window press **Phone** and scan the QR code with your phone camera.
4. In your phone browser: menu → **Add to Home screen**.

The QR code contains your private access key. Anyone with it, on your Wi-Fi, can use
Onyx. If it leaks, delete `%USERPROFILE%\.onyx\token` and restart Onyx to make a new one.

---

## 3. SMS forwarder (no adb needed)

Uses [Termux](https://f-droid.org/packages/com.termux/) and
[Termux:API](https://f-droid.org/packages/com.termux.api/), both free and open source.
Install both from **F-Droid** (the Play Store versions are outdated).

1. Turn on the phone web app first (step 2 above) so Onyx listens on Wi-Fi.
2. In Termux:
   ```
   pkg install termux-api jq curl
   termux-sms-list -l 1
   ```
   The second command asks for SMS permission: allow it.
3. Copy `phone/onyx-sms-forward.sh` to the phone (or paste it into `nano onyx-sms-forward.sh`).
4. Run it with your PC's address and token (the token is the part after `#t=` in the pairing link):
   ```
   ONYX_URL=http://192.168.1.20:8766 ONYX_TOKEN=yourtoken bash onyx-sms-forward.sh
   ```
5. To keep it running, use Termux's notification "Acquire wakelock", or start it with
   Termux:Boot.

Any other SMS forwarder app works too: point its webhook at
`http://<pc-ip>:8766/ingest/sms` with the header `Authorization: Bearer <token>` and a JSON body of
`{"from": "...", "body": "...", "date_ms": 1760000000000}` (or a list of those).
