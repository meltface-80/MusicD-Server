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
        versionCode = 7
        versionName = "0.1.6"
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
}
