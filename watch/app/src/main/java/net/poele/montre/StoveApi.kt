package net.poele.montre

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** État résumé renvoyé par le Worker (GET /api/watch). */
data class StoveState(
    val online: Boolean,
    val isOn: Boolean,
    val phase: String,
    val status: String,
    val room: Double?,
    val canToggle: Boolean,
    val at: Long,
)

class StoveException(message: String) : Exception(message)

/** Appels au Worker avec la clé réservée à la montre (en-tête Authorization: Bearer). */
object StoveApi {
    private const val TIMEOUT_MS = 10_000

    private fun open(path: String, method: String): HttpURLConnection {
        if (BuildConfig.WORKER_URL.isBlank() || BuildConfig.WATCH_TOKEN.isBlank()) {
            throw StoveException("App non configurée")
        }
        val url = URL(BuildConfig.WORKER_URL.trimEnd('/') + path)
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Authorization", "Bearer ${BuildConfig.WATCH_TOKEN}")
            setRequestProperty("Accept", "application/json")
        }
    }

    private fun HttpURLConnection.readBody(): String {
        val ok = responseCode in 200..299
        val text = (if (ok) inputStream else errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (!ok) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            throw StoveException(if (message.isNullOrBlank()) "Erreur $responseCode" else message)
        }
        return text
    }

    fun fetchState(): StoveState {
        val connection = open("/api/watch", "GET")
        try {
            val json = JSONObject(connection.readBody())
            return StoveState(
                online = json.optBoolean("online", true),
                isOn = json.optBoolean("isOn"),
                phase = json.optString("phase"),
                status = json.optString("statusFr"),
                room = if (json.isNull("roomTemperature")) null else json.optDouble("roomTemperature"),
                canToggle = json.optBoolean("canToggle"),
                at = System.currentTimeMillis(),
            )
        } finally {
            connection.disconnect()
        }
    }

    fun setPower(on: Boolean) {
        val connection = open("/api/watch/power", "POST")
        try {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write("""{"on":$on}""".toByteArray()) }
            connection.readBody()
        } finally {
            connection.disconnect()
        }
    }
}
