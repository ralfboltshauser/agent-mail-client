# Android push from a self-hosted Engine

Research for [#6](https://github.com/ralfboltshauser/agent-mail-client/issues/6). Sources checked 2026-11-13, with Android 17 (API 37) as the current platform.

## Recommendation

**The Engine speaks Web Push (RFC 8030 + RFC 8291 encryption + VAPID), and the Android app receives through UnifiedPush. For v1 the distributor is ntfy, self-hosted on the Host.** The AMC app posts its own notification with Archive / Reply actions.

- **Ralf's daily driver:** ntfy server on `ralfs-ubuntu`, and the ntfy Android app subscribed to it with *instant delivery* on (a `specialUse` foreground service plus a battery-optimisation exemption). This is the same mechanism FairEmail, Thunderbird and ntfy already ship to millions of devices. No Google is involved, and the payload is end-to-end encrypted.
- **Other self-hosters:** the same Engine code works with any UnifiedPush distributor (ntfy, Sunup, NextPush). Because the Engine signs with VAPID, it can also deliver **through Google FCM using UnifiedPush's embedded FCM distributor, with no AMC-operated gateway and no Firebase server key on the Engine**. That last path is the one that needs a spike to confirm (see risks).
- **Don't build our own always-on socket in the AMC app** for v1. It's the same FGS + exemption approach as ntfy, but we would own the reconnect, keepalive and OEM-killer bugs that ntfy has already fixed. Keep it as a fallback only if UnifiedPush turns out to be too awkward.
- **Don't build on plain FCM** (our own Firebase project and server key). Every self-hoster would need the AMC project's private service-account key, an AMC-run relay (a hosted service, which is out of scope), or their own APK build.
- **Bootstrap bonus:** before the Android app exists, the Engine can publish Interrupts straight to an ntfy topic. ntfy notifications support up to 3 `http` action buttons, so "Archive" can call the Engine API from the shade on day one.

## Comparison

| | **FCM (own Firebase project)** | **UnifiedPush + self-hosted ntfy** (recommended) | **AMC app's own persistent connection** |
|---|---|---|---|
| Latency when awake | Immediate | Immediate (open WebSocket/HTTP stream) | Immediate |
| Latency in Doze | High-priority / `RemoteNotification`: delivered "without delay", bypassing Doze [1][2] | Immediate *if* the distributor has the battery-optimisation exemption; otherwise "significant delay" [3][4] | Same as ntfy: needs FGS + exemption [4] |
| Battery | Best: one shared Google connection for all apps [4] | One extra TCP connection with keepalive, shared by every UnifiedPush app on the phone | One extra connection for AMC alone |
| App killed / swiped | FCM still delivers (GMS wakes the app) | ntfy is a separate app, so AMC being killed doesn't matter. ntfy itself must survive (FGS) | Push stops when the app is killed (same as Thunderbird [7]) |
| Persistent "service" notification | No | Yes (ntfy's FGS; the channel can be silenced) [3] | Yes |
| Google dependency | Yes (Play Services, Firebase) | None | None |
| OSS self-hoster story | Broken: the sender needs the app's Firebase credentials. ntfy: Firebase "only works if you modify and build your own .apk" [5] | Works: any distributor; FCM fallback via embedded distributor + VAPID, no gateway [8][9] | Works, but every user runs a battery-hungry FGS |
| Notification actions (archive / reply) | Yes, if data message / app-rendered | Yes: AMC renders the notification, so it has full `addAction` + `RemoteInput` [10] | Yes |
| Network path | Engine → Google (outbound only); phone needs no tailnet for the *push* | Phone must reach ntfy (Tailscale or a public URL) | Phone must reach Engine (Tailscale) |
| Play policy | Fine | ntfy handles its own FGS declaration | `specialUse` FGS + exemption need Play justification [6][4] |
| Payload privacy | Must encrypt ourselves | RFC 8291 encryption, built in [8] | TLS / Tailscale |

## Details

### Android platform constraints (Android 15–17)

- **Doze** suspends network access, ignores wake locks, and defers jobs, WorkManager and normal alarms to maintenance windows that get rarer over time [4]. A plain background socket is not enough.
- **Escape hatches** [4]:
  - FCM high-priority / `RemoteNotification` messages wake the app with temporary network access.
  - Apps on the battery-optimisation allowlist "can use the network and hold partial wake locks during Doze".
  - Google Play only accepts the direct `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` prompt when the app can't use FCM. A messaging app that *could* use FCM is "Not Acceptable"; one that can't, "because of technical dependency on another messaging service", is "Acceptable" [4].
- **FCM is changing:** Android's Doze page now says FCM "v1 … is deprecated" in favour of `AndroidConfigV2` with `RemoteNotification` / `BackgroundSync` types [4]. The Firebase v2 page still calls AndroidConfigV2 a "preview" with no GA date [2]. High-priority messages that don't produce a visible notification get deprioritised, judged over a 7-day window [1].
- **Foreground service types** (required since Android 14) [6]:
  - `dataSync` is capped at 6 h per 24 h and can't start from `BOOT_COMPLETED` when targeting Android 15 [11].
  - `shortService` is about 3 minutes.
  - `remoteMessaging` is described as device-to-device message continuity.
  - That leaves **`specialUse`**, with a free-text justification Play reviews [6]. FairEmail and ntfy both use it, and FairEmail's manifest says exactly why: "no Firebase Cloud Messaging integration … Other foreground service types do not fit … time limits or auto-starting on boot is not allowed" [12]. Thunderbird declares `dataSync|specialUse` [13].
- **Android 16** puts jobs running alongside an FGS under the job runtime quota [14]. That's irrelevant if the connection lives in the FGS itself rather than in jobs.
- **Android 17** has no new FGS or Doze rule that hits this design [15]. One new rule to watch: apps targeting API 37 need `ACCESS_LOCAL_NETWORK` for LAN addresses [16]. Tailscale's 100.64.0.0/10 addresses travel over the VPN interface. The docs don't say whether those count as "local network", so test it (see risks).
- **Notifications:**
  - `POST_NOTIFICATIONS` is a runtime permission since Android 13.
  - Up to 3 action buttons, handled by a `BroadcastReceiver` without opening the app.
  - Inline reply via `RemoteInput`.
  - `setCategory(CATEGORY_MESSAGE)` / `addPerson()` let mail from important senders get through DND [10].

### What existing mail clients do

- **FairEmail:** IMAP IDLE in a `specialUse` foreground service, asks to disable battery optimisation, needs `SCHEDULE_EXACT_ALARM`, and has no FCM. FAQ #2: the service "is needed to prevent Android from stopping the service when the device is sleeping"; the "Monitoring" channel can be silenced [12][17].
- **Thunderbird for Android (formerly K-9):** "Push" means IMAP IDLE per folder, also without FCM. It's off by default and limited to a configurable number of folders. It needs the "Alarms & reminders" permission on Android 13+ and shows a persistent "Waiting for new emails" notification. Swiping the app away stops push [7][13]. The team declined UnifiedPush because it would need a proxy with mailbox access that they won't run [18].
- **The lesson for AMC:** every OSS mail client that can't put a server between IMAP and the phone has to hold connections on the phone. **AMC has a server.** The Engine does IMAP IDLE / Gmail watch on the Host, where battery doesn't matter, and the phone holds at most one idle connection that only fires on Interrupts. That's strictly better than FairEmail and Thunderbird.

### UnifiedPush + ntfy specifics

- **Architecture:** app server (Engine) → push server (ntfy) → distributor app (ntfy on Android) → AMC app via the connector library. Messages are RFC 8291 encrypted (`aes128gcm`) and VAPID is supported. Servers should reject endpoints on non-global IPs and offer an allow-list for private push servers [8]. The Engine needs that allow-list for a tailnet ntfy.
- **ntfy Android:** instant delivery runs as a foreground service with a permanent notification. On a self-hosted server it "won't use Firebase"; the F-Droid build always uses instant delivery [3]. The manifest declares `specialUse` FGS, `SCHEDULE_EXACT_ALARM` (WebSocket retry) and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` [19].
- **ntfy server:**
  - UnifiedPush app servers need anonymous write to `up*` topics (`ntfy access '*' 'up*' write-only` on a `deny-all` server).
  - Set `behind-proxy` behind a reverse proxy.
  - `upstream-base-url` exists for iOS only [5].
  - Publishing supports priorities 1–5 and up to 3 actions (`view`, `broadcast`, `http`, `copy`) [20].
- **Distributors** [21]: ntfy, Sunup (Mozilla autopush, self-hostable), NextPush (Nextcloud), Conversations (XMPP), gCompat-UP (Google).
- **FCM without a gateway:** the embedded FCM distributor is a fallback when no distributor is installed but Play Services is. Quotes:
  - "Google FCM servers can handle webpush requests out of the box, but they require a VAPID authorization."
  - "If your application supports VAPID, you have nothing special to do" [9].
  - The UnifiedPush team: with WebPush + VAPID "you can get rid of push gateways" (unlike Element's Sygnal or Mastodon's relay) [22].

### Proposed v1 shape

1. The Engine's notifier sends a Web Push (VAPID-signed, RFC 8291 encrypted) per Interrupt. The payload carries the Interrupt reason, sender, subject and message id, so no fetch is needed to render (Android's own advice [4]).
2. The AMC Android app registers through the UnifiedPush connector and gives its endpoint to the Engine. It renders a `MessagingStyle` / `CATEGORY_MESSAGE` notification with Archive, Snooze and Reply (`RemoteInput`) actions. A `BroadcastReceiver` calls the Engine API over Tailscale.
3. Ralf runs ntfy on the Host (one Docker container next to the Engine) and the ntfy app with instant delivery and the battery exemption.
4. The Engine records a delivery ack (the app calls back on receipt). Missing acks surface on the desktop, so a silent push failure is visible.

## Open risks

1. **Tailscale is in the critical path.** If the phone's Tailscale VPN is off or stalled, ntfy can't connect and pushes queue silently. Mitigations:
   - Set Tailscale as Android "Always-on VPN".
   - Or expose only ntfy via a public URL / Tailscale Funnel. The payload is encrypted and topics are random, so that's acceptable.
   - Monitor the Engine's delivery-ack alarm.

   Tailscale documents mobile battery drain as a known issue [23].
2. **Embedded FCM via VAPID (no gateway) is less documented by Google** [22], and the FCM side is in flux (v1 deprecated per Android, v2 still preview [2][4]). Spike it before promising it to OSS users. It isn't on Ralf's path.
3. **OEM battery killers** (Samsung, Xiaomi and others) can kill FGS apps despite the exemption. This depends on Ralf's phone model, which is unknown here, so test it.
4. **`ACCESS_LOCAL_NETWORK` on targetSdk 37:** check whether connections to 100.x tailnet IPs count as local-network traffic [16]. If they do, the app needs the runtime permission for Archive/Reply calls (ntfy is a separate app with its own target SDK).
5. **The Play Store** may push back on a `specialUse` FGS in our own app. With ntfy as the distributor, AMC itself needs no FGS. Sideload / F-Droid makes this moot for Ralf.
6. **Latency numbers aren't measured.** None of the primary sources give figures. Measure p50/p99 Interrupt-to-buzz with `adb shell dumpsys deviceidle force-idle` [4] during the spike.

## Citations

1. FCM message priority: https://firebase.google.com/docs/cloud-messaging/android/message-priority
2. FCM AndroidConfigV2 (preview): https://firebase.google.com/docs/cloud-messaging/send/v2-api
3. ntfy, subscribe from phone: https://docs.ntfy.sh/subscribe/phone/
4. Android, Doze and App Standby: https://developer.android.com/training/monitoring-device-state/doze-standby
5. ntfy server config: https://docs.ntfy.sh/config/
6. Android FGS types: https://developer.android.com/develop/background-work/services/fgs/service-types
7. Thunderbird for Android, configure push email: https://support.mozilla.org/en-US/kb/configure-push-email-thunderbird-android
8. UnifiedPush developer intro: https://unifiedpush.org/developers/intro/
9. UnifiedPush embedded FCM distributor: https://unifiedpush.org/kdoc/embedded_fcm_distributor/
10. Android, create a notification (actions, direct reply, DND): https://developer.android.com/develop/ui/views/notifications/build-notification
11. Android 15 behavior changes (dataSync timeout, BOOT_COMPLETED): https://developer.android.com/about/versions/15/behavior-changes-15
12. FairEmail AndroidManifest (`specialUse` justification): https://github.com/M66B/FairEmail/blob/master/app/src/main/AndroidManifest.xml
13. Thunderbird for Android manifest: https://github.com/thunderbird/thunderbird-android/blob/main/legacy/common/src/main/AndroidManifest.xml
14. Android 16 behavior changes (job quotas): https://developer.android.com/about/versions/16/behavior-changes-all
15. Android 17 behavior changes: https://developer.android.com/about/versions/17/behavior-changes-all and https://developer.android.com/about/versions/17/behavior-changes-17
16. Android local network permission: https://developer.android.com/privacy-and-security/local-network-permission
17. FairEmail FAQ: https://github.com/M66B/FairEmail/blob/master/FAQ.md
18. Thunderbird team on UnifiedPush (Mozilla Connect): https://connect.mozilla.org/t5/ideas/thunderbird-for-android-should-support-unifiedpush/idi-p/130676
19. ntfy-android manifest: https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/AndroidManifest.xml
20. ntfy publishing (priorities, actions): https://docs.ntfy.sh/publish/
21. UnifiedPush distributors: https://unifiedpush.org/users/distributors/
22. UnifiedPush, "Push for decentralized services" (2025-01-31): https://unifiedpush.org/news/20250131_push_for_decentralized/
23. Tailscale, mobile battery drain: https://tailscale.com/docs/reference/troubleshooting/mobile/battery-drains
