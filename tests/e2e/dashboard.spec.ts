/**
 * E2E Tests: Dashboard View
 *
 * Verifies:
 * - Dashboard renders after login
 * - Service list is visible (or empty state when no containers)
 * - Resource widget is displayed
 * - Summary cards show container, project, alert counts
 * - Auto-refresh indicator is present
 */
import { test, expect } from './fixtures';

test.describe('Dashboard View', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the API responses for a consistent test environment
    await page.route('/api/containers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'abc123',
            name: 'avry-backend',
            image: 'avry-backend:latest',
            port: 8000,
            status: 'running',
            health: 'healthy',
            uptime: 86400,
          },
          {
            id: 'def456',
            name: 'avry-console',
            image: 'avry-console:latest',
            port: 3000,
            status: 'running',
            health: 'healthy',
            uptime: 3600,
          },
        ]),
      })
    );

    await page.route('/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'p1', name: 'aivery-prod', healthStatus: 'all services up', containerCount: 2 },
        ]),
      })
    );

    await page.route('/api/jobs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    );

    await page.route('/api/alerts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    );

    await page.route('/api/resources/system', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cpu: { usagePercent: 42 },
          memory: { usedGB: 3.2, totalGB: 8 },
          disk: { usedGB: 45, totalGB: 100, usagePercent: 45 },
          network: { inBytesPerSec: 1024, outBytesPerSec: 2048 },
        }),
      })
    );

    // Authenticate via login
    await page.goto('/login');
    await page.route('/api/auth/login', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'test-token-123',
          session: { id: 's1', username: 'admin', createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() },
        }),
      })
    );
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('admin123');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('/');
  });

  test('displays dashboard heading after login', async ({ dashboardPage }) => {
    await expect(dashboardPage.heading).toBeVisible();
  });

  test('shows service list with container names and health', async ({ dashboardPage, page }) => {
    await expect(dashboardPage.serviceSection).toBeVisible();
    await expect(dashboardPage.serviceTable).toBeVisible();

    // Verify container names appear
    await expect(page.locator('.table-row')).toHaveCount(2);
    await expect(page.locator('.table-row').first()).toContainText('avry-backend');
    await expect(page.locator('.table-row').last()).toContainText('avry-console');
  });

  test('shows empty state when no containers are running', async ({ page }) => {
    // Override containers route to return empty array
    await page.route('/api/containers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    );

    // Reload to trigger fresh data fetch
    await page.reload();

    const emptyState = page.locator('.empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('No containers running');
  });

  test('resource widget is visible on dashboard', async ({ dashboardPage }) => {
    await expect(dashboardPage.resourceWidget).toBeVisible();
  });

  test('summary cards show counts', async ({ dashboardPage }) => {
    await expect(dashboardPage.summaryCards).toHaveCount(4);

    // Containers card
    const containersCard = dashboardPage.summaryCards.filter({ hasText: 'Containers' });
    await expect(containersCard).toContainText('2 running');

    // Projects card
    const projectsCard = dashboardPage.summaryCards.filter({ hasText: 'Projects' });
    await expect(projectsCard).toContainText('1');
  });

  test('auto-refresh indicator is visible', async ({ dashboardPage }) => {
    await expect(dashboardPage.autoRefreshLabel).toBeVisible();
    await expect(dashboardPage.autoRefreshLabel).toContainText('15s');
  });

  test('dashboard has proper heading hierarchy', async ({ page }) => {
    // h2 for main heading
    const h2 = page.locator('h2', { hasText: 'Dashboard' });
    await expect(h2).toBeVisible();

    // h3 for section headings
    const sectionHeadings = page.locator('h3');
    const count = await sectionHeadings.count();
    expect(count).toBeGreaterThan(0);
  });
});
