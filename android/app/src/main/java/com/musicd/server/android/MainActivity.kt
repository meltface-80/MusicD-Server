package com.musicd.server.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The app: MusicD Server's own page, full screen.
 *
 * The interface is the server's — the same page a browser or the iOS home
 * screen shortcut shows — so a new server version is a new interface with no
 * app update. What the app adds is what a page cannot do: the lock screen and
 * notification controls, the widget, the Quick Settings tile, and a share sheet
 * for the share card.
 *
 * Away from home the page comes from the server's Tailscale address instead
 * (see [Away]), and it is reloaded from the right one whenever that changes.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "MainActivity"
        const val ACTION_CHANGE_SERVER = "com.musicd.server.android.action.CHANGE_SERVER"
        private const val BACKGROUND = 0xFF0E1012.toInt()
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var errorPanel: LinearLayout
    private lateinit var errorText: TextView
    private var loadedBase: String? = null
    private val onAway: (Boolean) -> Unit = { reloadIfMoved() }
    /** The last load failed (set by the WebView client, cleared by each load). */
    private var loadFailed = false
    /** The offline screen has been opened for this outage — once, so Back returns here. */
    private var offlineShown = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.action == ACTION_CHANGE_SERVER || Store.server(this) == null) {
            openConnect()
            finish()
            return
        }
        if (Store.token(this) == null) {
            openSignIn()
            finish()
            return
        }

        root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }
        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(BACKGROUND)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                builtInZoomControls = false
                displayZoomControls = false
                // Tells the page it's inside this app (see index.html: the app
                // keeps it clear of the system bars, so the page mustn't too).
                userAgentString = "$userAgentString MusicDAndroid/${BuildConfig.VERSION_NAME}"
            }
            webViewClient = Client()
            addJavascriptInterface(ShareBridge(this@MainActivity), ShareBridge.NAME)
            addJavascriptInterface(DownloadsBridge(this@MainActivity), DownloadsBridge.NAME)
            addJavascriptInterface(AppBridge(this@MainActivity), AppBridge.NAME)
        }
        root.addView(web)
        root.addView(buildErrorPanel())
        Insets.pad(root)
        setContentView(root)

        registerBack()
        CrashLog.offer(this)
        askForNotificationPermission()
        AutoDownloads.schedule(this)
        Away.listen(onAway)
        Away.watch(this)
        load()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_CHANGE_SERVER) openConnect()
    }

    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        // The server may have been changed from the connect screen — or it
        // couldn't be reached last time (back from the offline screen): try again.
        if (errorPanel.visibility == View.VISIBLE) load() else reloadIfMoved()
        Away.recheck(this)
        AppUpdate.check(this)
        NowPlayingService.start(this)
        PhonePlayerService.start(this)
    }

    private fun reloadIfMoved() {
        if (!::web.isInitialized) return
        val base = Store.active(this)?.baseUrl
        if (base != null && base != loadedBase) load()
    }

    private fun load() {
        if (Store.server(this) == null) return openConnect()
        val base = Store.active(this)?.baseUrl ?: return openConnect()
        val token = Store.token(this) ?: return signedOut()
        loadedBase = base
        loadFailed = false
        // The page signs in with the same token the rest of the app uses.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(base, "musicd_session=$token; Path=/")
            flush()
        }
        errorPanel.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl("$base/")
    }

    /** This phone was signed out (from Settings, or the account was reset): sign in again. */
    private fun signedOut() {
        Store.setToken(this, null)
        openSignIn()
        finish()
    }

    private fun openSignIn() {
        startActivity(Intent(this, SignInActivity::class.java))
    }

    private fun openConnect() {
        startActivity(Intent(this, ConnectActivity::class.java))
    }

    private fun buildErrorPanel(): LinearLayout {
        val dp = resources.displayMetrics.density
        errorText = TextView(this).apply {
            setTextColor(0xFFBFC7CE.toInt())
            textSize = 16f
            gravity = Gravity.CENTER
        }
        errorPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding((24 * dp).toInt(), 0, (24 * dp).toInt(), 0)
            setBackgroundColor(BACKGROUND)
            visibility = View.GONE
            addView(errorText)
            addView(Button(this@MainActivity).apply {
                text = "Try again"
                setOnClickListener { load() }
            })
            addView(Button(this@MainActivity).apply {
                text = "On this phone"
                setOnClickListener { startActivity(Intent(this@MainActivity, DownloadsActivity::class.java)) }
            })
            addView(Button(this@MainActivity).apply {
                text = "Change server"
                setOnClickListener { openConnect() }
            })
        }
        return errorPanel
    }

    private fun showError(message: String) {
        errorText.text = message
        errorPanel.visibility = View.VISIBLE
        web.visibility = View.GONE
    }

    private fun askForNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    /**
     * Back walks the page's own history (album → Home) before it leaves the
     * app. From Android 16 the system no longer calls onBackPressed for apps
     * that target it, so the callback is registered with the dispatcher there;
     * the override covers the versions before.
     */
    private fun back() {
        if (!::web.isInitialized || web.visibility != View.VISIBLE) { moveTaskToBack(true); return }
        // The page first: full-screen Settings closes (or steps back a pane).
        web.evaluateJavascript("(window.__musicdBack && window.__musicdBack()) ? 1 : 0") { handled ->
            if (handled == "1") return@evaluateJavascript
            if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }
    }

    private fun registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
            ) { back() }
        }
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        back()
    }

    override fun onDestroy() {
        Away.unlisten(onAway)
        if (::web.isInitialized) {
            root.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            // The server sends a signed-out page to /login; the app signs in natively instead.
            val base = loadedBase
            if (base != null && url.startsWith("$base/login")) {
                view.stopLoading()
                signedOut()
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (!loadFailed) offlineShown = false
            ShareBridge.install(view)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            // Perhaps the phone has just left home (or come back): look again.
            Away.recheck(this@MainActivity)
            val where = Store.active(this@MainActivity)?.toString() ?: "the server"
            loadFailed = true
            showError("Can't reach MusicD Server at $where.\n\n${error.description}\n")
            // The app's own screen instead of an error: what's on the phone, and its player.
            if (!offlineShown && DownloadStore.albums(this@MainActivity).any { it.first.state == "done" }) {
                offlineShown = true
                startActivity(Intent(this@MainActivity, DownloadsActivity::class.java)
                    .putExtra(DownloadsActivity.EXTRA_OFFLINE, true))
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url ?: return false
            val base = loadedBase
            if (base != null && url.toString().startsWith(base)) return false
            return openExternally(url)
        }

        private fun openExternally(url: Uri): Boolean {
            // A Qobuz album link opens the Qobuz app when it is installed.
            val s = url.toString()
            if (s.startsWith("https://open.qobuz.com/album/")) {
                val id = s.removePrefix("https://open.qobuz.com/album/").substringBefore('?').substringBefore('/')
                if (id.isNotEmpty() && id.all { it.isLetterOrDigit() } && start(Uri.parse("qobuzapp://album/$id"))) return true
            }
            if (!start(url)) Log.w(TAG, "nothing could open $url")
            return true
        }

        private fun start(url: Uri): Boolean = try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Exception) {
            false
        }
    }
}
