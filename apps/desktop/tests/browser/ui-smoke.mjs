/* global process, DOMMatrix, getComputedStyle, setTimeout, document, localStorage, window, innerWidth, console */
// Run with Vite on :5174 and Playwright available (or SENTRY_PLAYWRIGHT_MODULE
// pointing at its package). SENTRY_BROWSER_EXECUTABLE optionally selects Chrome.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installUiFixture } from './ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SENTRY_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SENTRY_BROWSER_EXECUTABLE
    ? { executablePath: process.env.SENTRY_BROWSER_EXECUTABLE }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const base = process.env.SENTRY_UI_URL ?? 'http://localhost:5174/';
const output = resolve(process.env.SENTRY_UI_OUTPUT ?? '.tmp-sentry-test-fixtures/ui-review');
await mkdir(output, { recursive: true });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(installUiFixture);
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const viewport = () => page.locator('.react-flow__viewport').getAttribute('style');
const position = (id) =>
  node(id).evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
const waitFor = async (fn, label) => {
  const deadline = Date.now() + 10000;
  while (!(await fn())) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 30));
  }
};
const graphReady = async () => {
  await node('agent-stack_opencode_main').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.react-flow__node')].every(
      (n) => getComputedStyle(n).opacity === '1',
    ),
  );
  // Wait for initial fit animation through observable transform stability.
  let last;
  await waitFor(async () => {
    const current = await viewport();
    const stable = current === last;
    last = current;
    return stable;
  }, 'viewport settles');
};
const capture = (name) =>
  page.screenshot({ path: resolve(output, name + '.png'), fullPage: true, animations: 'disabled' });
const edgePath = () =>
  page.locator('.react-flow__edge').last().locator('.react-flow__edge-path').getAttribute('d');
