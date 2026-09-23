package com.musicd.server.android

import android.os.Build
import android.view.View
import android.view.WindowInsets

/**
 * Keep content out from under the status and navigation bars.
 *
 * From Android 15 a window is drawn edge to edge whatever the theme says, so
 * without this the page's top bar would sit under the clock. The window
 * background is the page's own colour, so the padded strips are invisible.
 */
object Insets {
    fun pad(view: View) {
        view.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        view.requestApplyInsets()
    }
}
