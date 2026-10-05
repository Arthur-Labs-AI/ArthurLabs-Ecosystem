import { useBackLayer } from "./back-stack";
import { useMobileNav } from "./mobile-nav";

/** One history entry for one pushed page, so the system Back gesture closes the page instead of leaving the app. */
export function MobileBackLayer() {
  const { closePage } = useMobileNav();
  useBackLayer(true, closePage);
  return null;
}
