package com.jeck.gitkeymaster

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class BiometricAuthArgs {
  var keyRef: String = ""
  var method: String = "fingerprint"
  var title: String = "使用指纹解锁"
  var subtitle: String = ""
}

/** 系统 BiometricPrompt + Android Keystore，只走指纹。 */
@TauriPlugin
class BiometricPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun status(invoke: Invoke) {
    val bm = BiometricManager.from(activity)
    val strongOk = bm.canAuthenticate(Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    val hasFp = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
    val fingerprint = hasFp && strongOk
    val ret = JSObject()
    ret.put("available", fingerprint || strongOk)
    ret.put("strong", strongOk)
    ret.put("fingerprint", fingerprint || strongOk)
    ret.put("face", false)
    invoke.resolve(ret)
  }

  @Command
  fun enroll(invoke: Invoke) {
    val args = invoke.parseArgs(BiometricAuthArgs::class.java)
    val keyRef = sanitize(args.keyRef)
    if (keyRef.isEmpty()) {
      invoke.reject("BIOMETRIC_INVALID:密钥引用无效")
      return
    }
    activity.runOnUiThread {
      try {
        deleteLocal(keyRef)
        createKey(keyRef)
        val kek = ByteArray(32)
        java.security.SecureRandom().nextBytes(kek)
        prompt(invoke, args.title, args.subtitle, encrypt = true, keyRef = keyRef) { cipher ->
          persistWrapped(keyRef, wrapKek(keyRef, kek, cipher))
          val ret = JSObject()
          ret.put("key", Base64.encodeToString(kek, Base64.NO_WRAP))
          invoke.resolve(ret)
        }
      } catch (e: Exception) {
        deleteLocal(keyRef)
        invoke.reject(mapError(e))
      }
    }
  }

  @Command
  fun derive(invoke: Invoke) {
    val args = invoke.parseArgs(BiometricAuthArgs::class.java)
    val keyRef = sanitize(args.keyRef)
    val stored = loadWrapped(keyRef)
    if (keyRef.isEmpty() || stored == null) {
      invoke.reject("BIOMETRIC_STALE")
      return
    }
    activity.runOnUiThread {
      try {
        prompt(invoke, args.title, args.subtitle, encrypt = false, keyRef = keyRef, iv = stored.iv) { cipher ->
          val kek = unwrapKek(keyRef, stored, cipher)
          val ret = JSObject()
          ret.put("key", Base64.encodeToString(kek, Base64.NO_WRAP))
          invoke.resolve(ret)
        }
      } catch (e: KeyPermanentlyInvalidatedException) {
        deleteLocal(keyRef)
        invoke.reject("BIOMETRIC_STALE")
      } catch (e: Exception) {
        invoke.reject(mapError(e))
      }
    }
  }

  @Command
  fun verify(invoke: Invoke) {
    val args = invoke.parseArgs(BiometricAuthArgs::class.java)
    activity.runOnUiThread {
      try {
        prompt(invoke, args.title, args.subtitle, encrypt = false, keyRef = "") {
          invoke.resolve()
        }
      } catch (e: Exception) {
        invoke.reject(mapError(e))
      }
    }
  }

  @Command
  fun remove(invoke: Invoke) {
    deleteLocal(sanitize(invoke.parseArgs(BiometricAuthArgs::class.java).keyRef))
    invoke.resolve()
  }

