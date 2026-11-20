package net.poele.telephone

import android.content.Context
import org.json.JSONObject

/**
 * Mémoire locale du widget : dernier état connu, dernière erreur,
 * et commandes envoyées mais pas encore confirmées.
 */
object StoveStore {
    private const val PREFS = "poele"

    /** Au-delà, une commande « en cours » est considérée comme perdue. */
    const val PENDING_MAX_MS = 90_000L

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(context: Context, state: StoveState) {
        val json = JSONObject()
            .put("online", state.online)
            .put("isOn", state.isOn)
            .put("phase", state.phase)
            .put("status", state.status)
            .put("room", state.room ?: JSONObject.NULL)
            .put("canToggle", state.canToggle)
            .put("at", state.at)
            .put("hasAux", state.hasAux)
            .put("auxPower", state.auxPower)
            .put("auxLevel", state.auxLevel)
        prefs(context).edit().putString("state", json.toString()).apply()
    }

    fun load(context: Context): StoveState? {
        val raw = prefs(context).getString("state", null) ?: return null
        return runCatching {
            val json = JSONObject(raw)
            StoveState(
                online = json.optBoolean("online", true),
                isOn = json.optBoolean("isOn"),
                phase = json.optString("phase"),
                status = json.optString("status"),
                room = if (json.isNull("room")) null else json.optDouble("room"),
                canToggle = json.optBoolean("canToggle"),
                at = json.optLong("at"),
                hasAux = json.optBoolean("hasAux"),
                auxPower = json.optInt("auxPower", 0),
                auxLevel = json.optInt("auxLevel", 2),
            )
        }.getOrNull()
    }

    fun setError(context: Context, message: String?) {
        prefs(context).edit().putString("error", message).apply()
    }

    fun error(context: Context): String? = prefs(context).getString("error", null)

    /** Commande marche/arrêt envoyée et pas encore confirmée : true = allumage, false = extinction. */
    fun setPending(context: Context, on: Boolean?) = setFlag(context, "pending", on)

    fun pending(context: Context): Boolean? = flag(context, "pending")

    /** Commande de l'auxiliaire envoyée et pas encore confirmée : true = marche, false = arrêt. */
    fun setPendingAux(context: Context, on: Boolean?) = setFlag(context, "pendingAux", on)

    fun pendingAux(context: Context): Boolean? = flag(context, "pendingAux")

    /** Actualisation demandée depuis le widget (toucher l'heure) et pas encore terminée. */
    fun setRefreshing(context: Context, on: Boolean?) = setFlag(context, "refreshing", on)

    fun refreshing(context: Context): Boolean = flag(context, "refreshing") != null

    private fun setFlag(context: Context, key: String, on: Boolean?) {
        val edit = prefs(context).edit()
        if (on == null) edit.remove(key).remove("${key}At")
        else edit.putBoolean(key, on).putLong("${key}At", System.currentTimeMillis())
        edit.apply()
    }

    private fun flag(context: Context, key: String): Boolean? {
        val p = prefs(context)
        if (!p.contains(key)) return null
        if (System.currentTimeMillis() - p.getLong("${key}At", 0) > PENDING_MAX_MS) return null
        return p.getBoolean(key, false)
    }
}
