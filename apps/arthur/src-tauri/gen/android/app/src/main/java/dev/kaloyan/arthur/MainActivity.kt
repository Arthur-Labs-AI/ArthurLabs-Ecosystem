package dev.kaloyan.arthur

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Back at the root of the app (the web view has no history left, so the UI has no page, sheet or typing mode to close).
   *
   * Finishing the Activity here would tear the process down and end it through `exit()`; see `src/lifecycle.rs`.
   * Android's own convention for a root screen that is not a dialog is to send the task to the background, which keeps
   * the process and the web view alive, so coming back finds the same screen and state. The recents list and the system
   * can still finish the Activity; that path no longer aborts.
   */
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onBackPressed() {
    moveTaskToBack(true)
  }
}
