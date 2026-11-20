package net.poele.telephone

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/**
 * Travail en arrière-plan : envoie éventuellement une commande (marche/arrêt ou auxiliaire),
 * relit l'état, puis redessine le widget.
 */
class StoveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        val power = inputData.getString(KEY_POWER)
        val aux = inputData.getString(KEY_AUX)
        // Une commande restée en attente (pas de réseau) n'est plus envoyée après coup :
        // on ne veut pas d'un poêle qui s'allume une heure après avoir touché le bouton.
        val tooLate = System.currentTimeMillis() - inputData.getLong(KEY_AT, 0) > COMMAND_MAX_DELAY_MS
        var state: StoveState? = null
        try {
            if ((power != null || aux != null) && tooLate) {
                throw StoveException("Commande abandonnée : pas de réseau à temps")
            }
            if (power != null) {
                StoveApi.setPower(power == "on")
                delay(4_000) // laisse au poêle le temps de changer d'état
            }
            if (aux != null) {
                StoveApi.setAux(aux == "on")
                delay(2_000)
            }
            state = StoveApi.fetchState()
            StoveStore.save(context, state)
            StoveStore.setError(context, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            StoveStore.setError(context, e.message ?: "Erreur réseau")
        } finally {
            if (power != null) StoveStore.setPending(context, null)
            if (aux != null) StoveStore.setPendingAux(context, null)
            StoveStore.setRefreshing(context, null)
            StoveWidget.render(context)
        }
        // Allumage, extinction ou nettoyage en cours : on revient voir dans 90 secondes.
        if (state != null && state.phase in FOLLOW_PHASES) followUp(context)
        Result.success()
    }

    companion object {
        private const val KEY_POWER = "power"
        private const val KEY_AUX = "aux"
        private const val KEY_AT = "at"
        private const val PERIODIC = "poele-periodique"
        private const val FOLLOW_UP = "poele-suivi"
        private const val COMMAND_MAX_DELAY_MS = 2 * 60 * 1000L
        private val FOLLOW_PHASES = setOf("ignition", "shutdown", "cleaning")
        private val NETWORK = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Actualisation simple. */
        fun refresh(context: Context) = enqueue(context, "poele-actualisation", Data.EMPTY, ExistingWorkPolicy.KEEP)

        /** Allumer (true) ou éteindre (false) le poêle. */
        fun setPower(context: Context, on: Boolean) = enqueue(
            context, "poele-commande",
            Data.Builder().putString(KEY_POWER, if (on) "on" else "off").putLong(KEY_AT, System.currentTimeMillis()).build(),
            ExistingWorkPolicy.REPLACE,
        )

        /** Mettre en marche (true) ou arrêter (false) le ventilateur auxiliaire. */
        fun setAux(context: Context, on: Boolean) = enqueue(
            context, "poele-auxiliaire",
            Data.Builder().putString(KEY_AUX, if (on) "on" else "off").putLong(KEY_AT, System.currentTimeMillis()).build(),
            ExistingWorkPolicy.REPLACE,
        )

        /** Actualisation toutes les 15 minutes tant qu'un widget est posé (le minimum d'Android). */
        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<StoveWorker>(15, TimeUnit.MINUTES)
                .setConstraints(NETWORK)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancelAll(context: Context) {
            val manager = WorkManager.getInstance(context)
            manager.cancelUniqueWork(PERIODIC)
            manager.cancelUniqueWork(FOLLOW_UP)
        }

        private fun enqueue(context: Context, name: String, data: Data, policy: ExistingWorkPolicy) {
            val request = OneTimeWorkRequestBuilder<StoveWorker>()
                .setInputData(data)
                .setConstraints(NETWORK)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(name, policy, request)
        }

        private fun followUp(context: Context) {
            val request = OneTimeWorkRequestBuilder<StoveWorker>()
                .setConstraints(NETWORK)
                .setInitialDelay(90, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(FOLLOW_UP, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
