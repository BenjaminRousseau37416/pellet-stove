package net.poele.montre

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/**
 * Tuile « Poêle » : température de la pièce, état, et un bouton Allumer / Éteindre.
 * Toucher le bouton envoie la commande ; toucher ailleurs actualise l'état.
 */
class StoveTileService : TileService() {

    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val context = this
        val clicked = requestParams.currentState.lastClickableId
        val cached = StoveStore.load(context)

        when {
            clicked.startsWith(StoveLayout.TOGGLE) && StoveStore.firstTimeClick(context, clicked) -> {
                if (cached != null && cached.canToggle && StoveStore.pending(context) == null) {
                    val turnOn = !cached.isOn
                    StoveStore.setPending(context, turnOn)
                    StoveWorker.enqueue(context, turnOn)
                }
            }
            clicked.startsWith(StoveLayout.REFRESH) && StoveStore.firstTimeClick(context, clicked) ->
                StoveWorker.enqueue(context, null)
            cached == null || System.currentTimeMillis() - cached.at > STALE_MS ->
                StoveWorker.enqueue(context, null)
        }

        val layout = StoveLayout.build(
            StoveStore.load(context),
            StoveStore.pending(context),
            StoveStore.error(context),
        )
        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES_VERSION)
            .setFreshnessIntervalMillis(FRESHNESS_MS)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout))
            .build()
        return CallbackToFutureAdapter.getFuture { completer ->
            completer.set(tile)
            "tuile"
        }
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        CallbackToFutureAdapter.getFuture { completer ->
            completer.set(ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build())
            "ressources"
        }

    companion object {
        private const val RESOURCES_VERSION = "1"
        private const val STALE_MS = 2 * 60 * 1000L // état jugé ancien au-delà de 2 minutes
        private const val FRESHNESS_MS = 10 * 60 * 1000L // la montre redemande la tuile toutes les 10 minutes
    }
}
