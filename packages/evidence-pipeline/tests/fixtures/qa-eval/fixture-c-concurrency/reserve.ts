let seats = 1;
export function reserve(): boolean {
  if (seats <= 0) return false;
  seats -= 1;
  return true;
}
