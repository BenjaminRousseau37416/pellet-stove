import java.util.Properties

plugins {
    id("com.android.application")
}

// Adresse du Worker et clé d'accès : lues dans phone/secrets.properties (non versionné).
// Le widget utilise la même clé que la montre (routes /api/watch du Worker).
val secrets = Properties().apply {
    val file = rootProject.file("secrets.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "net.poele.telephone"
    compileSdk = 36

    defaultConfig {
        applicationId = "net.poele.telephone"
        minSdk = 31 // Android 12 et plus récent
        targetSdk = 36
        versionCode = 3
        versionName = "1.2"
        buildConfigField("String", "WORKER_URL", "\"${secrets.getProperty("WORKER_URL", "")}\"")
        buildConfigField("String", "WATCH_TOKEN", "\"${secrets.getProperty("WATCH_TOKEN", "")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.12.0")
}
