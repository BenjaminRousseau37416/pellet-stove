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
 * envoie éventuellement une commande (marche/arrêt ou auxiliaire), relit l'état, puis redessine la tuile.
 */
class StoveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        val power = inputData.getString(KEY_POWER)
        val aux = inputData.getString(KEY_AUX)
        try {
            if (power != null) {
                StoveApi.setPower(power == "on")
                delay(4_000) // laisse au poêle le temps de changer d'état
            }
            if (aux != null) {
                StoveApi.setAux(aux == "on")
                delay(2_000)
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
            if (aux != null) StoveStore.setPendingAux(context, null)
            TileService.getUpdater(context).requestUpdate(StoveTileService::class.java)
        }
        Result.success()
    }

    companion object {
        private const val KEY_POWER = "power"
        private const val KEY_AUX = "aux"
        private val NETWORK = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Actualisation simple. */
        fun refresh(context: Context) = enqueue(context, "poele-actualisation", Data.EMPTY, ExistingWorkPolicy.KEEP)

        /** Allumer (true) ou éteindre (false) le poêle. */
        fun setPower(context: Context, on: Boolean) = enqueue(
            context, "poele-commande",
            Data.Builder().putString(KEY_POWER, if (on) "on" else "off").build(),
            ExistingWorkPolicy.REPLACE,
        )

        /** Mettre en marche (true) ou arrêter (false) le ventilateur auxiliaire. */
        fun setAux(context: Context, on: Boolean) = enqueue(
            context, "poele-auxiliaire",
            Data.Builder().putString(KEY_AUX, if (on) "on" else "off").build(),
            ExistingWorkPolicy.REPLACE,
        )

        private fun enqueue(context: Context, name: String, data: Data, policy: ExistingWorkPolicy) {
            val request = OneTimeWorkRequestBuilder<StoveWorker>()
                .setInputData(data)
                .setConstraints(NETWORK)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
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
