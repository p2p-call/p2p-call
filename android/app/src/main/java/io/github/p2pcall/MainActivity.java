package io.github.p2pcall;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import mobile.Mobile;

/**
 * Two screens. The start screen: begin a call of your own, or enter somebody
 * else's by its link. The call screen: the call page in a WebView — for your
 * own call it comes from the call server inside this app (the Go code in
 * ../mobile), for somebody else's from their link. CallService keeps the call
 * alive while the app is in the background.
 */
public class MainActivity extends Activity {
    /**
     * Call links look like this: a link to the call's page on the site.
     * Nothing else is shown here, and nothing else gets the microphone — a
     * tunnel's own address least of all: anybody can have one of those and
     * put a page of their own behind it.
     */
    // Where the site is comes from call/web/site.json, through the build
    // (see build.gradle): the same file the program and the pages read.
    private static final String SITE = BuildConfig.SITE_HOST;
    private static final String SITE_PATH = BuildConfig.SITE_PATH;       // "/p2p-call/"
    private static final String SITE_URL = "https://" + SITE + SITE_PATH;
    /** name.secret — a call hosted by a program or the app; name~secret — one with no server. */
    private static final Pattern CALL_LINK = Pattern.compile(
            Pattern.quote(SITE_URL.substring(0, SITE_URL.length() - 1))
                    + "/?#[A-Za-z0-9_-]{22}(\\.[A-Za-z0-9_-]{22}|~[A-Za-z0-9_-]{22}(~[a-z0-9]{1,12})?)",
            Pattern.CASE_INSENSITIVE);
    /**
     * A link straight to somebody's tunnel: https://address/#r=name&k=secret.
     * The tunnel's own page is not shown here (anybody can have an address
     * like that and put a page of their own behind it): the app opens the
     * call with its own copy of the call page instead, which talks to the
     * address sealed, and only to the program that holds the call's key.
     */
    private static final Pattern DIRECT_LINK = Pattern.compile(
            "(https://[a-z0-9.-]+(:\\d+)?)/?#r=([A-Za-z0-9_-]{22})&k=([A-Za-z0-9_-]{22})",
            Pattern.CASE_INSENSITIVE);

    /** The call server is started and stopped strictly in the order asked. */
    private static final ExecutorService SERVER = Executors.newSingleThreadExecutor();

    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    private WebView web;
    private View home;
    private TextView message;
    private EditText link;
    private TextView update;
    private TextView create;

    private boolean inCall;
    private int run;              // counts calls begun, so a cancelled start's late answer is told apart
    private boolean ownCall;      // the call is ours: its page comes from localhost
    private String pendingLink;   // what to do once the microphone is allowed: null — own call
    private boolean pending;
    private String kind = "permanent";   // the own call being begun: permanent, once (a link that dies with it) or direct (straight to the tunnel)
    private PowerManager.WakeLock nearEar;
    private ValueCallback<Uri[]> filePick; // the page is waiting for a song to be chosen
    private PermissionRequest cameraAsk;   // the page is waiting for the camera to be allowed
    private boolean pictures;     // the call page is showing somebody's camera or screen
    private boolean cameraOn;     // our own camera is on
    private boolean errand;       // the app itself has sent the person elsewhere for a moment

