import java.security.MessageDigest

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.ksp)
}

android {
  namespace = "com.yangxia.app"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.yangxia.app"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "2.0.0-alpha"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    compose = true
    aidl = false
    buildConfig = true
    shaders = false
  }

  // 真机界面核对（androidTest）用的样例：黄金课程和动作示意动图，取自 contracts/fixtures，只进测试包
  sourceSets {
    getByName("androidTest") {
      assets.srcDir("../../../contracts/fixtures")
    }
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

kotlin {
  jvmToolchain(17)
}

// 架构 6.3：本地 JVM 单测（macOS ARM64 / Linux）将 quickjs-kt-android 替换为 quickjs-kt-jvm，
// 使 ./gradlew testDebugUnitTest 直接用真实 QuickJS 跑通 contracts/fixtures/golden-player.json！
configurations.configureEach {
  if (name.endsWith("UnitTestRuntimeClasspath") || name.endsWith("UnitTestCompileClasspath")) {
    resolutionStrategy.dependencySubstitution {
      substitute(module("io.github.dokar3:quickjs-kt-android"))
        .using(module("io.github.dokar3:quickjs-kt-jvm:${libs.versions.quickjs.get()}"))
        .because("JVM unit tests run on host OS instead of Android ART")
    }
  }
}

// 强校验：确保 assets/player-runtime.js 与 packages/course-core/dist/player-runtime.js 字节完全一致（兼容 Gradle 9 Configuration Cache）
abstract class VerifyPlayerRuntimeAssetTask : DefaultTask() {
  @get:InputFile
  abstract val assetFile: RegularFileProperty

  @get:Optional
  @get:InputFile
  abstract val coreDistFile: RegularFileProperty

  @TaskAction
  fun verify() {
    val a = assetFile.get().asFile
    require(a.exists()) { "缺少 assets/player-runtime.js，请先执行 npm run build:player 并复制" }
    val c = coreDistFile.orNull?.asFile
    if (c != null && c.exists()) {
      fun sha256(f: java.io.File): String =
        MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }
      val hAsset = sha256(a)
      val hCore = sha256(c)
      require(hAsset == hCore) {
        "assets/player-runtime.js ($hAsset) 与 packages/course-core/dist/player-runtime.js ($hCore) 不一致！"
      }
    }
  }
}

val verifyPlayerRuntimeAsset = tasks.register<VerifyPlayerRuntimeAssetTask>("verifyPlayerRuntimeAsset") {
  assetFile.set(layout.projectDirectory.file("src/main/assets/player-runtime.js"))
  val core = rootProject.file("../../packages/course-core/dist/player-runtime.js")
  if (core.exists()) coreDistFile.set(core)
}

tasks.named("preBuild") {
  dependsOn(verifyPlayerRuntimeAsset)
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  // Core & Lifecycle
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.activity.compose)

  // Compose Material 3
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  debugImplementation(libs.androidx.compose.ui.tooling)
  debugImplementation(libs.androidx.compose.ui.test.manifest)

  // QuickJS 播放核心引擎（复用 @yangxia/course-core/player）
  implementation(libs.quickjs.kt)

  // 网络（三层明文私网防线 + JSON）
  implementation(libs.okhttp)
  implementation(libs.kotlinx.serialization.json)

  // 本地存储（Room 按 profileId 分区 + DataStore 设备偏好）
  implementation(libs.androidx.room.runtime)
  implementation(libs.androidx.room.ktx)
  ksp(libs.androidx.room.compiler)
  implementation(libs.androidx.datastore.preferences)

  // 动作示意 Lottie + 离线二维码扫码（零 GMS 依赖，适配 LineageOS Mi 6）
  implementation(libs.lottie.compose)
  implementation(libs.zxing.android.embedded)

  // JVM 单元测试
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)

  // 真机 Instrumented 测试
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)
  androidTestImplementation(libs.kotlinx.coroutines.test)
}
