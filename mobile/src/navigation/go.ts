import { router, type Href } from 'expo-router';

// Where each screen sits. Back always goes one level up this tree, never to whatever screen
// happened to be open before:
//
//   Library ─┬─ Piece ─┬─ Score · Practice · Review · Choose bars · Fix a bar
//            ├─ Add music ── New score ── Reading
//            ├─ Tuner
//            └─ Settings ── Wood · Mic check
//
// The navigation stack is kept equal to the path from Library to the open screen, so the
// on-screen back link, Android's back button and the iOS swipe all land on the same parent. That
// means: a child is pushed, a sibling replaces the current screen, and a jump to another branch
// (a tab, a finished reading opening its score) resets the stack to the new path in one step.

export type PieceScreen = 'score' | 'practice' | 'review' | 'choose-bars' | 'fix-bar';

export type Place =
  | { kind: 'library' }
  | { kind: 'tuner' }
  | { kind: 'settings'; screen?: 'wood' | 'mic-check' }
  | { kind: 'add-music'; screen?: 'new-score' | 'reading' }
  | { kind: 'piece'; id: string; screen?: PieceScreen; params?: Record<string, string> };

// A react-navigation route as `reset` takes it.
interface RouteSpec {
  name: string;
  key?: string;
  params?: Record<string, string>;
  state?: { index: number; routes: RouteSpec[] };
}

interface RootNavigation {
  dispatch: (action: { type: string; payload?: object }) => void;
  getState: () => { routes: { name: string; key: string; params?: object }[] } | undefined;
}

let rootNavigation: RootNavigation | null = null;

// Set by the root layout from any of its screens: dispatching on a screen's navigation acts on
// the stack that holds it, which is the root stack.
export function setRootNavigation(navigation: RootNavigation): void {
  rootNavigation = navigation;
  if (__DEV__) (globalThis as { __rootNavigation?: RootNavigation }).__rootNavigation = navigation;
}

function nested(root: string, rootParams: Record<string, string> | undefined, screen: string | undefined, params?: Record<string, string>): RouteSpec {
  const base: RouteSpec = { name: 'index', params: rootParams };
  const routes = screen ? [base, { name: screen, params: { ...rootParams, ...params } }] : [base];
  return { name: root, params: rootParams, state: { index: routes.length - 1, routes } };
}

function branchFor(place: Place): RouteSpec | null {
  switch (place.kind) {
    case 'library':
      return null;
    case 'tuner':
      return { name: 'tuner' };
    case 'settings':
      return nested('settings', undefined, place.screen);
    case 'add-music':
      return nested('add-music', undefined, place.screen);
    case 'piece':
      return nested('piece/[id]', { id: place.id }, place.screen, place.params);
  }
}

// Jump anywhere: the stack becomes Library plus the path down to `place`. Library itself is kept
// (same route key), so it isn't rebuilt underneath.
export function go(place: Place): void {
  const branch = branchFor(place);
  if (!rootNavigation) {
    router.replace(hrefFor(place));
    return;
  }
  const current = rootNavigation.getState()?.routes ?? [];
  const library = current[0]?.name === 'index' ? { name: 'index', key: current[0].key, params: current[0].params as Record<string, string> | undefined } : { name: 'index' };
  // Already at this branch's root (say, Settings while on Settings): nothing to do.
  if (branch && current.length === 2 && current[1].name === branch.name && !branch.state?.routes[1] && sameParams(current[1].params, branch.params)) {
    const nestedState = (current[1] as { state?: { routes: unknown[] } }).state;
    if (!nestedState || nestedState.routes.length === 1) return;
  }
  if (!branch && current.length === 1) return;
  const routes: RouteSpec[] = branch ? [library, branch] : [library];
  rootNavigation.dispatch({ type: 'RESET', payload: { index: routes.length - 1, routes } });
}

function sameParams(a: object | undefined, b: object | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

// Up one level: back when the stack holds the parent (it always should), else straight to it.
export function goUp(parent: Place): void {
  if (router.canGoBack()) router.back();
  else go(parent);
}

// Another screen of the same piece (Score → Practice, Review → Practice again): replaces the
// current one, so back from it is still the piece.
export function goSibling(id: string, screen: PieceScreen, params?: Record<string, string>): void {
  router.replace(hrefFor({ kind: 'piece', id, screen, params }));
}

// A screen one level down from where you are now.
export function goChild(place: Place): void {
  router.push(hrefFor(place));
}

export function hrefFor(place: Place): Href {
  return pathFor(place) as Href;
}

function pathFor(place: Place): string {
  switch (place.kind) {
    case 'library':
      return '/';
    case 'tuner':
      return '/tuner';
    case 'settings':
      return place.screen ? `/settings/${place.screen}` : '/settings';
    case 'add-music':
      return place.screen ? `/add-music/${place.screen}` : '/add-music';
    case 'piece': {
      const path = `/piece/${encodeURIComponent(place.id)}${place.screen ? `/${place.screen}` : ''}`;
      const query = place.params ? new URLSearchParams(place.params).toString() : '';
      return query ? `${path}?${query}` : path;
    }
  }
}
