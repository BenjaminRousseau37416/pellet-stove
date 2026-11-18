import java.util.Properties

plugins {
    id("com.android.application")
}

// Adresse du Worker et clé de la montre : lues dans watch/secrets.properties (non versionné).
val secrets = Properties().apply {
    val file = rootProject.file("secrets.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "net.poele.montre"
    compileSdk = 36

    defaultConfig {
        applicationId = "net.poele.montre"
        minSdk = 33 // Wear OS 4 et plus récent
        targetSdk = 36
        versionCode = 2
        versionName = "1.1"
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
    implementation("androidx.wear.tiles:tiles:1.6.2")
    implementation("androidx.wear.protolayout:protolayout:1.4.2")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("androidx.concurrent:concurrent-futures:1.3.0")
}
