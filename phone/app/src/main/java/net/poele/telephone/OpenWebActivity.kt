package net.poele.telephone

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** L'icône de l'app : ouvre l'app web du poêle (le widget, lui, se pose depuis l'écran d'accueil). */
class OpenWebActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.WORKER_URL.isNotBlank()) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WORKER_URL))) }
        }
        StoveWidget.render(this)
        finish()
    }
}
