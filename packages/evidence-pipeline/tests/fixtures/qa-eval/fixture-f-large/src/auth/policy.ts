export function authorize(role: string): boolean {
  return role === 'customer' || role === 'admin';
}

export function requireAdmin(role: string): void {
  if (role !== 'admin') throw new Error('forbidden');
}
