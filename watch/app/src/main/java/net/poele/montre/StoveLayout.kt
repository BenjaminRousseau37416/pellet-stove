package net.poele.montre

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Mise en page de la tuile (ProtoLayout). */
object StoveLayout {
    const val TOGGLE = "toggle:"
    const val REFRESH = "refresh:"

    private const val ORANGE = 0xFFFF7A2E.toInt()
    private const val BUTTON_GREY = 0xFF303030.toInt()
    private const val WHITE = 0xFFFFFFFF.toInt()
    private const val MUTED = 0xFFB0B0B0.toInt()
    private const val RED = 0xFFFF7070.toInt()

    fun build(state: StoveState?, pending: Boolean?, error: String?): LayoutElementBuilders.LayoutElement {
        // Identifiant de clic unique à chaque rendu : un ancien clic n'est jamais rejoué.
        val nonce = System.currentTimeMillis().toString()

        val room = state?.room?.let { String.format(Locale.FRANCE, "%.1f°", it) } ?: "—"
        val status = when {
            state == null -> "Chargement…"
            !state.online -> "Poêle hors ligne"
            else -> state.status
        }

        // Libellé, couleur et disponibilité du bouton
        val (label, color, enabled) = when {
            pending == true -> Triple("Allumage…", BUTTON_GREY, false)
            pending == false -> Triple("Extinction…", BUTTON_GREY, false)
            state == null || !state.online -> Triple("—", BUTTON_GREY, false)
            !state.canToggle -> Triple("Patiente…", BUTTON_GREY, false)
            state.isOn -> Triple("Éteindre", BUTTON_GREY, true)
            else -> Triple("Allumer", ORANGE, true)
        }

        val footer = when {
            error != null -> error
            state != null -> "Mis à jour à " + SimpleDateFormat("HH:mm", Locale.FRANCE).format(Date(state.at))
            else -> ""
        }

        val buttonModifiers = ModifiersBuilders.Modifiers.Builder()
            .setBackground(
                ModifiersBuilders.Background.Builder()
                    .setColor(argb(color))
                    .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(26f)).build())
                    .build()
            )
        if (enabled) buttonModifiers.setClickable(clickable(TOGGLE + nonce))

        val button = LayoutElementBuilders.Box.Builder()
            .setWidth(dp(132f))
            .setHeight(dp(52f))
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .setModifiers(buttonModifiers.build())
            .addContent(text(label, 16f, WHITE, bold = true))
            .build()

        val column = LayoutElementBuilders.Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text("Poêle", 14f, MUTED))
            .addContent(text(room, 34f, WHITE, bold = true))
            .addContent(text(status, 14f, MUTED))
            .addContent(spacer(10f))
            .addContent(button)
            .addContent(spacer(8f))
            .addContent(text(footer, 12f, if (error != null) RED else MUTED, maxLines = 2))
            .build()

        // Toucher en dehors du bouton : actualiser l'état.
        return LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(clickable(REFRESH + nonce)).build())
            .addContent(column)
            .build()
    }

    private fun clickable(id: String) = ModifiersBuilders.Clickable.Builder()
        .setId(id)
        .setOnClick(ActionBuilders.LoadAction.Builder().build())
        .build()

    private fun spacer(height: Float) = LayoutElementBuilders.Spacer.Builder().setHeight(dp(height)).build()

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false, maxLines: Int = 1) =
        LayoutElementBuilders.Text.Builder()
            .setText(value)
            .setMaxLines(maxLines)
            .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
            .setFontStyle(
                LayoutElementBuilders.FontStyle.Builder()
                    .setSize(sp(size))
                    .setColor(argb(color))
                    .setWeight(if (bold) LayoutElementBuilders.FONT_WEIGHT_BOLD else LayoutElementBuilders.FONT_WEIGHT_NORMAL)
                    .build()
            )
            .build()
}
