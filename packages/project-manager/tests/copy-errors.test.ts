import { describe, expect, it } from 'vitest';
import { projectCopyFailure } from '../src/errors.js';

describe('project copy diagnostics', () => {
  it.each(['EACCES', 'EPERM'])(
    'reports an actionable permission path for %s without file contents',
    (code) => {
      const cause = Object.assign(new Error('sensitive file contents must not be exposed'), {
        code,
        path: '/source/private.py',
      });
      const failure = projectCopyFailure('PROJECT_COPY_FAILED', 'Import failed', cause);
      expect(failure.code).toBe('PROJECT_SOURCE_UNREADABLE');
      expect(failure.message).toContain('/source/private.py');
      expect(failure.message).toContain(code);
      expect(failure.message).not.toContain('sensitive file contents');
      expect(failure.cause).toBe(cause);
    },
  );
  it.each(['ENOSPC', 'EDQUOT'])(
    'maps %s to a storage message mentioning the Windows backing disk',
    (code) => {
      const failure = projectCopyFailure('PROJECT_UPDATE_FAILED', 'Update failed', { code });
      expect(failure.code).toBe('INSUFFICIENT_STORAGE');
      expect(failure.message).toContain('Windows drive');
    },
  );
  it('keeps unknown errors bounded to the existing message', () => {
    expect(
      projectCopyFailure('PROJECT_COPY_FAILED', 'Import failed', new Error('private')).message,
    ).toBe('Import failed');
  });
});
