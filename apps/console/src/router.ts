import { useCallback, useEffect, useState } from 'react';

/**
 * The two roles the site serves: the public landing page and the working
 * console. Path-based so a deep link survives a reload (nginx already falls
 * back to `index.html`), with no router dependency for two routes.
 */
export type Route = 'landing' | 'console';

const CONSOLE_PATH = '/console';

function routeFromPath(pathname: string): Route {
  return pathname === CONSOLE_PATH || pathname.startsWith(`${CONSOLE_PATH}/`)
    ? 'console'
    : 'landing';
}

function pathFor(route: Route): string {
  return route === 'console' ? CONSOLE_PATH : '/';
}

/** Current route plus a navigate function that keeps the URL bar in step. */
export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = pathFor(next);
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
    window.scrollTo({ top: 0 });
  }, []);

  return [route, navigate];
}
