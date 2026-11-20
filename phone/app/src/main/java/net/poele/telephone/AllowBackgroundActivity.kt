package net.poele.telephone

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings

/**
 * Demande à Android de laisser l'app travailler en arrière-plan (« Non restreinte »).
 * Sans cela, l'économie d'énergie coupe Internet au widget et il reste sur « Chargement… ».
 */
class AllowBackgroundActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        if (isAllowed(this)) {
            done()
            return
        }
        val request = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        runCatching { startActivityForResult(request, REQUEST) }.onFailure {
            // Pas de fenêtre de demande : on ouvre la fiche de l'app (Batterie → Non restreinte).
            runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
            done()
        }
    }

    @Deprecated("API Activity d'origine, suffisante ici")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        done()
    }

    private fun done() {
        StoveWidget.render(this)
        StoveWorker.refresh(this)
        finish()
    }

    companion object {
        private const val REQUEST = 1

        fun isAllowed(context: Context): Boolean =
            context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) ?: true
    }
}
