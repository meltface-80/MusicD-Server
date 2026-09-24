import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.musicd.server.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.musicd.server.remote"
        minSdk = 26
        targetSdk = 36
        // versionCode must rise with every published build or Android refuses
        // to install over the previous one.
        versionCode = 17
        versionName = "0.3.6"
    }

    buildFeatures {
        buildConfig = true
    }

    /*
     * The release key comes from the environment (a CI secret) and there is no
     * fallback that silently signs with something else: see the workflow.
     * Android refuses to install an APK over one signed with a different key,
     * so it must be the same key every time.
     */
    /*
     * Builds without the release secrets are signed with THIS key, committed
     * beside this file, so every one of them can update the one before —
     * a fresh debug key per CI run is what made updates fail ("an existing
     * package conflicts"). It is a debug key and public by design, like
     * Android's own: it only makes sideloaded builds update in place. For a
     * key nobody else holds, set the release secrets (see the workflow).
     */
    signingConfigs.getByName("debug") {
        storeFile = file("musicd-debug.keystore")
        storePassword = "android"
        keyAlias = "androiddebugkey"
        keyPassword = "android"
    }

    val keystorePath = System.getenv("MUSICD_KEYSTORE")
    if (!keystorePath.isNullOrBlank()) {
        signingConfigs.create("release") {
            storeFile = file(keystorePath)
            storePassword = System.getenv("MUSICD_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("MUSICD_KEY_ALIAS") ?: "musicd"
            keyPassword = System.getenv("MUSICD_KEY_PASSWORD")
                ?: System.getenv("MUSICD_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/*.kotlin_module",
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*"
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Everything that is not Android — the address rules, the API client, the
    // network search — lives in :core, where it is unit-tested on a plain JVM.
    implementation(project(":core"))
    // FileProvider only: a share card leaves the app as a content:// URI.
    implementation("androidx.core:core:1.13.1")
    // "This phone": playback (ExoPlayer) and the media session, notification
    // and lock-screen controls that come with it.
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-session:1.8.0")
    // Downloads: queued, retried and resumed, waiting for Wi-Fi if asked to.
    implementation("androidx.work:work-runtime:2.10.3")
}