    // A song shared to the app from a music player: kept as a copy until the
    // call page has taken it.
    private boolean pageJoined;   // the page is in the call and can take a song
    private String songName;      // null — nothing waiting
    private String songType;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = new WeakReference<>(this);

        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        // A WebView that goes off screen tells its page it is hidden, and the
        // page's sound and microphone are put on hold. A call has to go on
        // with the app in the background, so this one always says "visible".
        web = new WebView(this) {
            { setBackgroundColor(BG); }
            @Override
            protected void onWindowVisibilityChanged(int visibility) {
                super.onWindowVisibilityChanged(View.VISIBLE);
            }
        };
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        home = buildHome();
        root.addView(home, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (mayShow(u)) return false;
                // Anything that isn't the call page belongs in a real browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            /** The call page fetches the shared song from here (window.appSong in app.js). */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse own = sitePage(request);
                if (own != null) return own;
                if (!"/__app_song".equals(request.getUrl().getPath())) return null;
                try {
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-store");
                    WebResourceResponse r = new WebResourceResponse(
                            songType == null ? "audio/mpeg" : songType, null, new FileInputStream(songFile()));
                    r.setResponseHeaders(headers);
                    return r;
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && inCall) {
                    leave("Couldn't open the call. It may have ended, or you're offline.");
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /** "Play music" on the call page: let the person choose a song. */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePick != null) filePick.onReceiveValue(null);
                filePick = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("audio/*");
                try {
                    startActivityForResult(pick, 2);
                } catch (Exception e) {
                    filePick = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    Uri origin = request.getOrigin();
                    String host = origin == null ? null : origin.getHost();
                    // Somebody else's call: its page comes from the link's site.
                    boolean callPage = ownCall ? "localhost".equals(host) : SITE.equals(host);
                    if (!inCall || !callPage) {
                        request.deny();
                        return;
                    }
                    boolean camera = false;
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) camera = true;
                    }
                    if (camera && !hasCamera()) {
                        // The phone's own question first; the page waits for the answer.
                        if (cameraAsk != null) cameraAsk.deny();
                        cameraAsk = request;
                        errand = true;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, 3);
                        return;
                    }
                    answer(request);
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (cameraAsk == request) cameraAsk = null;
                });
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidApp");

        openFrom(getIntent());
        checkForUpdate();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFrom(intent);
    }

    /** "Open the call in the app" on the call page arrives here as p2pcall://address/. */
    private void openFrom(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri song = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (song != null) takeSong(song);
            return;
        }
        Uri u = intent == null ? null : intent.getData();
        if (u == null || u.getHost() == null) return;
        String target;
        if ("https".equals(u.getScheme()) && SITE.equals(u.getHost())) {
            target = u.toString();                                  // a permanent link, tapped somewhere
        } else if ("p2pcall".equals(u.getScheme()) && "room".equals(u.getHost()) && u.getLastPathSegment() != null) {
            target = SITE_URL + "#" + u.getLastPathSegment();   // "open in the app" on the link's page
        } else if ("p2pcall".equals(u.getScheme()) && "direct".equals(u.getHost()) && u.getPath() != null) {
            target = u.getPath().substring(1);                      // "open in the app" on a tunnel's page
            if (!DIRECT_LINK.matcher(target).find()) return;
        } else {
            return;
        }
        if (inCall) {
            toast("Leave this call first.");
            return;
        }
        link.setText(target);
        join();
    }

    // ---------------------------------------------------------------- the site's pages, from the app itself

    /**
     * The site's pages — the permanent link's page and the call page (docs/
     * of the repository) — are packed into the app (see build.gradle) and
     * shown from here, under the site's own address. So a guest in the app
     * needs neither GitHub to be reachable nor to trust what it serves, and
     * no tunnel can put another page in their place. Anything not packed
     * goes to the network as usual.
     */
    private WebResourceResponse sitePage(WebResourceRequest request) {
        Uri u = request.getUrl();
        String path = u.getPath();
        if (!"https".equals(u.getScheme()) || !SITE.equals(u.getHost()) || path == null
                || !path.startsWith(SITE_PATH) || !"GET".equals(request.getMethod())) return null;
        String file = path.substring(SITE_PATH.length());
        if (file.isEmpty() || file.endsWith("/")) file += "index.html";
        if (file.contains("..")) return null;
        String type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript"
                : file.endsWith(".css") ? "text/css" : file.endsWith(".json") ? "application/json"
                : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : null;
        if (type == null) return null;
        try {
            InputStream in = getAssets().open(file);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Referrer-Policy", "no-referrer");
            return new WebResourceResponse(type, "utf-8", 200, "OK", headers, in);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- updates

    private static final String LATEST = "https://api.github.com/repos/" + BuildConfig.REPO + "/releases/latest";
    private static final String LATEST_APK =
            "https://github.com/" + BuildConfig.REPO + "/releases/latest/download/p2p-call-android.apk";

    /**
     * Asks GitHub what the latest release is and, if it is newer than this
     * app, offers it on the start screen. The button only opens the download
     * in the browser: installing is the person's own tap, as Android demands.
     */
    private void checkForUpdate() {
        new Thread(() -> {
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(LATEST).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(10000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", "p2p-call-android");
                StringBuilder body = new StringBuilder();
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[8192];
                    for (int n; (n = in.read(buf)) > 0; ) body.append(new String(buf, 0, n, "UTF-8"));
                }
                String latest = new org.json.JSONObject(body.toString()).getString("tag_name");
                String mine = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                if (newer(latest, mine)) {
                    runOnUiThread(() -> {
                        newVersion = latest;
                        update.setText("Update available: " + latest + " — download");
                        update.setVisibility(View.VISIBLE);
                    });
                }
            } catch (Exception ignored) {
                // No internet, GitHub busy: not worth a word.
            }
        }).start();
    }

    /** Compares versions like "v0.2.0" and "0.1.0-test3" by their three numbers. */
    static boolean newer(String latest, String mine) {
        int[] a = numbers(latest), b = numbers(mine);
        for (int i = 0; i < 3; i++) {
            if (a[i] != b[i]) return a[i] > b[i];
        }
        // The same numbers: a finished release is newer than its trial builds.
        return mine.contains("-") && !latest.contains("-");
    }

    private static int[] numbers(String version) {
        int[] out = new int[3];
        Matcher m = Pattern.compile("(\\d+)\\.(\\d+)\\.(\\d+)").matcher(version == null ? "" : version);
        if (m.find()) {
            for (int i = 0; i < 3; i++) out[i] = Integer.parseInt(m.group(i + 1));
        }
        return out;
    }

    // ---------------------------------------------------------------- a shared song

    private File songFile() {
        return new File(getCacheDir(), "shared-song");
    }

    /** Copies the song while the other app still lets us read it, then offers it to the page. */
    private void takeSong(Uri uri) {
        new Thread(() -> {
            String name = "Song";
            try {
                try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
                } catch (Exception ignored) {
                    if (uri.getLastPathSegment() != null) name = uri.getLastPathSegment();
                }
                try (InputStream in = getContentResolver().openInputStream(uri);
                     OutputStream out = new FileOutputStream(songFile())) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
            } catch (Exception e) {
                runOnUiThread(() -> toast("Couldn't load this song."));
                return;
            }
            String type = getContentResolver().getType(uri);
            String title = name;
            runOnUiThread(() -> {
                songName = title;
                songType = type;
                if (inCall && pageJoined) {
                    giveSong();
                } else {
                    showWaitingSong();
                }
            });
        }).start();
    }

    private void showWaitingSong() {
        message.setTextColor(MUTED);
        message.setText("\"" + songName + "\" will play as soon as you start or join a call.\nTap here to cancel.");
    }

    private void giveSong() {
        if (songName == null) return;
        web.evaluateJavascript("window.appSong && window.appSong(" + org.json.JSONObject.quote(songName) + ")", null);
        songName = null;
    }

    private void toast(String text) {
        android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_LONG).show();
    }

    // ---------------------------------------------------------------- start screen

    // The same look as the call page (call/web/style.css).
    private static final int BG = 0xFF16161F, PANEL = 0xFF22222E, LINE = 0xFF33334A,
            TEXT = 0xFFECECF1, MUTED = 0xFF9A9AB0, GREEN = 0xFF1F8A5B, BLUE = 0xFF3B82F6, RED = 0xFFE5534B;

    private static final String CREATE = "Start call";

    // Which tunnel the calls created here go out by; "" — the app tries one
    // after the other. Kept beside the key (Mobile.setTunnel).
    private static final String[] TUNNELS = {"", "localhostrun", "serveo"};
    private static final String[] TUNNEL_NAMES = {
            "Auto: localhost.run, then serveo", "localhost.run only", "serveo.net only"};

    private int tunnelNow() {
        String now = "";
        try {
            now = Mobile.tunnel(getFilesDir().getAbsolutePath());
        } catch (Exception ignored) {
        }
        for (int i = 0; i < TUNNELS.length; i++) {
            if (TUNNELS[i].equals(now)) return i;
        }
        return 0;
    }

    private void showTunnel() {
        showHow();
    }

    /**
     * localhost.run shows no pages of its own but is slow: a friend opening
     * a link that leads straight to the tunnel waits some ten seconds.
     * serveo is fast, but shows such a friend its warning first.
     */
    private void askTunnel() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("Tunnel for my calls")
                .setSingleChoiceItems(TUNNEL_NAMES, tunnelNow(), (d, which) -> {
                    boolean ok = false;
                    String result;
                    try {
                        Mobile.setTunnel(getFilesDir().getAbsolutePath(), TUNNELS[which]);
                        ok = true;
                        result = which == 2
                                ? "Tunnel: serveo. It's fast, but with a direct link your friends will first see its warning page and need to tap \"Continue to Site\"."
                                : which == 1
                                ? "Tunnel: localhost.run. No extra pages, but slow: with a direct link the page takes about ten seconds to open for your friends."
                                : "The app will choose the tunnel.";
                    } catch (Exception e) {
                        result = "Couldn't save: " + e.getMessage();
                    }
                    message.setTextColor(ok ? MUTED : RED);
                    message.setText(result);
                    showTunnel();
                    d.dismiss();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    // How an own call is begun: remembered from one time to the next.
    private static final String[] MODES = {"permanent", "once", "direct", "bare"};
    private static final String[] MODE_NAMES = {
            "Permanent link", "One-time call", "Direct link", "No tunnel"};
    private static final String[] MODE_NOTES = {
            "The same link every time", "The link stops working after the call",
            "Tunnel only, no website or message boards", "Your phone hosts nothing: people find each other on their own"};
    private static final String[] TUNNEL_SHORT = {"auto", "localhost.run", "serveo"};
    private TextView how;         // the line under the button: how, and by which tunnel
    private String newVersion;    // a newer release to offer, if there is one

    private int modeNow() {
        String m = getSharedPreferences("p2pcall", MODE_PRIVATE).getString("mode", MODES[0]);
        for (int i = 0; i < MODES.length; i++) {
            if (MODES[i].equals(m)) return i;
        }
        return 0;
    }

    private void showHow() {
        int m = modeNow();
        String text = MODE_NAMES[m] + (m == 3 ? "" : " · tunnel " + TUNNEL_SHORT[tunnelNow()]) + " · ";
        android.text.SpannableString line = new android.text.SpannableString(text + "change");
        line.setSpan(new android.text.style.ForegroundColorSpan(BLUE), text.length(), line.length(), 0);
        how.setText(line);
    }

    private void askHow() {
        CharSequence[] items = new CharSequence[MODES.length];
        for (int i = 0; i < MODES.length; i++) {
            android.text.SpannableString item = new android.text.SpannableString(MODE_NAMES[i] + "\n" + MODE_NOTES[i]);
            item.setSpan(new android.text.style.RelativeSizeSpan(0.8f), MODE_NAMES[i].length(), item.length(), 0);
            item.setSpan(new android.text.style.ForegroundColorSpan(MUTED), MODE_NAMES[i].length(), item.length(), 0);
            items[i] = item;
        }
        new android.app.AlertDialog.Builder(this)
                .setTitle("How to start a call")
                .setSingleChoiceItems(items, modeNow(), (d, which) -> {
                    getSharedPreferences("p2pcall", MODE_PRIVATE).edit().putString("mode", MODES[which]).apply();
                    showHow();
                    d.dismiss();
                })
                .setNeutralButton("Tunnel…", (d, w) -> askTunnel())
                .setNegativeButton("Close", null)
                .show();
    }

    /** Somebody else's call: a place for its link. */
    private void askOther() {
        EditText box = new EditText(this);
        box.setHint("Call link");
        box.setSingleLine(true);
        box.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        // A link already copied is put in at once.
        String copied = clipboard();
        if (CALL_LINK.matcher(copied).find() || DIRECT_LINK.matcher(copied).find()) box.setText(copied);
        FrameLayout frame = new FrameLayout(this);
        frame.setPadding(dp(20), dp(8), dp(20), 0);
        frame.addView(box);
        android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
                .setTitle("Join a call")
                .setView(frame)
                .setNeutralButton("Paste", null)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Join", (d, w) -> {
                    link.setText(box.getText().toString().trim());
                    join();
                })
                .create();
        dialog.show();
        // "Paste" fills the box and leaves the window open.
        dialog.getButton(android.app.AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> box.setText(clipboard()));
    }

    private void askSettings() {
        List<String> items = new ArrayList<>();
        items.add("Preferred tunnel: " + TUNNEL_SHORT[tunnelNow()]);
        items.add("Change my link");
        if (newVersion != null) items.add("Download update " + newVersion);
        new android.app.AlertDialog.Builder(this)
                .setTitle("Settings")
                .setItems(items.toArray(new String[0]), (d, which) -> {
                    if (which == 0) askTunnel();
                    else if (which == 1) askNewLink();
                    else openUpdate();
                })
                .setNegativeButton("Close", null)
                .show();
    }

    /** "Change my link": everyone who has the old link is left behind, so it is asked twice. */
    private void askNewLink() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("Change your permanent link?")
                .setMessage("The old link will stop working for everyone who has it. Your next call will get a new one.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Change", (d, w) -> SERVER.execute(() -> {
                    String result;
                    try {
                        Mobile.resetLink(getFilesDir().getAbsolutePath());
                        result = "Done. Your next call will have a new link.";
                    } catch (Exception e) {
                        result = "Couldn't change the link: " + e.getMessage();
                    }
                    String shown = result;
                    runOnUiThread(() -> {
                        message.setTextColor(MUTED);
                        message.setText(shown);
                    });
                }))
                .show();
    }

    private void openUpdate() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(LATEST_APK)));
        } catch (Exception ignored) {
        }
    }

    /** One button to begin a call, how exactly under it, somebody else's call, and the settings. */
    private View buildHome() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(24), dp(72), dp(24), dp(20));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ic_call);
        logo.setBackground(shape(GREEN, 0, dp(44)));
        logo.setPadding(dp(22), dp(22), dp(22), dp(22));
        col.addView(logo, new LinearLayout.LayoutParams(dp(88), dp(88)));

        TextView title = text("Voice call", 26, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title, row(18));
        col.addView(text("Straight between friends, no third-party servers", 15, MUTED), row(4));

        message = text("", 15, RED);
        // A song shared to the app waits for a call; a tap calls it off.
        message.setOnClickListener(v -> {
            if (songName != null && !inCall) {
                songName = null;
                message.setText("");
            }
        });
        col.addView(message, row(16));

        // A newer release, when there is one: said here, where it can't be missed.
        update = button("", PANEL, GREEN, TEXT, 15);
        update.setVisibility(View.GONE);
        update.setOnClickListener(v -> openUpdate());
        col.addView(update, row(0));

        create = button(CREATE, BLUE, BLUE, 0xFFFFFFFF, 17);
        create.setPadding(dp(28), dp(13), dp(28), dp(13));
        // While the call is being started the same button calls it off.
        create.setOnClickListener(v -> {
            if (inCall) {
                leave(null);
                return;
            }
            int m = modeNow();
            if (m == 3) {
                // No tunnel and no server of ours: the call is made on the site's page.
                ask(SITE_URL + "#create");
            } else {
                kind = MODES[m];
                ask(null);
            }
        });
        col.addView(create, fit(16));

        how = text("", 14, MUTED);
        how.setPadding(dp(8), dp(10), dp(8), dp(10));
        how.setOnClickListener(v -> {
            if (!inCall) askHow();
        });
        col.addView(how, row(4));
        showHow();

        TextView other = button("Join a call", PANEL, LINE, TEXT, 16);
        other.setPadding(dp(22), dp(12), dp(22), dp(12));
        other.setOnClickListener(v -> {
            if (!inCall) askOther();
        });
        col.addView(other, fit(14));

        // Holds the link being entered; the window that asks for it is askOther.
        link = new EditText(this);

        // What is left of the screen pushes the last line to the bottom.
        View gap = new View(this);
        col.addView(gap, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        LinearLayout foot = new LinearLayout(this);
        foot.setOrientation(LinearLayout.HORIZONTAL);
        TextView settings = text("⚙ Settings", 14, MUTED);
        settings.setGravity(Gravity.START);
        settings.setPadding(dp(4), dp(12), dp(12), dp(12));
        settings.setOnClickListener(v -> {
            if (!inCall) askSettings();
        });
        foot.addView(settings, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        String version = "";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        TextView ver = text("Version " + version, 13, MUTED);
        ver.setGravity(Gravity.END);
        foot.addView(ver, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        col.addView(foot, row(12));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        scroll.addView(col);
        return scroll;
    }

    /** As wide as its words, in the middle. */
    private LinearLayout.LayoutParams fit(int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(top);
        p.gravity = Gravity.CENTER_HORIZONTAL;
        return p;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable shape(int fill, int stroke, int radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radius);
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private TextView text(String s, int size, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    /** A plain rounded button in the page's style; dims while pressed. */
    private TextView button(String s, int fill, int stroke, int color, int size) {
        TextView b = text(s, size, color);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(16), dp(13), dp(16), dp(13));
        b.setBackground(shape(fill, stroke, dp(12)));
        b.setClickable(true);
        b.setFocusable(true);
        b.setOnTouchListener((v, e) -> {
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) v.setAlpha(0.6f);
            else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) v.setAlpha(1f);
            return false;
        });
        return b;
    }

    private LinearLayout.LayoutParams row(int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(top);
        return p;
    }

    private String clipboard() {
        ClipData clip = getSystemService(ClipboardManager.class).getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "";
        CharSequence c = clip.getItemAt(0).coerceToText(this);
        return c == null ? "" : c.toString().trim();
    }

    private void join() {
        String text = link.getText().toString().trim();
        if (text.isEmpty()) {
            text = clipboard();
            link.setText(text);
        }
        // The link may come with words around it ("Join my call: https://…").
        Matcher d = DIRECT_LINK.matcher(text);
        if (d.find()) {
            // Somebody's tunnel: the call page is the app's own (see sitePage).
            ask(SITE_URL + "c1/#r=" + d.group(3) + "&k=" + d.group(4) + "&s=" + d.group(1).toLowerCase() + "&d=1");
            return;
        }
        Matcher m = CALL_LINK.matcher(text);
        if (!m.find()) {
            message.setTextColor(RED);
            message.setText(text.isEmpty()
                    ? "Copy the call link and tap \"Join\" again."
                    : "That doesn't look like a call link.");
            return;
        }
        ask(m.group());
    }

    // ---------------------------------------------------------------- starting a call

    private boolean hasCamera() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    /** Gives the call page what it asked for, as far as the phone has allowed it. */
    private void answer(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && hasMic()) ok.add(r);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && hasCamera()) ok.add(r);
        }
        if (ok.size() == request.getResources().length && !ok.isEmpty()) request.grant(ok.toArray(new String[0]));
        else request.deny();
    }

    private boolean hasMic() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Makes sure of the microphone, then begins: the call at url, or an own one if url is null. */
    private void ask(String url) {
        if (inCall) return;
        message.setText("");
        pendingLink = url;
        pending = true;

        List<String> need = new ArrayList<>();
        if (!hasMic()) need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (need.isEmpty()) {
            begin();
        } else {
            requestPermissions(need.toArray(new String[0]), 1);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 3) {
            PermissionRequest ask = cameraAsk;
            cameraAsk = null;
            if (ask != null) {
                if (inCall) answer(ask);
                else ask.deny();
            }
            return;
        }
        // Notifications are a nicety; the microphone is not.
        if (hasMic()) {
            begin();
        } else {
            pending = false;
            message.setText("Calls need the microphone. Tap again and allow it. If no prompt appears, allow it in the app settings.");
        }
    }

    private void begin() {
        if (!pending || inCall) return;
        pending = false;
        inCall = true;
        startForegroundService(new Intent(this, CallService.class));

        if (pendingLink != null) {
            run++;
            show(pendingLink);
            return;
        }
        message.setTextColor(MUTED);
        message.setText("Starting call…");
        create.setText("Cancel");
        int mine = ++run;
        String how = kind;
        SERVER.execute(() -> {
            try {
                String url = Mobile.startAs(getFilesDir().getAbsolutePath(), how);
                runOnUiThread(() -> {
                    if (inCall && run == mine) show(url);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (run == mine) leave("Couldn't start the call: " + e.getMessage());
                });
            }
        });
    }

    /** The call page and, on the way to somebody else's, the page of their permanent link. */
    private boolean mayShow(Uri u) {
        if (!inCall || u == null) return false;
        String host = u.getHost(), path = u.getPath();
        if (ownCall) return "http".equals(u.getScheme()) && "localhost".equals(host);
        return "https".equals(u.getScheme()) && SITE.equals(host) && path != null && path.startsWith(SITE_PATH);
    }

    private void show(String url) {
        ownCall = "localhost".equals(Uri.parse(url).getHost());
        home.setVisibility(View.GONE);
        create.setText(CREATE);
        web.loadUrl(url);
    }

    /** Back to the start screen; an own call ends with it. */
    private void leave(String why) {
        if (!inCall) return;
        inCall = false;
        pictures = false;
        cameraOn = false;
        if (cameraAsk != null) {
            cameraAsk.deny();
            cameraAsk = null;
        }
        // A shared song that the call never got to goes on waiting.
        if (pageJoined) songName = null;
        pageJoined = false;
        create.setText(CREATE);
        if (filePick != null) {
            filePick.onReceiveValue(null);
            filePick = null;
        }
        resetAudio();
        stopService(new Intent(this, CallService.class));
        web.loadUrl("about:blank");
        link.setText("");
        message.setTextColor(RED);
        message.setText(why == null ? "" : why);
        if (why == null && songName != null) showWaitingSong();
        home.setVisibility(View.VISIBLE);
    }

    /** Ends an own call, if one is running. Called when CallService goes away. */
    static void stopServer() {
        SERVER.execute(Mobile::stop);
    }

    /** Called when the call is ended from the notification. */
    static void close() {
        MainActivity a = current.get();
        if (a != null) a.runOnUiThread(a::finishAndRemoveTask);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 2 && filePick != null) {
            filePick.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            filePick = null;
        }
    }

    /**
     * In a call, Back leaves it running, like the Home button. On the way
     * into one — the call is starting, the link's page is waiting, the name
     * is being asked — it goes back to the start screen.
     */
    @Override
    public void onBackPressed() {
        if (inCall && !pageJoined) leave(null);
        else if (!small()) moveTaskToBack(true);
    }

    /** Home, or another app opened over this one. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Not when it is this app that has opened something for a moment:
        // the list of songs, "share the link", the phone's question about the camera.
        if (!errand) small();
    }

    @Override
    public void startActivityForResult(Intent intent, int request, Bundle options) {
        errand = true;
        super.startActivityForResult(intent, request, options);
    }

    @Override
    protected void onResume() {
        super.onResume();
        errand = false;
    }

    /**
     * With pictures in the call, leaving the app shrinks it to a small
     * window over the other apps instead of hiding it: the pictures stay in
     * view, and the phone lets the camera go on. Says whether it did.
     */
    private boolean small() {
        if (!inCall || !pageJoined || !(pictures || cameraOn)) return false;
        try {
            return enterPictureInPictureMode(new android.app.PictureInPictureParams.Builder()
                    .setAspectRatio(new android.util.Rational(3, 4))
                    .build());
        } catch (Exception e) {
            return false;   // the phone can't, or the person has forbidden it
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean in, android.content.res.Configuration config) {
        super.onPictureInPictureModeChanged(in, config);
        web.evaluateJavascript("window.appPip && window.appPip(" + in + ")", null);
    }

    @Override
    protected void onDestroy() {
        resetAudio();
        if (current.get() == this) current = new WeakReference<>(null);
        web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- sound

    /**
     * Loudspeaker, or the quiet way: headphones if there are any, else the
     * earpiece — and then the screen goes dark while the phone is at the ear.
     */
    private void setSpeaker(boolean loud) {
        if (!inCall) return;
        AudioManager am = getSystemService(AudioManager.class);
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= 31) {
            int[] wanted = loud
                    ? new int[]{AudioDeviceInfo.TYPE_BUILTIN_SPEAKER}
                    : new int[]{
                            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
                            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE};
            AudioDeviceInfo pick = null;
            for (int type : wanted) {
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (d.getType() == type) {
                        pick = d;
                        break;
                    }
                }
                if (pick != null) break;
            }
            if (pick != null) am.setCommunicationDevice(pick);
            else am.clearCommunicationDevice();
            holdNearEar(pick != null && pick.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
        } else {
            am.setSpeakerphoneOn(loud);
            holdNearEar(!loud && !am.isWiredHeadsetOn() && !am.isBluetoothScoOn());
        }
    }

    private void holdNearEar(boolean on) {
        if (nearEar == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
            nearEar = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "p2pcall:ear");
            nearEar.setReferenceCounted(false);
        }
        if (on) nearEar.acquire();
        else if (nearEar.isHeld()) nearEar.release();
    }

    /** Hands the phone's sound back the way it was. */
    private void resetAudio() {
        AudioManager am = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
        else am.setSpeakerphoneOn(false);
        am.setMode(AudioManager.MODE_NORMAL);
        holdNearEar(false);
    }

    // ---------------------------------------------------------------- the page's requests

    /** What the call page can ask the app to do (window.AndroidApp in app.js). */
    private class Bridge {
        @JavascriptInterface
        public void share(String url) {
            runOnUiThread(() -> {
                if (!inCall) return;
                Intent send = new Intent(Intent.ACTION_SEND)
                        .setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, "Join my call: " + url);
                startActivity(Intent.createChooser(send, "Send link"));
            });
        }

        /** The page says whether it is showing pictures and whether our own camera is among them. */
        @JavascriptInterface
        public void video(boolean any, boolean camera) {
            runOnUiThread(() -> {
                if (!inCall) return;
                pictures = any;
                if (camera == cameraOn) return;
                cameraOn = camera;
                // The call's notification is re-declared with or without the
                // camera; it can only be done while the app is on the screen.
                try {
                    startService(new Intent(MainActivity.this, CallService.class).putExtra(CallService.CAMERA, camera));
                } catch (Exception ignored) {
                }
            });
        }

        /** This app lets the call page on the link's site use the microphone (the ones before v0.1.9 didn't). */
        @JavascriptInterface
        public boolean canSitePage() {
            return true;
        }

        /** This app can give the page a camera (the ones before v0.1.4 couldn't). */
        @JavascriptInterface
        public boolean canVideo() {
            return true;
        }

        @JavascriptInterface
        public void setSpeaker(boolean loud) {
            runOnUiThread(() -> MainActivity.this.setSpeaker(loud));
        }

        /** The name the person goes by in calls: kept here, because the call page's own memory doesn't last. */
        @JavascriptInterface
        public String getName() {
            return getSharedPreferences("p2pcall", MODE_PRIVATE).getString("name", "");
        }

        @JavascriptInterface
        public void setName(String name) {
            if (name == null) return;
            name = name.trim();
            if (name.length() > 64) name = name.substring(0, 64);
            getSharedPreferences("p2pcall", MODE_PRIVATE).edit().putString("name", name).apply();
        }

        /** The page is in the call now and can take a song that was shared to the app. */
        @JavascriptInterface
        public void joined() {
            runOnUiThread(() -> {
                pageJoined = inCall;
                if (pageJoined) giveSong();
            });
        }

        /** The person left, was removed or wasn't let in; text says which. */
        @JavascriptInterface
        public void callEnded(String text) {
            runOnUiThread(() -> leave("You left the call.".equals(text) || "Call ended.".equals(text) ? null : text));
        }
    }
}
