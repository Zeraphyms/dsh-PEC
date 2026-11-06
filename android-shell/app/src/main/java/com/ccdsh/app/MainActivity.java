package com.ccdsh.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * cc-dsh: a thin, stable shell around the DSH phone gateway served by the
 * cc-dsh plugin on the PC. The real UI lives on the PC (so features never
 * drift), while this app owns pairing, trust, and Android integration.
 */
@SuppressLint("SetJavaScriptEnabled")
public class MainActivity extends Activity {
    private static final String PREFS = "ccdsh";
    private static final String KEY_URL = "baseUrl";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_NAME = "serverName";
    private static final int REQ_FILE = 4101;

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private ProgressBar progress;
    private TextView statusBar;
    private View errorView;
    private View setupView;
    private String baseUrl;
    private String token;
    private String serverName;
    private boolean setupMode;
    private boolean backPending;
    private ValueCallback<Uri[]> filePathCallback;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        baseUrl = trimUrl(prefs.getString(KEY_URL, ""));
        token = prefs.getString(KEY_TOKEN, "");
        serverName = prefs.getString(KEY_NAME, "cc-dsh");

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.dsh_bg));
        setContentView(root);

        if (baseUrl.isEmpty() || token.isEmpty()) showSetup();
        else showWeb();

        handleDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    // ---------------------------------------------------------------- deep links

    private void handleDeepLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri data = intent.getData();
        if (!"ccdsh".equals(data.getScheme())) return;
        String host = data.getHost();
        if (host != null && host.startsWith("pair")) {
            String url = data.getQueryParameter("url");
            String code = data.getQueryParameter("code");
            if (url != null) {
                showSetup();
                if (setupView instanceof LinearLayout) {
                    View v = setupView.findViewWithTag("url");
                    if (v instanceof EditText) ((EditText) v).setText(url);
                    v = setupView.findViewWithTag("code");
                    if (v instanceof EditText && code != null) ((EditText) v).setText(code);
                }
            }
        }
    }

    // ---------------------------------------------------------------- setup

    private void showSetup() {
        setupMode = true;
        root.removeAllViews();
        web = null;

        ScrollView scroll = new ScrollView(this);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        column.setPadding(pad, dp(38), pad, dp(28));
        scroll.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = text("cc-dsh", 30, R.color.dsh_text, true);
        column.addView(title);

        TextView subtitle = text("把手机接到电脑上的 DeepSeek Harness。\n在电脑 DSH 里启用 cc-dsh 插件后，输入它显示的 6 位配对码即可。", 14, R.color.dsh_text_secondary, false);
        subtitle.setPadding(0, dp(8), 0, dp(20));
        column.addView(subtitle);

        TextView discoverLabel = text("① 找到这台电脑", 13, R.color.dsh_text_tertiary, true);
        column.addView(discoverLabel);

        LinearLayout found = new LinearLayout(this);
        found.setOrientation(LinearLayout.VERTICAL);
        found.setTag("found");
        column.addView(found, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button scan = button("在同一 Wi-Fi 下自动查找", true);
        scan.setOnClickListener(v -> startDiscovery(found, scan));
        column.addView(scan, lp(pad, 10));

        TextView manualLabel = text("② 或者直接填写地址（异地用 Tailscale IP）", 13, R.color.dsh_text_tertiary, true);
        manualLabel.setPadding(0, dp(18), 0, dp(4));
        column.addView(manualLabel);

        EditText urlInput = input("http://192.168.1.100:7317", InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setTag("url");
        column.addView(urlInput, lp(0, 6));

        TextView codeLabel = text("③ 配对码（第一次配对可留空）", 13, R.color.dsh_text_tertiary, true);
        codeLabel.setPadding(0, dp(16), 0, dp(4));
        column.addView(codeLabel);

        EditText codeInput = input("123456", InputType.TYPE_CLASS_NUMBER);
        codeInput.setTag("code");
        codeInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        column.addView(codeInput, lp(0, 6));

        TextView message = text("", 13, R.color.dsh_danger, false);
        message.setTag("message");
        message.setPadding(0, dp(12), 0, 0);
        column.addView(message);

        Button connect = button("连接", false);
        connect.setOnClickListener(v -> {
            String url = trimUrl(urlInput.getText().toString());
            String code = codeInput.getText().toString().trim();
            message.setText("");
            if (url.isEmpty()) {
                message.setText("请填写电脑地址");
                return;
            }
            if (!code.isEmpty() && code.length() != 6) {
                message.setText("配对码是 6 位数字；第一次配对可以留空直接连接");
                return;
            }
            connect.setEnabled(false);
            connect.setText("连接中…");
            io.execute(() -> pair(url, code, connect, message));
        });
        column.addView(connect, lp(0, 18));

        TextView hint = text("第一次配对不用输码：只要手机和电脑在同一 Wi-Fi（或都连了 Tailscale），点“连接”就能进。以后再加手机才需要电脑上显示的 6 位码。", 12, R.color.dsh_text_tertiary, false);
        hint.setPadding(0, dp(14), 0, 0);
        column.addView(hint);

        root.addView(scroll);
        setupView = column;
    }

    private void startDiscovery(LinearLayout container, Button trigger) {
        container.removeAllViews();
        trigger.setEnabled(false);
        trigger.setText("正在查找…");
        io.execute(() -> {
            List<JSONObject> servers = Discovery.find(1800);
            runOnUiThread(() -> {
                trigger.setEnabled(true);
                trigger.setText("重新查找");
                if (servers.isEmpty()) {
                    TextView none = text("没找到。确认手机和电脑在同一 Wi-Fi，或直接填写地址。", 13, R.color.dsh_warn, false);
                    none.setPadding(0, dp(8), 0, dp(8));
                    container.addView(none);
                    return;
                }
                for (JSONObject server : servers) {
                    String url = "http://" + server.optString("address") + ":" + server.optInt("port", 7317);
                    String name = server.optString("name", "DeepSeek Harness");
                    Button item = button(name + "\n" + url, false);
                    item.setAllCaps(false);
                    item.setOnClickListener(v -> {
                        View urlField = setupView.findViewWithTag("url");
                        if (urlField instanceof EditText) ((EditText) urlField).setText(url);
                        View codeField = setupView.findViewWithTag("code");
                        if (codeField instanceof EditText) codeField.requestFocus();
                    });
                    container.addView(item, lp(0, 8));
                }
            });
        });
    }

    private void pair(String url, String code, Button connect, TextView message) {
        try {
            JSONObject body = new JSONObject();
            body.put("code", code);
            body.put("name", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
            body.put("platform", "Android " + android.os.Build.VERSION.RELEASE);
            HttpURLConnection conn = (HttpURLConnection) new URL(url + "/api/pair").openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("content-type", "application/json");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(stream);
            if (status != 200) {
                runOnUiThread(() -> {
                    connect.setEnabled(true);
                    connect.setText("连接");
                    message.setText(status == 401 ? "配对码不对或已过期，请在电脑上看新码" : "连接失败（HTTP " + status + "）");
                });
                return;
            }
            JSONObject result = new JSONObject(text);
            String newToken = result.optString("token");
            String name = result.optJSONObject("server") != null
                    ? result.optJSONObject("server").optString("name", "cc-dsh") : "cc-dsh";
            prefs.edit().putString(KEY_URL, url).putString(KEY_TOKEN, newToken).putString(KEY_NAME, name).apply();
            baseUrl = url;
            token = newToken;
            serverName = name;
            runOnUiThread(() -> {
                Toast.makeText(this, "已连接", Toast.LENGTH_SHORT).show();
                showWeb();
            });
        } catch (Exception error) {
            runOnUiThread(() -> {
                connect.setEnabled(true);
                connect.setText("连接");
                message.setText("连不上：" + error.getMessage());
            });
        }
    }

    // ---------------------------------------------------------------- web

    @SuppressLint("AddJavascriptInterface")
    private void showWeb() {
        setupMode = false;
        root.removeAllViews();

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(getColor(R.color.dsh_bg));
        root.addView(column);

        // The page owns the whole surface (header, sessions, composer); the
        // shell only contributes the connection progress line and recovery.
        statusBar = null;

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setVisibility(View.GONE);
        column.addView(progress, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.dsh_bg));
        column.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setUserAgentString(settings.getUserAgentString() + " cc-dsh/1.0");
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            // The page ships its own light and dark palettes (mirrored from the
            // desktop's ui-theme); the automatic WebView darkening would invert
            // the light theme, so it stays off.
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(baseUrl, "ccdsh_token=" + token + "; path=/");

        web.addJavascriptInterface(new Bridge(), "CCDSH");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                // Keep page errors reachable from `adb logcat` when the phone only
                // shows a toast.
                android.util.Log.i("ccdsh-web", message.message() + " @" + message.lineNumber());
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progress == null) return;
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                progress.setProgress(newProgress);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                } catch (Exception error) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.getHost() != null && baseUrl.contains(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (progress != null) progress.setVisibility(View.GONE);
                setStatus(serverName);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) showError("连不上电脑上的 cc-dsh 插件\n" + error.getDescription());
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Self-signed LAN/Tailscale certificates are expected; trust on
                // first use per host and refuse anything that changes later.
                if (acceptCertificate(error)) handler.proceed();
                else handler.cancel();
            }
        });

        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.addRequestHeader("Authorization", "Bearer " + token);
                request.addRequestHeader("Cookie", "ccdsh_token=" + token);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType));
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
                Toast.makeText(this, "开始下载", Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(this, "下载失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
            }
        });

        web.loadUrl(baseUrl + "/");
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    private void showMenu() {
        String[] items = {"重新配对 / 换一台电脑", "在浏览器中打开", "关于"};
        new AlertDialog.Builder(this)
                .setItems(items, (dialog, which) -> {
                    if (which == 0) {
                        prefs.edit().remove(KEY_URL).remove(KEY_TOKEN).apply();
                        baseUrl = "";
                        token = "";
                        showSetup();
                    } else if (which == 1) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(baseUrl + "/?token=" + token)));
                        } catch (Exception ignored) {
                        }
                    } else {
                        new AlertDialog.Builder(this)
                                .setTitle("cc-dsh 1.0.4")
                                .setMessage("手机操控电脑上的 DeepSeek Harness。\n\n电脑端：DSH 插件 cc-dsh 提供网关与会话控制。\n手机端：本应用只负责配对、信任与承载界面。")
                                .setPositiveButton("好", null)
                                .show();
                    }
                })
                .show();
    }

    private void showError(String message) {
        if (web == null) return;
        errorView = errorOverlay(message);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setStatus("未连接");
    }

    private View errorOverlay(String message) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setBackgroundColor(getColor(R.color.dsh_bg));
        column.setPadding(dp(30), dp(30), dp(30), dp(30));

        TextView title = text("连接中断", 22, R.color.dsh_text, true);
        column.addView(title);

        TextView detail = text(message, 14, R.color.dsh_text_secondary, false);
        detail.setGravity(Gravity.CENTER);
        detail.setPadding(0, dp(12), 0, dp(24));
        column.addView(detail);

        Button retry = button("重试", false);
        retry.setOnClickListener(v -> {
            if (errorView != null) root.removeView(errorView);
            errorView = null;
            if (web != null) web.reload();
            setStatus(serverName);
        });
        column.addView(retry, lp(0, 6));

        Button other = button("换一台电脑", true);
        other.setOnClickListener(v -> {
            prefs.edit().remove(KEY_URL).remove(KEY_TOKEN).apply();
            baseUrl = "";
            token = "";
            if (errorView != null) root.removeView(errorView);
            errorView = null;
            showSetup();
        });
        column.addView(other, lp(0, 10));
        return column;
    }

    private void setStatus(String text) {
        if (statusBar != null) statusBar.setText(text);
    }

    private boolean acceptCertificate(SslError error) {
        try {
            String certificate = error.getCertificate().toString();
            String host = Uri.parse(baseUrl).getHost();
            String key = "pin:" + host;
            String stored = prefs.getString(key, "");
            String current = sha256(certificate.getBytes(StandardCharsets.UTF_8));
            if (stored.isEmpty()) {
                prefs.edit().putString(key, current).apply();
                return true;
            }
            return stored.equals(current);
        } catch (Exception exception) {
            return false;
        }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && filePathCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(result);
            filePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (setupMode || web == null) {
            super.onBackPressed();
            return;
        }
        // Let the page consume the gesture first: it closes a panel, closes a
        // sheet, or leaves the conversation. Only at the session list does back
        // mean "quit", so an edge swipe inside the app never pops the exit
        // dialog by surprise.
        if (backPending) return;
        backPending = true;
        web.evaluateJavascript(
                "(function(){try{return String(!!(window.__ccdshBack&&window.__ccdshBack()))}catch(e){return 'false'}})()",
                value -> {
                    backPending = false;
                    boolean handled = value != null && value.contains("true");
                    if (!handled) confirmExit();
                });
    }

    private void confirmExit() {
        new AlertDialog.Builder(this)
                .setMessage("退出 cc-dsh？")
                .setPositiveButton("退出", (d, w) -> finish())
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        io.shutdownNow();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- bridge

    private class Bridge {
        @JavascriptInterface
        public String token() {
            return token;
        }

        @JavascriptInterface
        public String baseUrl() {
            return baseUrl;
        }

        @JavascriptInterface
        public String serverName() {
            return serverName;
        }

        /** Readable name the PC shows in its device list. */
        @JavascriptInterface
        public String deviceName() {
            return android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL;
        }

        @JavascriptInterface
        public String devicePlatform() {
            return "Android " + android.os.Build.VERSION.RELEASE;
        }

        @JavascriptInterface
        public void forget() {
            runOnUiThread(() -> {
                prefs.edit().remove(KEY_URL).remove(KEY_TOKEN).apply();
                baseUrl = "";
                token = "";
                showSetup();
            });
        }

        @JavascriptInterface
        public void saveConnection(String newToken, String name) {
            if (newToken == null || newToken.isEmpty()) return;
            token = newToken;
            if (name != null && !name.isEmpty()) serverName = name;
            prefs.edit().putString(KEY_TOKEN, token).putString(KEY_NAME, serverName).apply();
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }

    // ---------------------------------------------------------------- ui helpers

    private TextView text(String value, int sp, int colorRes, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(getColor(colorRes));
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private Button button(String label, boolean ghost) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable background = new GradientDrawable();
        background.setCornerRadius(dp(12));
        if (ghost) {
            background.setColor(getColor(R.color.dsh_ghost_bg));
            background.setStroke(dp(1), getColor(R.color.dsh_ghost_border));
            button.setTextColor(getColor(R.color.dsh_ghost_text));
        } else {
            background.setColor(getColor(R.color.dsh_accent));
            button.setTextColor(getColor(R.color.dsh_accent_text));
        }
        button.setBackground(background);
        button.setPadding(dp(16), dp(12), dp(16), dp(12));
        return button;
    }

    private Button smallButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        button.setTextColor(getColor(R.color.dsh_text_secondary));
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setPadding(dp(10), dp(4), dp(10), dp(4));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        return button;
    }

    private EditText input(String hint, int type) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        input.setTextColor(getColor(R.color.dsh_text));
        input.setHintTextColor(getColor(R.color.dsh_text_tertiary));
        input.setInputType(type);
        input.setSingleLine(true);
        GradientDrawable background = new GradientDrawable();
        background.setCornerRadius(dp(10));
        background.setColor(getColor(R.color.dsh_field_bg));
        background.setStroke(dp(1), getColor(R.color.dsh_field_border));
        input.setBackground(background);
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        return input;
    }

    private LinearLayout.LayoutParams lp(int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(top);
        params.bottomMargin = dp(bottom);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String trimUrl(String value) {
        if (value == null) return "";
        String url = value.trim();
        if (url.isEmpty()) return "";
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    private static String sha256(byte[] data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(data);
        StringBuilder builder = new StringBuilder();
        for (byte value : hash) builder.append(String.format("%02x", value));
        return builder.toString();
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    // ---------------------------------------------------------------- discovery

    static final class Discovery {
        static List<JSONObject> find(int timeoutMs) {
            List<JSONObject> servers = new ArrayList<>();
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setBroadcast(true);
                socket.setSoTimeout(300);
                byte[] payload = "CCDSH-DISCOVER-1".getBytes(StandardCharsets.UTF_8);
                DatagramPacket packet = new DatagramPacket(payload, payload.length,
                        InetAddress.getByName("255.255.255.255"), 55901);
                socket.send(packet);

                long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buffer = new byte[2048];
                while (System.currentTimeMillis() < deadline) {
                    try {
                        DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
                        socket.receive(reply);
                        String text = new String(reply.getData(), 0, reply.getLength(), StandardCharsets.UTF_8);
                        JSONObject object = new JSONObject(text);
                        object.put("address", reply.getAddress().getHostAddress());
                        servers.add(object);
                    } catch (Exception timeout) {
                        // keep waiting until the deadline
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (socket != null) socket.close();
            }
            return servers;
        }
    }
}
