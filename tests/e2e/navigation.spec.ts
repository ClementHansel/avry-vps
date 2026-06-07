/**
 * E2E Tests: Navigation
 *
 * Verifies:
 * - Sidebar links are visible and accessible
 * - Clicking links navigates to correct routes
 * - Active link is highlighted
 * - Sidebar can be collapsed/expanded
 * - Keyboard navigation works through sidebar items
 */
import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Mock API responses needed by views
    await page.route('/api/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    );

    // Authenticate
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

  test('sidebar navigation is visible with correct links', async ({ sidebar }) => {
    await expect(sidebar.nav).toBeVisible();
    await expect(sidebar.dashboardLink).toBeVisible();
    await expect(sidebar.containersLink).toBeVisible();
    await expect(sidebar.filesLink).toBeVisible();
    await expect(sidebar.domainsLink).toBeVisible();
    await expect(sidebar.jobsLink).toBeVisible();
  });

  test('sidebar has proper aria-label for accessibility', async ({ sidebar }) => {
    await expect(sidebar.nav).toHaveAttribute('aria-label', 'Main navigation');
  });

  test('navigates to Containers page', async ({ sidebar, page }) => {
    await sidebar.containersLink.click();
    await expect(page).toHaveURL('/containers');
    await expect(page.getByRole('heading', { name: 'Containers' })).toBeVisible();
  });

  test('navigates to Files page', async ({ sidebar, page }) => {
    await sidebar.filesLink.click();
    await expect(page).toHaveURL('/files');
    await expect(page.getByRole('heading', { name: 'File Browser' })).toBeVisible();
  });

  test('navigates to Domains page', async ({ sidebar, page }) => {
    await sidebar.domainsLink.click();
    await expect(page).toHaveURL('/domains');
  });

  test('navigates to Jobs page', async ({ sidebar, page }) => {
    await sidebar.jobsLink.click();
    await expect(page).toHaveURL('/jobs');
  });

  test('navigates back to Dashboard from another page', async ({ sidebar, page }) => {
    await sidebar.containersLink.click();
    await expect(page).toHaveURL('/containers');

    await sidebar.dashboardLink.click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('active nav link is visually distinguished', async ({ sidebar, page }) => {
    // Dashboard link should be active on /
    const dashLink = sidebar.dashboardLink;
    await expect(dashLink).toHaveClass(/router-link-exact-active|router-link-active/);

    // Navigate to containers
    await sidebar.containersLink.click();
    await page.waitForURL('/containers');

    // Containers link should now be active
    await expect(sidebar.containersLink).toHaveClass(/router-link-active/);
  });

  test('sidebar can be collapsed with toggle button', async ({ page }) => {
    const toggleButton = page.locator('button[aria-label="Toggle sidebar"]');
    await expect(toggleButton).toBeVisible();

    // Click to collapse
    await toggleButton.click();

    // Layout should have collapsed class
    const layout = page.locator('.layout');
    await expect(layout).toHaveClass(/sidebar-collapsed/);

    // Click again to expand
    await toggleButton.click();
    await expect(layout).not.toHaveClass(/sidebar-collapsed/);
  });

  test('navigation links are keyboard-accessible', async ({ sidebar, page }) => {
    // Focus the first nav link
    await sidebar.dashboardLink.focus();
    await expect(sidebar.dashboardLink).toBeFocused();

    // Tab to next link
    await page.keyboard.press('Tab');
    await expect(sidebar.containersLink).toBeFocused();

    // Press Enter to navigate
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/containers');
  });

  test('brand header is visible with correct title', async ({ page }) => {
    const brandTitle = page.locator('.brand-title');
    await expect(brandTitle).toBeVisible();
    await expect(brandTitle).toHaveText('Aivory VPS Panel');
  });
});