  private fun prompt(
    invoke: Invoke,
    title: String,
    subtitle: String,
    encrypt: Boolean,
    keyRef: String,
    iv: ByteArray? = null,
    onOk: (Cipher?) -> Unit,
  ) {
    val host = activity as? FragmentActivity
    if (host == null) {
      invoke.reject("BIOMETRIC_INVALID:当前界面无法弹出系统验证")
      return
    }
    val cipher = if (keyRef.isNotEmpty()) readyCipher(keyRef, encrypt, iv) else null
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle(title.ifBlank { "使用指纹解锁" })
      .setSubtitle(subtitle)
      .setNegativeButtonText("使用密码")
      .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG)
      .build()
    val prompt = BiometricPrompt(
      host,
      ContextCompat.getMainExecutor(activity),
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          try {
            onOk(result.cryptoObject?.cipher ?: cipher)
          } catch (e: KeyPermanentlyInvalidatedException) {
            deleteLocal(keyRef)
            invoke.reject("BIOMETRIC_STALE")
          } catch (e: Exception) {
            invoke.reject(mapError(e))
          }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          invoke.reject(
            when (errorCode) {
              BiometricPrompt.ERROR_CANCELED,
              BiometricPrompt.ERROR_USER_CANCELED,
              BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "BIOMETRIC_CANCELLED"
              BiometricPrompt.ERROR_LOCKOUT,
              BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
                "BIOMETRIC_INVALID:指纹已锁定，请稍后再试或改用访问密码"
              BiometricPrompt.ERROR_HW_UNAVAILABLE,
              BiometricPrompt.ERROR_HW_NOT_PRESENT,
              BiometricPrompt.ERROR_NO_BIOMETRICS ->
                "BIOMETRIC_INVALID:本机未录入可用的指纹"
              else -> "BIOMETRIC_INVALID:${errString}"
            },
          )
        }
      },
    )
    if (cipher != null) {
      prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    } else {
      prompt.authenticate(info)
    }
  }

  private fun sanitize(raw: String): String {
    return raw.lowercase().replace(Regex("[^a-z0-9._-]"), "_").take(80)
  }

  private fun aliasOf(keyRef: String) = "gam.bio.$keyRef"

  private fun prefs() = activity.getSharedPreferences("gam_biometric", Context.MODE_PRIVATE)

  private data class Wrapped(val iv: ByteArray, val blob: ByteArray)

  private fun persistWrapped(keyRef: String, packed: ByteArray) {
    prefs().edit()
      .putString("$keyRef.blob", Base64.encodeToString(packed, Base64.NO_WRAP))
      .putBoolean("$keyRef.strong", true)
      .putString("$keyRef.method", "fingerprint")
      .apply()
  }

  private fun loadWrapped(keyRef: String): Wrapped? {
    val raw = prefs().getString("$keyRef.blob", null) ?: return null
    val packed = Base64.decode(raw, Base64.NO_WRAP)
    if (packed.size <= 12) return null
    return Wrapped(iv = packed.copyOfRange(0, 12), blob = packed.copyOfRange(12, packed.size))
  }

  private fun deleteLocal(keyRef: String) {
    if (keyRef.isEmpty()) return
    prefs().edit()
      .remove("$keyRef.blob")
      .remove("$keyRef.strong")
      .remove("$keyRef.method")
      .remove("$keyRef.face")
      .apply()
    try {
      val ks = KeyStore.getInstance(ANDROID_KEYSTORE)
      ks.load(null)
      ks.deleteEntry(aliasOf(keyRef))
    } catch (_: Exception) {
    }
  }

  private fun createKey(keyRef: String) {
    val purpose = KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
    val builder = KeyGenParameterSpec.Builder(aliasOf(keyRef), purpose)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    gen.init(builder.build())
    gen.generateKey()
  }

  private fun secretKey(keyRef: String): SecretKey {
    val ks = KeyStore.getInstance(ANDROID_KEYSTORE)
    ks.load(null)
    return (ks.getEntry(aliasOf(keyRef), null) as KeyStore.SecretKeyEntry).secretKey
  }

  private fun readyCipher(keyRef: String, encrypt: Boolean, iv: ByteArray?): Cipher {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    if (encrypt) {
      cipher.init(Cipher.ENCRYPT_MODE, secretKey(keyRef))
    } else {
      cipher.init(Cipher.DECRYPT_MODE, secretKey(keyRef), GCMParameterSpec(128, iv))
    }
    return cipher
  }

  private fun wrapKek(keyRef: String, kek: ByteArray, cryptoCipher: Cipher?): ByteArray {
    val cipher = cryptoCipher ?: readyCipher(keyRef, encrypt = true, iv = null)
    val blob = cipher.doFinal(kek)
    return cipher.iv + blob
  }

  private fun unwrapKek(keyRef: String, stored: Wrapped, cryptoCipher: Cipher?): ByteArray {
    val cipher = cryptoCipher ?: readyCipher(keyRef, encrypt = false, iv = stored.iv)
    return cipher.doFinal(stored.blob)
  }

  private fun mapError(e: Exception): String {
    val msg = e.message.orEmpty()
    return when {
      e is KeyPermanentlyInvalidatedException -> "BIOMETRIC_STALE"
      msg.startsWith("BIOMETRIC_") -> msg
      msg.isBlank() -> "BIOMETRIC_INVALID:指纹验证失败"
      else -> "BIOMETRIC_INVALID:$msg"
    }
  }

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}
