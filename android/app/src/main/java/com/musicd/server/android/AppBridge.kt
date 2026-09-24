package com.musicd.server.android

import android.app.Activity
import android.webkit.JavascriptInterface

/**
 * What the server's page can ask of the app about itself — only inside the
 * app; browsers and the iPhone home-screen app have no such object.
 *
 *   MusicdApp.version()       this app's version, e.g. "0.3.4"
 *   MusicdApp.checkUpdate()   look for a newer app now, and offer it
 */
class AppBridge(private val activity: Activity) {
    companion object { const val NAME = "MusicdApp" }

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun checkUpdate() {
        activity.runOnUiThread { AppUpdate.check(activity, asked = true) }
    }
}
