Group calls hosted on your own device. Run the app and it opens its page in your browser: "Start call" (you get a link for your friends) or "Join a call" by a link. Your friends don't need to install anything: they join from the browser by the link.

## Which file to download

| System | File |
|---|---|
| Windows | `p2p-call-windows-x64.exe` |
| Mac with M1/M2/M3/M4 | `p2p-call-mac-apple-silicon.zip` |
| Mac with Intel | `p2p-call-mac-intel.zip` |
| Android (8 or newer) | `p2p-call-android.apk` |
| Linux | `p2p-call-linux-x64.tar.gz` (`-arm64` for ARM) |

## First launch

The app isn't signed, so the system will warn you the first time you run it.

- **Windows:** "Windows protected your PC" → "More info" → "Run anyway".
- **Mac:** unzip, right-click `p2p-call` → "Open" → "Open". If there's no such button: "System Settings" → "Privacy & Security" → "Open Anyway".
- **Android:** open the downloaded APK; the phone will ask for permission to install apps from this source (the browser or "Files"), so allow it. Play Protect may warn about an unknown app: tap "Install anyway".
- **Linux:** `tar -xzf p2p-call-linux-x64.tar.gz && ./p2p-call`

The call runs as long as the app is running. To finish, press "End call for everyone" on the page, or quit the app.
