package net.poele.montre

import android.content.Context
import androidx.wear.tiles.TileService
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Travail en arrière-plan (recommandé pour les appels réseau des tuiles) :
 * envoie éventuellement la commande marche/arrêt, relit l'état, puis redessine la tuile.
 */
class StoveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        val power = inputData.getString(KEY_POWER)
        try {
            if (power != null) {
                StoveApi.setPower(power == "on")
                delay(4_000) // laisse au poêle le temps de changer d'état
            }
            StoveStore.save(context, StoveApi.fetchState())
            StoveStore.setError(context, null)
        } catch (e: Exception) {
            StoveStore.setError(context, e.message ?: "Erreur réseau")
        } finally {
            if (power != null) {
                StoveStore.setPending(context, null)
                refreshLater(context) // pour voir l'allumage ou l'extinction progresser
            }
            TileService.getUpdater(context).requestUpdate(StoveTileService::class.java)
        }
        Result.success()
    }

    companion object {
        private const val KEY_POWER = "power"
        private val NETWORK = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** power = true (allumer), false (éteindre) ou null (simple actualisation). */
        fun enqueue(context: Context, power: Boolean?) {
            val data = Data.Builder()
            if (power != null) data.putString(KEY_POWER, if (power) "on" else "off")
            val request = OneTimeWorkRequestBuilder<StoveWorker>()
                .setInputData(data.build())
                .setConstraints(NETWORK)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            val name = if (power != null) "poele-commande" else "poele-actualisation"
            val policy = if (power != null) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
            WorkManager.getInstance(context).enqueueUniqueWork(name, policy, request)
        }

        private fun refreshLater(context: Context) {
            val request = OneTimeWorkRequestBuilder<StoveWorker>()
                .setConstraints(NETWORK)
                .setInitialDelay(60, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("poele-suivi", ExistingWorkPolicy.REPLACE, request)
        }
    }
}
