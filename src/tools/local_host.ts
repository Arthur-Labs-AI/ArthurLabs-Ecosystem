/**
 * SC-04 LocalCapabilityHost (spec section 4).
 *
 * Dependency bundle only: the four typed capability adapters behind
 * the SC-04 tool packs. It has NO execute/run/dispatch method (that
 * would be a second ToolRegistry and is forbidden by SC04-F01). All
 * OS interaction flows: ToolRegistry -> SC-02 auth -> SC-03 durable
 * execution -> ToolExecutionService -> typed adapter -> OS API.
 */

import type { LocalApplicationAdapter } from "./adapters/local_applications";
import type { LocalBrowserAdapter } from "./adapters/local_browser";
import type { LocalFilesystemAdapter } from "./adapters/local_filesystem";
import type { LocalSystemAdapter } from "./adapters/local_system";

export interface LocalCapabilityHost {
  system: LocalSystemAdapter;
  filesystem: LocalFilesystemAdapter;
  applications: LocalApplicationAdapter;
  browser: LocalBrowserAdapter;
}
