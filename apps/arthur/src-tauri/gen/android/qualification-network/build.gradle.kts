// Standalone opt-in test application. Never included by Tauri's settings.gradle.
plugins { id("com.android.application") version "9.3.1" }
// Opt-in selector; never changes the generated/default Tauri application.
val qualificationAbi = providers.gradleProperty("qualificationAbi").getOrElse("x86_64")
require(qualificationAbi in listOf("x86_64", "arm64-v8a")) { "Unsupported qualification ABI" }
android {
    namespace = "dev.kaloyan.arthur"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.kaloyan.arthur.identitytest"
        minSdk = 24
        targetSdk = 37
        // Match the dedicated Tauri instrumentation app, never downgrade it.
        versionCode = 1000
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters.add(qualificationAbi) }
    }
    sourceSets {
        getByName("main") {
            java.setSrcDirs(listOf("../app/src/main/java"))
            jniLibs.setSrcDirs(listOf("../app/src/main/jniLibs"))
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
}
androidComponents {
    beforeVariants(selector().all()) { variant -> if (variant.buildType != "debug") variant.enable = false }
}
dependencies {
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test:runner:1.5.0")
}
