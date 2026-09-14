/**
 * HR-02.5D1: trusted installer registry.
 *
 * In-process registration by trusted code only: no dynamic module
 * loading from filesystem paths, no downloaded plugin execution, no
 * model-controlled registration. Duplicate ids are rejected; unknown
 * ids fail clearly at resolve time.
 */

import { ArthurError } from '../../core/errors/errors';
import type { ModelInstallerId } from './contracts';
import type { ModelInstaller } from './install_contracts';

export class ModelInstallerRegistry {
  private readonly installers = new Map<ModelInstallerId, ModelInstaller>();

  register(installer: ModelInstaller): void {
    if (installer === null || typeof installer !== 'object') {
      throw new ArthurError('INVALID_CONFIG', 'model installer registration must be an object');
    }
    if (typeof installer.install !== 'function') {
      throw new ArthurError('INVALID_CONFIG', 'model installer must implement install()');
    }
    if (this.installers.has(installer.id)) {
      throw new ArthurError('INVALID_CONFIG', 'duplicate model installer id ' + JSON.stringify(installer.id));
    }
    this.installers.set(installer.id, installer);
  }

  resolve(id: ModelInstallerId): ModelInstaller {
    const hit = this.installers.get(id);
    if (!hit) {
      throw new ArthurError('INVALID_CONFIG', 'unknown model installer id ' + JSON.stringify(id));
    }
    return hit;
  }

  has(id: ModelInstallerId): boolean {
    return this.installers.has(id);
  }

  ids(): ModelInstallerId[] {
    return [...this.installers.keys()];
  }
}
