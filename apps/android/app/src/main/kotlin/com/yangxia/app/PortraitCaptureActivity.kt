package com.yangxia.app

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * 竖屏扫码 Activity：覆盖 zxing-android-embedded 默认 CaptureActivity 的 sensorLandscape 锁横屏限制，
 * 使手机自然竖持即可扫描网页端 5 分钟配对二维码。
 */
class PortraitCaptureActivity : CaptureActivity()