try {
  await page.goto(base + '#/runs/ui-run');
  await graphReady();
  const ids = [
    'project',
    'revision',
    'snapshot',
    'agent-stack_opencode_main',
    'agent-stack_deepseek_main',
    'agent-stack_glm_main',
  ];
  const positions = await Promise.all(ids.map(position));
  assert.equal(
    new Set(positions.map((p) => `${p.x},${p.y}`)).size,
    ids.length,
    'node entrance motion must preserve React Flow translations',
  );
  const agent = 'agent-stack_glm_main';
  const original = await position(agent);
  const originalPath = await edgePath();
  const box = await node(agent).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 65, { steps: 16 });
  assert.notEqual(await edgePath(), originalPath, 'edge follows node while pointer is held');
  await page.mouse.up();
  const moved = await position(agent);
  assert.notDeepEqual(moved, original, 'drag changes flow position');
  assert.notEqual(await edgePath(), originalPath, 'edge geometry follows dragged node');
  await waitFor(
    async () =>
      Math.abs(
        (
          await page.evaluate(() =>
            JSON.parse(localStorage.getItem('sentry:run-layout:canvas:ui-run') ?? '{}'),
          )
        )[agent]?.x - moved.x,
      ) < 0.001,
    'drag is saved',
  );
  await page.evaluate(() => window.__ui.setStatus(2, 'failed'));
  await node(agent).locator('.state-failed').waitFor();
  assert.deepEqual(await position(agent), moved, 'telemetry refresh preserves drag');
  const oldViewport = await viewport();
  await page.getByRole('button', { name: 'Zoom in (+)', exact: true }).click();
  await waitFor(async () => (await viewport()) !== oldViewport, 'zoom works');
  const canvasBox = await page.locator('.canvas-host').boundingBox();
  const beforePan = await viewport();
  await page.mouse.move(canvasBox.x + 25, canvasBox.y + 70);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 65, canvasBox.y + 110, { steps: 10 });
  await page.mouse.up();
  assert.notEqual(await viewport(), beforePan, 'dragging the pane pans the viewport');
  assert.deepEqual(await position(agent), moved, 'panning does not change node positions');
  const beforeWheel = await viewport();
  await page.mouse.wheel(0, -120);
  await waitFor(async () => (await viewport()) !== beforeWheel, 'scroll wheel zooms the graph');
  await page
    .getByRole('button', { name: 'Fit view (F). Keeps your node layout.', exact: true })
    .click();
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.locator('.react-flow__edge').count(), 5, 'edges survive resize');
  assert.deepEqual(await position(agent), moved, 'resize preserves drag');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(base + '#/');
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  await capture('dashboard');
  await page.goto(base + '#/runs/ui-run');
  await graphReady();
  assert.deepEqual(await position(agent), moved, 'switching views restores layout');
  await capture('graph');
  await page.getByRole('button', { name: 'Reset layout to canonical positions' }).click();
  await waitFor(
    async () => JSON.stringify(await position(agent)) === JSON.stringify(original),
    'reset restores canonical layout',
  );
  // Corrupt presentation storage must never break the execution graph.
  await page.evaluate(() =>
    localStorage.setItem(
      'sentry:run-layout:canvas:ui-run',
      JSON.stringify({ project: { x: 'bad', y: null } }),
    ),
  );
  await page.reload();
  await graphReady();
  assert.deepEqual(await position('project'), positions[0]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('animateMotion') === null);
  assert.equal(
    await page
      .locator('.flow-node.state-running')
      .first()
      .evaluate((el) => getComputedStyle(el, '::before').animationName),
    'none',
    'reduced motion disables pseudo-element animation',
  );
  await page.getByRole('button', { name: 'Zoom in (+)', exact: true }).click();
  const afterZoom = await viewport();
  await page.keyboard.press('Tab');
  assert.equal(await viewport(), afterZoom, 'reduced-motion zoom is immediate');
  await capture('graph-reduced-motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const [route, heading, name] of [
    ['/projects', 'Projects', 'projects'],
    ['/projects/ui-project', 'Sentry workspace', 'project'],
    ['/runs', 'Runs', 'runs'],
    ['/issues', 'Issues', 'issues'],
    ['/issues/ui-issue', 'Session refresh lacks expiry validation', 'issue'],
    ['/history', 'History', 'history'],
    ['/retests/ui-retest', 'Retest', 'retest'],
    ['/environment', 'Environment', 'environment'],
    ['/settings', 'Settings', 'settings'],
    ['/settings/providers', 'Providers', 'providers'],
    ['/settings/runtime', 'WSL runtime', 'runtime'],
  ]) {
    await page.goto(base + '#' + route);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    if (name === 'retest') {
      await graphReady();
      const assessmentBox = await node('retest-assessment').boundingBox();
      for (const id of [
        'agent-stack_opencode_main',
        'agent-stack_deepseek_main',
        'agent-stack_glm_main',
      ]) {
        const agentBox = await node(id).boundingBox();
        assert.ok(
          assessmentBox.y > agentBox.y + agentBox.height,
          'retest assessment does not overlap agents',
        );
      }
      await page.locator('.canvas-host').scrollIntoViewIfNeeded();
    }
    await capture(name);
  }
  await page.goto(base + '#/');
  const paletteButton = page.getByRole('button', { name: 'Open command palette (Ctrl+K)' });
  await paletteButton.click();
  const input = page.getByRole('combobox');
  await input.fill('settings');
  await page.keyboard.press('ArrowDown');
  await capture('command-palette');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Escape closes palette');
  assert.equal(
    await paletteButton.evaluate((el) => document.activeElement === el),
    true,
    'palette returns focus',
  );
  await page.goto(base + '?state=empty#/projects');
  await page.getByText('No projects yet', { exact: true }).waitFor();
  await capture('projects-empty');
  await page.goto(base + '?state=empty#/');
  await page.getByText('No QA running right now.', { exact: true }).waitFor();
  await capture('dashboard-empty');
  await page.goto(base + '?state=loading#/projects');
  await page.getByText('Loading projects…', { exact: true }).waitFor();
  await capture('projects-loading');
  await page.goto(base + '?state=offline#/environment');
  await page.getByText('Sentry Runtime Offline.', { exact: true }).waitFor();
  await capture('environment-offline');
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(base + '#/runs/ui-run');
  await graphReady();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'compact workspace has no horizontal page overflow',
  );
  assert.equal(
    await page.locator('.sidebar .brand-text').isVisible(),
    false,
    'compact sidebar hides overflowing brand text',
  );
  await page.locator('.canvas-host').scrollIntoViewIfNeeded();
  await page
    .getByRole('button', { name: 'Fit view (F). Keeps your node layout.', exact: true })
    .click();
  await graphReady();
  await capture('graph-compact');
  assert.deepEqual(errors, [], 'no browser exceptions across all routes');
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        screenshots: output,
        routes: 13,
        checks: [
          'unique positions',
          'drag',
          'dynamic edges',
          'telemetry',
          'zoom',
          'pan',
          'resize',
          'view switch',
          'reset',
          'invalid storage',
          'reduced motion',
          'palette keyboard/focus',
          'compact layout',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  await capture('failure');
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
