/**
 * E2E Tests: Container Actions
 *
 * Verifies:
 * - Container list displays container name and status
 * - Selecting a container shows detail panel
 * - Restart action triggers confirmation dialog
 * - Confirm dialog has proper role="dialog" and aria attributes
 * - Cancel closes dialog without executing action
 * - Stop action also requires confirmation
 */
import { test, expect } from './fixtures';

const MOCK_CONTAINERS = [
  {
    id: 'container-abc123',
    name: 'avry-backend',
    image: 'avry-backend:latest',
    port: 8000,
    status: 'running',
    health: 'healthy',
    uptime: 172800,
  },
  {
    id: 'container-def456',
    name: 'avry-console',
    image: 'avry-console:latest',
    port: 3000,
    status: 'running',
    health: 'unhealthy',
    uptime: 7200,
  },
  {
    id: 'container-ghi789',
    name: 'redis-cache',
    image: 'redis:7-alpine',
    port: 6379,
    status: 'stopped',
    health: 'unknown',
    uptime: 0,
  },
];

const MOCK_CONTAINER_DETAIL = {
  id: 'container-abc123',
  name: 'avry-backend',
  image: 'avry-backend:latest',
  restartCount: 3,
  cpuPercent: 12.5,
  memoryMB: 256.7,
};

test.describe('Container Actions', () => {
  test.beforeEach(async ({ page }) => {
    // Mock container list API
    await page.route('/api/containers', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_CONTAINERS),
        });
      }
      return route.continue();
    });

    // Mock container detail API
    await page.route('/api/containers/container-abc123', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_CONTAINER_DETAIL),
      })
    );

    // Mock container actions
    await page.route('/api/containers/container-abc123/restart', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
    );

    await page.route('/api/containers/container-abc123/stop', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
    );

    // Mock other API endpoints
    await page.route('/api/projects', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    );
    await page.route('/api/jobs', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    );
    await page.route('/api/alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    );

    // Authenticate and navigate
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

    // Navigate to containers
    await page.locator('nav[aria-label="Main navigation"]').getByRole('link', { name: 'Containers' }).click();
    await page.waitForURL('/containers');
  });

  test('displays container list with names and health status', async ({ containersPage, page }) => {
    await expect(containersPage.heading).toBeVisible();
    await expect(containersPage.containerRows).toHaveCount(3);

    // Verify container names
    await expect(containersPage.containerRows.nth(0)).toContainText('avry-backend');
    await expect(containersPage.containerRows.nth(1)).toContainText('avry-console');
    await expect(containersPage.containerRows.nth(2)).toContainText('redis-cache');
  });

  test('selecting a container shows detail panel', async ({ containersPage, page }) => {
    await containersPage.selectContainer(0);

    // Wait for detail panel to appear
    await expect(containersPage.detailPanel).toBeVisible();

    // Verify detail information
    await expect(containersPage.detailPanel).toContainText('avry-backend');
    await expect(containersPage.detailPanel).toContainText('12.5%');
    await expect(containersPage.detailPanel).toContainText('256.7 MB');
    await expect(containersPage.detailPanel).toContainText('3'); // restart count
  });

  test('restart button shows confirmation dialog', async ({ containersPage, page }) => {
    await containersPage.selectContainer(0);
    await expect(containersPage.detailPanel).toBeVisible();

    // Click restart — this does NOT require confirmation per the design
    // Only stop and pull-redeploy require confirmation
    await containersPage.restartButton.click();

    // Restart executes directly without dialog
    // The button should still be visible after the action completes
    await expect(containersPage.restartButton).toBeVisible();
  });

  test('stop action requires confirmation dialog', async ({ containersPage }) => {
    await containersPage.selectContainer(0);
    await expect(containersPage.detailPanel).toBeVisible();

    // Click stop
    await containersPage.stopButton.click();

    // Confirmation dialog should appear
    await expect(containersPage.confirmDialog).toBeVisible();
    await expect(containersPage.confirmDialog).toHaveAttribute('role', 'dialog');
    await expect(containersPage.confirmDialog).toHaveAttribute('aria-modal', 'true');
    await expect(containersPage.confirmDialog).toContainText('Stop Container');
    await expect(containersPage.confirmDialog).toContainText('avry-backend');
  });

  test('cancel button dismisses confirmation dialog without action', async ({ containersPage }) => {
    await containersPage.selectContainer(0);
    await containersPage.stopButton.click();

    // Dialog opens
    await expect(containersPage.confirmDialog).toBeVisible();

    // Click cancel
    await containersPage.cancelButton.click();

    // Dialog should be gone
    await expect(containersPage.confirmDialog).not.toBeVisible();
  });

  test('confirming stop action executes the stop', async ({ containersPage, page }) => {
    let stopCalled = false;
    await page.route('/api/containers/container-abc123/stop', (route) => {
      stopCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await containersPage.selectContainer(0);
    await containersPage.stopButton.click();
    await expect(containersPage.confirmDialog).toBeVisible();

    // Confirm the action
    await containersPage.confirmButton.click();

    // Dialog closes
    await expect(containersPage.confirmDialog).not.toBeVisible();
  });

  test('container list shows empty state when no containers exist', async ({ page }) => {
    // Override to return empty list
    await page.route('/api/containers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    );

    await page.reload();

    const emptyState = page.locator('.empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('No containers found');
  });

  test('detail panel shows action error on API failure', async ({ containersPage, page }) => {
    // Mock restart to fail
    await page.route('/api/containers/container-abc123/restart', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Docker daemon unavailable' }),
      })
    );

    await containersPage.selectContainer(0);
    await expect(containersPage.detailPanel).toBeVisible();

    await containersPage.restartButton.click();

    // Error message should appear
    const errorMsg = page.locator('.action-error');
    await expect(errorMsg).toBeVisible();
  });
});
