package dev.kaloyan.arthur

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
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
class SecretIdArgs {
    lateinit var id: String
}

@InvokeArg
class PutSecretArgs {
    lateinit var id: String
    lateinit var value: String
}

/**
 * Provider credentials, encrypted with a key that never leaves the Android Keystore.
 *
 * - AES-256-GCM, a fresh random IV per write. The key is generated inside the Keystore (hardware-backed where the device has it)
 *   and is not extractable, so neither this app's code nor a copy of its data directory can recover it.
 * - Only the ciphertext (IV + data, Base64) is stored, in app-private preferences that are excluded from every backup.
 * - These commands are reachable from the Rust `AndroidKeystoreStore` only. They are not Tauri commands, so the webview cannot
 *   call them: there is no way for React to read a credential back.
 * - Nothing here logs an id, a value or a ciphertext.
 */
@TauriPlugin
class SecretsPlugin(activity: Activity) : Plugin(activity) {
    private val prefs = activity.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Command
    fun putSecret(invoke: Invoke) {
        val args = invoke.parseArgs(PutSecretArgs::class.java)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = cipher.iv + cipher.doFinal(args.value.toByteArray(Charsets.UTF_8))
            // commit(), not apply(): the credential must be durable before Rust reports success.
            if (!prefs.edit().putString(entry(args.id), Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
                invoke.reject("secret_store_failed", "secret_store_failed")
                return
            }
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject("secret_store_failed", "secret_store_failed")
        }
    }

    @Command
    fun hasSecret(invoke: Invoke) {
        val args = invoke.parseArgs(SecretIdArgs::class.java)
        // "Present" means it can actually be decrypted: a credential sealed by a Keystore key that no longer exists is not one.
        val result = JSObject()
        result.put("present", open(args.id) != null)
        invoke.resolve(result)
    }

    @Command
    fun readSecret(invoke: Invoke) {
        val args = invoke.parseArgs(SecretIdArgs::class.java)
        val result = JSObject()
        result.put("value", open(args.id))
        invoke.resolve(result)
    }

    @Command
    fun deleteSecret(invoke: Invoke) {
        val args = invoke.parseArgs(SecretIdArgs::class.java)
        if (prefs.edit().remove(entry(args.id)).commit()) invoke.resolve(JSObject()) else invoke.reject("secret_store_failed", "secret_store_failed")
    }

    private fun open(id: String): String? {
        val stored = prefs.getString(entry(id), null) ?: return null
        return try {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
            String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun entry(id: String) = "secret.$id"

    private companion object {
        const val PREFS = "arthur_secrets"
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "arthur.provider-secrets.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
