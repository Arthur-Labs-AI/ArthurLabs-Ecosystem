'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Brand } from './Brand';

export function Navbar() {
  const menu = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const focusDestination = useRef(false);
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  function close(restoreFocus = false) {
    if (menu.current) menu.current.open = false;
    setOpen(false);
    if (restoreFocus) summary.current?.focus();
  }

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.open || menu.current.contains(event.target as Node)) return;
      const target = event.target as Element;
      const restoreFocus = menu.current.contains(document.activeElement)
        && !target.closest('a, button, input, textarea, select, [tabindex]');
      close(restoreFocus);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  useEffect(() => {
    if (!focusDestination.current) return;
    focusDestination.current = false;
    const heading = document.querySelector<HTMLElement>('main h1');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }, [pathname]);

  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    // Leave modified clicks/new-tab navigation to the browser.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    close();
    const url = new URL(event.currentTarget.href);
    if (url.pathname === pathname && url.hash) {
      const section = document.getElementById(url.hash.slice(1));
      const heading = section?.querySelector<HTMLElement>('h1, h2') ?? section;
      heading?.setAttribute('tabindex', '-1');
      heading?.focus({ preventScroll: true });
    } else if (url.pathname !== pathname) {
      focusDestination.current = true;
    } else {
      summary.current?.focus();
    }
  }

  return <header><a className="skip-link" href="#main">Skip to content</a><nav aria-label="Main navigation"><Brand/><div className="navlinks"><Link href="/suite">The Suite</Link><Link href="/#products">Products</Link><Link href="/hardware">Hardware</Link><Link href="/#philosophy">About</Link><Link href="/#footer" className="navpill">Our Vision ↗</Link></div>
    <details ref={menu} className="mobile-menu" onToggle={event => setOpen(event.currentTarget.open)} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
    }}>
      <summary ref={summary} aria-label="Open navigation" aria-expanded={open} aria-controls="mobile-navigation">Menu <span aria-hidden="true">{open ? '−' : '＋'}</span></summary>
      <div id="mobile-navigation"><Link href="/suite" onClick={navigate}>The Suite</Link><Link href="/studio" onClick={navigate}>Arthur Studio</Link><Link href="/nexus" onClick={navigate}>Nexus</Link><Link href="/sentry" onClick={navigate}>Sentry</Link><Link href="/hardware" onClick={navigate}>Hardware</Link><Link href="/#philosophy" onClick={navigate}>Our approach</Link></div>
    </details></nav></header>;
}
