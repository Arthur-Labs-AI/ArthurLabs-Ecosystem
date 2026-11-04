export function handle(path: string, isAdmin: boolean): string {
  if (path === '/admin/users') {
    if (!isAdmin) throw new Error('forbidden');
    return 'users';
  }
  if (path === '/admin/export') {
    return 'export';
  }
  return 'ok';
}
