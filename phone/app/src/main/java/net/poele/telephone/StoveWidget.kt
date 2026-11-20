package net.poele.telephone

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Widget « Poêle » : température de la pièce, état, bouton Allumer / Éteindre
 * et bouton Chambre (ventilateur auxiliaire), sur une ligne. Toucher l'heure actualise ; toucher la température ouvre l'app web.
 */
class StoveWidget : AppWidgetProvider() {

    override fun onEnabled(context: Context) = StoveWorker.schedulePeriodic(context)

    override fun onDisabled(context: Context) = StoveWorker.cancelAll(context)

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        StoveWorker.schedulePeriodic(context)
        render(context)
        val cached = StoveStore.load(context)
        if (cached == null || System.currentTimeMillis() - cached.at > STALE_MS) StoveWorker.refresh(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_ON, ACTION_OFF -> {
                val cached = StoveStore.load(context)
                if (StoveStore.pending(context) == null && cached?.canToggle != false) {
                    // Le bouton envoie ce qu'il affiche : « Allumer » allume, « Éteindre » éteint.
                    val on = intent.action == ACTION_ON
                    StoveStore.setPending(context, on)
                    render(context)
                    StoveWorker.setPower(context, on)
                }
            }
            ACTION_AUX_ON, ACTION_AUX_OFF -> {
                if (StoveStore.pendingAux(context) == null) {
                    val on = intent.action == ACTION_AUX_ON
                    StoveStore.setPendingAux(context, on)
                    render(context)
                    StoveWorker.setAux(context, on)
                }
            }
            ACTION_REFRESH -> {
                StoveStore.setRefreshing(context, true)
                render(context)
                StoveWorker.refresh(context)
            }
            else -> super.onReceive(context, intent)
        }
    }

    companion object {
        private const val ACTION_ON = "net.poele.telephone.ALLUMER"
        private const val ACTION_OFF = "net.poele.telephone.ETEINDRE"
        private const val ACTION_AUX_ON = "net.poele.telephone.CHAMBRE_MARCHE"
        private const val ACTION_AUX_OFF = "net.poele.telephone.CHAMBRE_ARRET"
        private const val ACTION_REFRESH = "net.poele.telephone.ACTUALISER"
        private const val STALE_MS = 2 * 60 * 1000L // état jugé ancien au-delà de 2 minutes

        private enum class Look(val background: Int, val text: Int) {
            ACCENT(R.drawable.button_accent, R.color.widget_on_color),
            COOL(R.drawable.button_cool, R.color.widget_on_color),
            NEUTRAL(R.drawable.button_neutral, R.color.widget_on_neutral),
        }

        /** Redessine tous les widgets posés à partir de l'état mémorisé. */
        fun render(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, StoveWidget::class.java))
            if (ids.isEmpty()) return
            manager.updateAppWidget(ids, build(context))
        }

        private fun build(context: Context): RemoteViews {
            val state = StoveStore.load(context)
            val pending = StoveStore.pending(context)
            val pendingAux = StoveStore.pendingAux(context)
            val error = StoveStore.error(context)
            val views = RemoteViews(context.packageName, R.layout.widget_stove)

            views.setTextViewText(R.id.room, state?.room?.let { String.format(Locale.FRANCE, "%.1f °C", it) } ?: "—")
            views.setTextViewText(
                R.id.status,
                when {
                    state == null -> "Chargement…"
                    !state.online -> "Poêle hors ligne"
                    else -> state.status
                },
            )

            when {
                pending == true -> button(context, views, R.id.toggle, "Allumage…", Look.NEUTRAL, null)
                pending == false -> button(context, views, R.id.toggle, "Extinction…", Look.NEUTRAL, null)
                state == null || !state.online -> button(context, views, R.id.toggle, "—", Look.NEUTRAL, null)
                !state.canToggle -> button(context, views, R.id.toggle, "Patiente…", Look.NEUTRAL, null)
                state.isOn -> button(context, views, R.id.toggle, "Éteindre", Look.NEUTRAL, ACTION_OFF)
                else -> button(context, views, R.id.toggle, "Allumer", Look.ACCENT, ACTION_ON)
            }

            if (state != null && state.hasAux) {
                views.setViewVisibility(R.id.aux, View.VISIBLE)
                when {
                    pendingAux != null -> button(context, views, R.id.aux, "Chambre…", Look.NEUTRAL, null)
                    !state.online -> button(context, views, R.id.aux, "Chambre", Look.NEUTRAL, null)
                    state.auxPower > 0 -> button(context, views, R.id.aux, "Chambre · ${state.auxPower}", Look.COOL, ACTION_AUX_OFF)
                    else -> button(context, views, R.id.aux, "Chambre", Look.NEUTRAL, ACTION_AUX_ON) // gris = à l'arrêt
                }
            } else {
                views.setViewVisibility(R.id.aux, View.GONE)
            }

            // Sans autorisation en arrière-plan, l'économie d'énergie coupe Internet au widget :
            // on le signale en bas, et toucher le texte ouvre la demande d'autorisation.
            val allowed = AllowBackgroundActivity.isAllowed(context)
            val refreshing = StoveStore.refreshing(context)
            val footer = when {
                !allowed -> "Toucher ici : autoriser l'arrière-plan"
                refreshing -> "Actualisation…"
                error != null -> error
                state != null -> "Mis à jour à " + SimpleDateFormat("HH:mm", Locale.FRANCE).format(Date(state.at))
                else -> ""
            }
            views.setTextViewText(R.id.footer, footer)
            views.setColor(R.id.footer, "setTextColor", if (!allowed || (error != null && !refreshing)) R.color.widget_error else R.color.widget_muted)
            views.setOnClickPendingIntent(
                R.id.footer_row,
                if (allowed) broadcast(context, ACTION_REFRESH) else allowBackground(context),
            )

            openWebApp(context)?.let { views.setOnClickPendingIntent(R.id.open, it) }
            return views
        }

        /** Bouton actif (action non nulle) ou grisé. */
        private fun button(context: Context, views: RemoteViews, id: Int, label: String, look: Look, action: String?) {
            views.setTextViewText(id, label)
            views.setInt(id, "setBackgroundResource", look.background)
            views.setColor(id, "setTextColor", if (action == null) R.color.widget_muted else look.text)
            views.setBoolean(id, "setEnabled", action != null)
            if (action != null) views.setOnClickPendingIntent(id, broadcast(context, action))
        }

        private fun broadcast(context: Context, action: String): PendingIntent = PendingIntent.getBroadcast(
            context, 0,
            Intent(context, StoveWidget::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun allowBackground(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 1,
            Intent(context, AllowBackgroundActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun openWebApp(context: Context): PendingIntent? {
            if (BuildConfig.WORKER_URL.isBlank()) return null
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WORKER_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
